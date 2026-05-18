"""HTTP API справочника правил: CRUD, версии DSL, эталоны, конфликты классификации, семантический порог."""

from __future__ import annotations

import os
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..application.dto.rules_catalog import (
    CloneRuleRequest,
    CreateRuleResponse,
    ReferenceExampleBulkIn,
    ReferenceExampleBulkOut,
    RuleConflictsResponse,
    RuleListItem,
    ValidateRequest,
    ValidateResponse,
)
from ..application.use_cases.rules_catalog import (
    GetRuleWithActiveVersionCommand,
    ValidateRuleCommand,
)
from ..application.services.reference_embeddings import (
    backfill_missing_reference_embeddings,
    backfill_rule_reference_embeddings,
)
from ..infrastructure.http.semantic_search_client import HttpSemanticSearchClient
from ..composition import (
    archive_rule_use_case,
    bulk_reference_examples_use_case,
    clone_rule_use_case,
    create_rule_use_case,
    delete_reference_example_use_case,
    delete_rule_use_case,
    get_classification_conflicts_use_case,
    get_rule_with_active_version_use_case,
    get_semantic_threshold_use_case,
    list_reference_examples_use_case,
    list_rules_use_case,
    unarchive_rule_use_case,
    update_rule_use_case,
    validate_rule_use_case,
)
from ..db.session import get_db_session
from ..examples.fertilizer_rule_dsl import (
    FERTILIZER_DECLARATION_EXAMPLE,
    FERTILIZER_RULE_DSL,
)
from ..rules.dsl_models import RuleDSL

router = APIRouter(prefix="/api/rules", tags=["rules"])


class DSLSchemaResponse(BaseModel):
    """JSON Schema DSL в формате ответа API."""

    schema_: Dict[str, Any] = Field(alias="schema")

    model_config = {"populate_by_name": True}


class ExampleResponse(BaseModel):
    """Учебный пример DSL и пример входных данных."""

    dsl: Dict[str, Any]
    example_data: Any


class TemplateListItem(BaseModel):
    """Элемент списка готовых шаблонов справочников."""

    template_id: str
    title: str
    description: str


class TemplateDetailsResponse(BaseModel):
    """Полное описание шаблона DSL с примером."""

    template_id: str
    title: str
    description: str
    dsl: Dict[str, Any]
    example_data: Any


def _create_rule_response_after_commit(db: Session, rule_id: uuid.UUID) -> CreateRuleResponse:
    """Собирает ответ из актуальной записи версии после commit (как в прежней реализации)."""
    use_case = get_rule_with_active_version_use_case(db)
    try:
        rule, rv = use_case.execute(GetRuleWithActiveVersionCommand(rule_id=rule_id))
    except LookupError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return CreateRuleResponse(
        rule_id=rule.id,
        version=rv.version,
        dsl=rv.dsl_json,
        created_at=rv.created_at,
    )


@router.get("/dsl-schema", response_model=DSLSchemaResponse)
def get_dsl_schema() -> DSLSchemaResponse:
    """Возвращает JSON Schema для редактора DSL на фронтенде."""
    return DSLSchemaResponse(schema=RuleDSL.model_json_schema())


@router.get("/example/fertilizer", response_model=ExampleResponse)
def get_fertilizer_example() -> ExampleResponse:
    """Возвращает учебный DSL и пример данных для быстрого старта."""
    return ExampleResponse(dsl=FERTILIZER_RULE_DSL, example_data=FERTILIZER_DECLARATION_EXAMPLE)


@router.get("", response_model=list[RuleListItem])
def list_rules(
    q: Optional[str] = Query(None, description="Поиск по имени, model_id или коду группы ТН ВЭД"),
    include_archived: bool = Query(False, description="Показывать архивные справочники"),
    db: Session = Depends(get_db_session),
) -> list[RuleListItem]:
    """Список активных справочников с поиском и фильтром архивных."""
    return list_rules_use_case(db).execute(q=q, include_archived=include_archived)


@router.get("/templates", response_model=list[TemplateListItem])
def list_templates() -> list[TemplateListItem]:
    """Справочник доступных шаблонов создания правил."""
    return [
        TemplateListItem(
            template_id="fertilizer",
            title="Удобрения (массовые доли)",
            description="Шаблон правил для деклараций удобрений",
        )
    ]


@router.get("/templates/{template_id}", response_model=TemplateDetailsResponse)
def get_template(template_id: str) -> TemplateDetailsResponse:
    """Детали одного шаблона DSL по id."""
    if template_id == "fertilizer":
        return TemplateDetailsResponse(
            template_id="fertilizer",
            title="Удобрения (массовые доли)",
            description="Шаблон правил для деклараций удобрений",
            dsl=FERTILIZER_RULE_DSL,
            example_data=FERTILIZER_DECLARATION_EXAMPLE,
        )
    raise HTTPException(status_code=404, detail="Template not found")


@router.post("", response_model=CreateRuleResponse)
def create_rule(dsl_in: Dict[str, Any], db: Session = Depends(get_db_session)) -> CreateRuleResponse:
    """Создаёт новый справочник и первую активную версию DSL."""
    try:
        out = create_rule_use_case(db).execute(dsl_in)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return _create_rule_response_after_commit(db, out.rule_id)


@router.put("/{rule_id}", response_model=CreateRuleResponse)
@router.post("/{rule_id}/save", response_model=CreateRuleResponse)
def update_rule(rule_id: uuid.UUID, dsl_in: Dict[str, Any], db: Session = Depends(get_db_session)) -> CreateRuleResponse:
    """Сохраняет новую версию DSL существующего справочника и переключает active-флаг."""
    try:
        update_rule_use_case(db).execute(rule_id, dsl_in)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return _create_rule_response_after_commit(db, rule_id)


@router.post("/{rule_id}/clone", response_model=CreateRuleResponse)
def clone_rule(rule_id: uuid.UUID, req: CloneRuleRequest, db: Session = Depends(get_db_session)) -> CreateRuleResponse:
    """Клонирует активную версию справочника в новый `Rule` с версией 1."""
    try:
        out = clone_rule_use_case(db).execute(rule_id, req)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return _create_rule_response_after_commit(db, out.rule_id)


@router.post("/{rule_id}/archive")
def archive_rule(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, bool]:
    """Переводит справочник в архивное состояние."""
    try:
        out = archive_rule_use_case(db).execute(rule_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    db.commit()
    return out


@router.post("/{rule_id}/unarchive")
def unarchive_rule(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, bool]:
    """Снимает справочник с архива."""
    try:
        out = unarchive_rule_use_case(db).execute(rule_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    db.commit()
    return out


@router.delete("/{rule_id}")
def delete_rule(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, bool]:
    """Удаляет справочник и связанные сущности каскадом."""
    try:
        out = delete_rule_use_case(db).execute(rule_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    db.commit()
    return out


@router.get("/{rule_id}", response_model=Dict[str, Any])
def get_rule(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, Any]:
    """Возвращает карточку справочника с текущей активной версией DSL."""
    use_case = get_rule_with_active_version_use_case(db)
    try:
        rule, rv = use_case.execute(GetRuleWithActiveVersionCommand(rule_id=rule_id))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return {
        "rule_id": rule.id,
        "model_id": rule.model_id,
        "name": rule.name,
        "description": rule.description,
        "version": rv.version,
        "dsl": rv.dsl_json,
        "created_at": rv.created_at,
        "is_archived": rule.is_archived,
    }


@router.post("/{rule_id}/validate", response_model=ValidateResponse)
def validate_rule(rule_id: uuid.UUID, req: ValidateRequest, db: Session = Depends(get_db_session)) -> ValidateResponse:
    """Прогоняет произвольные данные через активную версию правила."""
    use_case = validate_rule_use_case(db)
    try:
        ok, errors, validated_data, assigned_class = use_case.execute(
            ValidateRuleCommand(rule_id=rule_id, data=req.data)
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rule compilation failed: {e}") from e
    return ValidateResponse(ok=ok, errors=errors, validated_data=validated_data, assigned_class=assigned_class)


@router.get("/{rule_id}/classification-conflicts", response_model=RuleConflictsResponse)
def classification_conflicts(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> RuleConflictsResponse:
    """
    Анализ пересечений правил классификации активной версии DSL.

    Связные по «overlaps» правила, для которых один синтетический пример одновременно проходит все правила,
    объединяются в одну запись (тройка и далее). Остальные случаи остаются попарными.

    Запись также создаётся для пары с corridor_risk_ru без overlaps (пример не строится).
    """
    try:
        return get_classification_conflicts_use_case(db).execute(rule_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/{rule_id}/semantic-threshold")
def get_semantic_threshold_for_rule(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, Any]:
    """
    Порог SimCheck для справочника: по парам эталонов внутри одного assigned_class_id
    считается Jaccard по токенам; эффективный порог — доля от медианы внутриклассовых схожестей.
    Если эталонов мало или все в разных классах — клиенту следует взять глобальный порог из pipeline.
    """
    try:
        return get_semantic_threshold_use_case(db).execute(rule_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{rule_id}/reference-examples")
def list_reference_examples(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, Any]:
    """Список эталонных примеров справочника с эмбеддингами (если есть)."""
    try:
        return list_reference_examples_use_case(db).execute(rule_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{rule_id}/reference-examples/bulk", response_model=ReferenceExampleBulkOut)
def bulk_reference_examples(
    rule_id: uuid.UUID, body: ReferenceExampleBulkIn, db: Session = Depends(get_db_session)
) -> ReferenceExampleBulkOut:
    """Пакетная загрузка эталонов с валидацией структуры и класса."""
    semantic_url = os.getenv("SEMANTIC_SEARCH_URL", "http://semantic-search:8001").strip()
    try:
        out, inserted_rows = bulk_reference_examples_use_case(db).execute(rule_id, body)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if inserted_rows:
        db.flush()
        backfill_missing_reference_embeddings(
            db,
            inserted_rows,
            client=HttpSemanticSearchClient(semantic_url, timeout=300.0),
        )
    db.commit()
    return out


class ReferenceEmbeddingsBackfillOut(BaseModel):
    embedded: int
    skipped: int
    processed: int
    examples_total: int


@router.post("/{rule_id}/reference-examples/backfill-embeddings", response_model=ReferenceEmbeddingsBackfillOut)
def backfill_reference_embeddings(
    rule_id: uuid.UUID,
    force: bool = Query(False, description="Пересчитать эмбеддинги даже если уже есть в БД"),
    db: Session = Depends(get_db_session),
) -> ReferenceEmbeddingsBackfillOut:
    """Пакетный расчёт отсутствующих эмбеддингов эталонов (ускоряет семантический fallback)."""
    semantic_url = os.getenv("SEMANTIC_SEARCH_URL", "http://semantic-search:8001").strip()
    try:
        stats = backfill_rule_reference_embeddings(
            db,
            rule_id,
            client=HttpSemanticSearchClient(semantic_url, timeout=600.0),
            force=force,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    db.commit()
    return ReferenceEmbeddingsBackfillOut(
        embedded=int(stats.get("embedded") or 0),
        skipped=int(stats.get("skipped") or 0),
        processed=int(stats.get("processed") or 0),
        examples_total=int(stats.get("examples_total") or 0),
    )


@router.delete("/{rule_id}/reference-examples/{example_id}")
def delete_reference_example(
    rule_id: uuid.UUID, example_id: uuid.UUID, db: Session = Depends(get_db_session)
) -> Dict[str, str]:
    """Удаляет один эталонный пример из справочника."""
    try:
        out = delete_reference_example_use_case(db).execute(rule_id, example_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    db.commit()
    return out
