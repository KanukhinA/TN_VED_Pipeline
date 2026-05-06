from __future__ import annotations

import os
import re
import statistics
import uuid
from datetime import datetime
from itertools import combinations
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db.session import get_db_session
from ..db.models import Rule, RuleReferenceEmbedding, RuleReferenceExample, RuleVersion
from ..rules.dsl_models import (
    ClassificationRule,
    RuleDSL,
    normalize_tn_ved_eaeu_code_value,
)
from ..rules.compiler import compile_rule
from ..rules.classification import _rule_matches
from ..rules.rule_overlap import (
    RuleOverlapDetail,
    analyze_rules_overlap,
    analyze_rules_overlap_group,
    build_ambiguous_example_for_rule_group,
    compact_numeric_constraints_for_rule,
    overlap_connected_components,
    rules_potentially_overlap,
)
from ..examples.fertilizer_rule_dsl import (
    FERTILIZER_RULE_DSL,
    FERTILIZER_DECLARATION_EXAMPLE,
)


router = APIRouter(prefix="/api/rules", tags=["rules"])


def _meta_tn_ved_group_code(dsl_json: Dict[str, Any]) -> Optional[str]:
    """Безопасно извлекает и нормализует `meta.tn_ved_group_code` из DSL-JSON."""
    meta = dsl_json.get("meta")
    if not isinstance(meta, dict):
        return None
    raw = meta.get("tn_ved_group_code")
    if raw is None:
        return None
    try:
        return normalize_tn_ved_eaeu_code_value(str(raw).strip())
    except ValueError:
        return None


def _token_jaccard(a: str, b: str) -> float:
    """Простая лексическая схожесть для калибровки порога по эталонам (без эмбеддингов)."""
    sa = set(re.findall(r"[\wа-яА-ЯёЁ]+", (a or "").lower()))
    sb = set(re.findall(r"[\wа-яА-ЯёЁ]+", (b or "").lower()))
    if not sa and not sb:
        return 1.0
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _rule_list_sort_key(item: "RuleListItem") -> tuple[int, str]:
    """Ключ сортировки справочников: сначала код группы, затем имя."""
    c = item.tn_ved_group_code
    if c and c.isdigit():
        return (int(c), (item.name or "").lower())
    return (9999, (item.name or "").lower())


def _clone_copy_name(base_name: Optional[str]) -> str:
    """Формирует имя копии справочника с суффиксом `(копия)`."""
    base = (base_name or "").strip()
    if not base:
        return "Справочник (копия)"
    if base.endswith("(копия)"):
        return base
    return f"{base} (копия)"


def _make_unique_clone_model_id(db: Session, source_model_id: str) -> str:
    """Генерирует уникальный `model_id` для клона."""
    src = source_model_id.strip() or "spravochnik"
    candidate = f"{src}_{uuid.uuid4().hex[:8]}"
    while db.query(Rule.id).filter(Rule.model_id == candidate).first() is not None:
        candidate = f"{src}_{uuid.uuid4().hex[:8]}"
    return candidate


def _cfg_feature_extraction_primary(item: dict) -> bool:
    """Признак основной конфигурации извлечения (поддержка bool и строки `true`)."""
    v = item.get("feature_extraction_primary")
    return v is True or v == "true"


def _models_shared_across_feature_configs(cfgs: list) -> bool:
    """Одна и та же модель отмечена в двух и более конфигурациях (по разным id)."""
    model_to_cfg_keys: dict[str, set[str]] = {}
    for idx, item in enumerate(cfgs):
        if not isinstance(item, dict):
            continue
        cfg_key = str(item.get("id") or "").strip() or f"__idx_{idx}"
        models = item.get("selected_models")
        if not isinstance(models, list):
            continue
        for m in models:
            ms = str(m).strip()
            if not ms:
                continue
            model_to_cfg_keys.setdefault(ms, set()).add(cfg_key)
    return any(len(s) > 1 for s in model_to_cfg_keys.values())


def _validate_feature_extraction_configs(meta: Any) -> None:
    """
    Если одна LLM встречается в нескольких конфигурациях извлечения — ровно одна должна быть отмечена
    как основная (feature_extraction_primary).
    """
    if meta is None:
        return
    raw = getattr(meta, "feature_extraction_configs", None)
    if not raw:
        return
    if not isinstance(raw, list):
        return
    cfgs = [c for c in raw if isinstance(c, dict)]
    if not cfgs:
        return
    primary_cfgs = [c for c in cfgs if _cfg_feature_extraction_primary(c)]
    if len(primary_cfgs) > 1:
        raise HTTPException(
            status_code=400,
            detail="В meta.feature_extraction_configs может быть только одна конфигурация с feature_extraction_primary=true.",
        )
    shared = _models_shared_across_feature_configs(cfgs)
    if shared and len(primary_cfgs) != 1:
        raise HTTPException(
            status_code=400,
            detail=(
                "Одна и та же модель отмечена в нескольких конфигурациях извлечения признаков. "
                "Укажите ровно одну конфигурацию как основную (feature_extraction_primary)."
            ),
        )


class CreateRuleResponse(BaseModel):
    rule_id: uuid.UUID
    version: int
    dsl: Dict[str, Any]
    created_at: datetime


class ValidateRequest(BaseModel):
    data: Any


class ValidateResponse(BaseModel):
    ok: bool
    errors: list[Any] = []
    validated_data: Optional[Dict[str, Any]] = None
    assigned_class: Optional[str] = None


class RuleOverlapColumnItem(BaseModel):
    """Одна колонка в сетке «пересекающиеся правила» (заголовок + компактные условия)."""

    rule_index: int
    label_ru: str = Field(description="Название или class_id для шапки колонки.")
    constraints_compact_ru: str = Field(description="Числовые/табличные условия одной строкой.")


class RuleConflictItem(BaseModel):
    left_rule_index: int
    right_rule_index: int
    left_class_id: str
    right_class_id: str
    left_title: Optional[str] = None
    right_title: Optional[str] = None
    rule_indices: list[int] = Field(
        default_factory=list,
        description="1-based индексы всех правил в группе (пара или больше); для обратной совместимости есть left/right.",
    )
    rule_class_ids: list[str] = Field(default_factory=list)
    rule_titles: list[Optional[str]] = Field(default_factory=list)
    reason_ru: str
    ambiguous_example: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Синтетический JSON признаков, по возможности удовлетворяющий обоим правилам.",
    )
    ambiguous_example_note_ru: Optional[str] = Field(
        default=None,
        description="Пояснение, если пример частичный или не прошёл проверку условий.",
    )
    corridor_risk_ru: Optional[str] = Field(
        default=None,
        description="Риск спецификации: коридоры min–max на оси пересекаются, но одновременная проверка как в декларации невозможна.",
    )
    overlap_context_note_ru: Optional[str] = Field(
        default=None,
        description="Контекст: несколько условий, «или», группы.",
    )
    simplified_analysis_note_ru: Optional[str] = Field(
        default=None,
        description="Упрощённый анализ при «или» или группах условий.",
    )
    priority_resolution_ru: Optional[str] = Field(
        default=None,
        description="Кому отдан приоритет при одновременном выполнении и почему.",
    )
    range_intersections_ru: list[str] = Field(
        default_factory=list,
        description="Явное описание пересечения числовых диапазонов по полю декларации или ячейке таблицы.",
    )
    adjustment_recommendations_ru: list[str] = Field(
        default_factory=list,
        description="Практические подсказки, что подкрутить в правилах.",
    )
    overlap_axis_summary_ru: Optional[str] = Field(
        default=None,
        description="Кратко: где пересекаются диапазоны по числу.",
    )
    overlap_columns: list[RuleOverlapColumnItem] = Field(
        default_factory=list,
        description="Правила в виде столбцов: подпись и компактные условия.",
    )


class RuleConflictsResponse(BaseModel):
    has_conflicts: bool
    conflicts: list[RuleConflictItem] = Field(default_factory=list)



_rules_potentially_overlap = rules_potentially_overlap

class DSLSchemaResponse(BaseModel):
    schema_: Dict[str, Any] = Field(alias="schema")

    model_config = {"populate_by_name": True}


class ExampleResponse(BaseModel):
    dsl: Dict[str, Any]
    example_data: Any


class RuleListItem(BaseModel):
    rule_id: uuid.UUID
    model_id: str
    name: Optional[str] = None
    description: Optional[str] = None
    tn_ved_group_code: Optional[str] = None
    version: int
    created_at: datetime
    is_archived: bool = False


class CloneRuleRequest(BaseModel):
    name: Optional[str] = None
    model_id: Optional[str] = None


class TemplateListItem(BaseModel):
    template_id: str
    title: str
    description: str


class TemplateDetailsResponse(BaseModel):
    template_id: str
    title: str
    description: str
    dsl: Dict[str, Any]
    example_data: Any


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
    stmt = (
        db.query(Rule, RuleVersion)
        .join(RuleVersion, RuleVersion.rule_id == Rule.id)
        .filter(RuleVersion.is_active.is_(True))
    )
    if not include_archived:
        stmt = stmt.filter(Rule.is_archived.is_(False))

    rows = stmt.order_by(RuleVersion.created_at.desc()).all()

    qn = (q or "").strip().lower()

    def row_matches(rule: Rule, rv: RuleVersion) -> bool:
        """Проверка попадания справочника под поисковую строку."""
        if not qn:
            return True
        if qn in rule.model_id.lower():
            return True
        if rule.name and qn in (rule.name or "").lower():
            return True
        tn = _meta_tn_ved_group_code(rv.dsl_json)
        if tn:
            if qn in tn:
                return True
            if qn.isdigit():
                try:
                    if int(qn) == int(tn):
                        return True
                except ValueError:
                    pass
        return False

    result: list[RuleListItem] = []
    for rule, rv in rows:
        if not row_matches(rule, rv):
            continue
        result.append(
            RuleListItem(
                rule_id=rule.id,
                model_id=rule.model_id,
                name=rule.name,
                description=rule.description,
                tn_ved_group_code=_meta_tn_ved_group_code(rv.dsl_json),
                version=rv.version,
                created_at=rv.created_at,
                is_archived=rule.is_archived,
            )
        )
    result.sort(key=_rule_list_sort_key)
    return result


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
        dsl = RuleDSL.model_validate(dsl_in)
        # Ранняя проверка: DSL должен успешно компилироваться в исполняемую модель.
        _ = compile_rule(dsl)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid DSL: {e}")

    _validate_feature_extraction_configs(dsl.meta)

    if dsl.meta is None or not dsl.meta.tn_ved_group_code:
        raise HTTPException(
            status_code=400,
            detail="Invalid DSL: meta.tn_ved_group_code is required (код ТН ВЭД ЕАЭС: 2, 4, 6, 8 или 10 цифр, глава 01–97)",
        )

    created_at = datetime.utcnow()
    meta = dsl.meta

    rule = Rule(
        model_id=dsl.model_id,
        name=meta.name if meta else None,
        description=meta.description if meta else None,
        created_at=created_at,
    )
    db.add(rule)
    db.flush()  # Нужен `rule.id` до создания записи версии.

    version = 1
    dsl_json = dsl.model_dump(by_alias=True, exclude_none=True)
    rv = RuleVersion(
        rule_id=rule.id,
        version=version,
        is_active=True,
        model_id=dsl.model_id,
        dsl_json=dsl_json,
        created_at=created_at,
    )
    db.add(rv)
    db.commit()

    db.refresh(rv)
    return CreateRuleResponse(
        rule_id=rule.id,
        version=version,
        dsl=rv.dsl_json,
        created_at=rv.created_at,
    )


@router.put("/{rule_id}", response_model=CreateRuleResponse)
@router.post("/{rule_id}/save", response_model=CreateRuleResponse)
def update_rule(rule_id: uuid.UUID, dsl_in: Dict[str, Any], db: Session = Depends(get_db_session)) -> CreateRuleResponse:
    """Сохраняет новую версию DSL существующего справочника и переключает active-флаг."""
    rule: Rule | None = db.query(Rule).filter(Rule.id == rule_id).one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")

    try:
        dsl = RuleDSL.model_validate(dsl_in)
        _ = compile_rule(dsl)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid DSL: {e}")

    _validate_feature_extraction_configs(dsl.meta)

    if dsl.meta is None or not dsl.meta.tn_ved_group_code:
        raise HTTPException(
            status_code=400,
            detail="Invalid DSL: meta.tn_ved_group_code is required (код ТН ВЭД ЕАЭС: 2, 4, 6, 8 или 10 цифр, глава 01–97)",
        )

    active_versions = (
        db.query(RuleVersion)
        .filter(RuleVersion.rule_id == rule_id, RuleVersion.is_active.is_(True))
        .all()
    )
    latest = (
        db.query(RuleVersion)
        .filter(RuleVersion.rule_id == rule_id)
        .order_by(RuleVersion.version.desc())
        .first()
    )

    for v in active_versions:
        # Сохраняем историю, но оставляем активной только новую версию.
        v.is_active = False

    next_version = (latest.version if latest else 0) + 1
    created_at = datetime.utcnow()
    dsl_json = dsl.model_dump(by_alias=True, exclude_none=True)
    meta = dsl.meta

    rule.model_id = dsl.model_id
    rule.name = meta.name if meta else None
    rule.description = meta.description if meta else None

    rv = RuleVersion(
        rule_id=rule.id,
        version=next_version,
        is_active=True,
        model_id=dsl.model_id,
        dsl_json=dsl_json,
        created_at=created_at,
    )
    db.add(rv)
    db.commit()
    db.refresh(rv)

    return CreateRuleResponse(
        rule_id=rule.id,
        version=rv.version,
        dsl=rv.dsl_json,
        created_at=rv.created_at,
    )


@router.post("/{rule_id}/clone", response_model=CreateRuleResponse)
def clone_rule(rule_id: uuid.UUID, req: CloneRuleRequest, db: Session = Depends(get_db_session)) -> CreateRuleResponse:
    """Клонирует активную версию справочника в новый `Rule` с версией 1."""
    source_rule: Rule | None = db.query(Rule).filter(Rule.id == rule_id).one_or_none()
    if not source_rule:
        raise HTTPException(status_code=404, detail="Source rule not found")

    source_version: RuleVersion | None = (
        db.query(RuleVersion)
        .filter(RuleVersion.rule_id == rule_id, RuleVersion.is_active.is_(True))
        .order_by(RuleVersion.version.desc())
        .first()
    )
    if not source_version:
        raise HTTPException(status_code=404, detail="Source active version not found")

    dsl_json = dict(source_version.dsl_json)
    meta = dsl_json.get("meta", {}) if isinstance(dsl_json.get("meta"), dict) else {}
    if req.name:
        meta["name"] = req.name
    else:
        source_name = source_rule.name or meta.get("name")
        meta["name"] = _clone_copy_name(source_name)
    dsl_json["meta"] = meta

    if req.model_id:
        dsl_json["model_id"] = req.model_id
    else:
        source_model_id = str(dsl_json.get("model_id") or source_rule.model_id or "").strip()
        dsl_json["model_id"] = _make_unique_clone_model_id(db, source_model_id)

    try:
        dsl = RuleDSL.model_validate(dsl_json)
        _ = compile_rule(dsl)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid DSL clone: {e}")

    _validate_feature_extraction_configs(dsl.meta)

    created_at = datetime.utcnow()
    rule = Rule(
        model_id=dsl.model_id,
        name=meta.get("name"),
        description=meta.get("description"),
        created_at=created_at,
    )
    db.add(rule)
    db.flush()

    rv = RuleVersion(
        rule_id=rule.id,
        version=1,
        is_active=True,
        model_id=dsl.model_id,
        dsl_json=dsl.model_dump(by_alias=True, exclude_none=True),
        created_at=created_at,
    )
    db.add(rv)
    db.commit()
    db.refresh(rv)

    return CreateRuleResponse(
        rule_id=rule.id,
        version=rv.version,
        dsl=rv.dsl_json,
        created_at=rv.created_at,
    )


@router.post("/{rule_id}/archive")
def archive_rule(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, bool]:
    """Переводит справочник в архивное состояние."""
    rule: Rule | None = db.query(Rule).filter(Rule.id == rule_id).one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    rule.is_archived = True
    db.commit()
    return {"ok": True}


@router.post("/{rule_id}/unarchive")
def unarchive_rule(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, bool]:
    """Снимает справочник с архива."""
    rule: Rule | None = db.query(Rule).filter(Rule.id == rule_id).one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    rule.is_archived = False
    db.commit()
    return {"ok": True}


@router.delete("/{rule_id}")
def delete_rule(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, bool]:
    """Удаляет справочник и связанные сущности каскадом."""
    rule: Rule | None = db.query(Rule).filter(Rule.id == rule_id).one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    db.delete(rule)
    db.commit()
    return {"ok": True}


@router.get("/{rule_id}", response_model=Dict[str, Any])
def get_rule(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, Any]:
    """Возвращает карточку справочника с текущей активной версией DSL."""
    rule: Rule | None = db.query(Rule).filter(Rule.id == rule_id).one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")

    rv: RuleVersion | None = (
        db.query(RuleVersion)
        .filter(RuleVersion.rule_id == rule_id, RuleVersion.is_active.is_(True))
        .order_by(RuleVersion.version.desc())
        .first()
    )
    if not rv:
        raise HTTPException(status_code=404, detail="Active rule version not found")

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
    rv: RuleVersion | None = (
        db.query(RuleVersion)
        .filter(RuleVersion.rule_id == rule_id, RuleVersion.is_active.is_(True))
        .order_by(RuleVersion.version.desc())
        .first()
    )
    if not rv:
        raise HTTPException(status_code=404, detail="Active rule version not found")

    try:
        dsl = RuleDSL.model_validate(rv.dsl_json)
        compiled = compile_rule(dsl)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rule compilation failed: {e}")

    ok, errors, validated_data, assigned_class = compiled.validate(req.data)
    return ValidateResponse(ok=ok, errors=errors, validated_data=validated_data, assigned_class=assigned_class)


def _rule_overlap_columns_for_indices(
    rules_list: Sequence[ClassificationRule],
    idxs_zero_based: List[int],
) -> List[RuleOverlapColumnItem]:
    out: List[RuleOverlapColumnItem] = []
    for i0 in idxs_zero_based:
        r = rules_list[i0]
        lbl = (r.title or "").strip() or str(r.class_id or "").strip() or f"Правило {i0 + 1}"
        out.append(
            RuleOverlapColumnItem(
                rule_index=i0 + 1,
                label_ru=lbl,
                constraints_compact_ru=compact_numeric_constraints_for_rule(r),
            )
        )
    return out


def classification_conflict_items_for_rules(rules: Sequence[ClassificationRule]) -> list[RuleConflictItem]:
    """
    Список конфликтов для набора правил классификации (логика эндпоинта classification-conflicts).
    """
    rules_list = list(rules)
    n = len(rules_list)
    conflicts: list[RuleConflictItem] = []
    pair_detail: dict[Tuple[int, int], RuleOverlapDetail] = {}
    for i in range(n):
        for j in range(i + 1, n):
            left_title = (rules_list[i].title or "").strip() or str(rules_list[i].class_id or f"правило {i + 1}")
            right_title = (rules_list[j].title or "").strip() or str(rules_list[j].class_id or f"правило {j + 1}")
            pair_detail[(i, j)] = analyze_rules_overlap(
                rules_list[i], rules_list[j], left_title=left_title, right_title=right_title
            )

    overlap_edges = [(i, j) for (i, j), d in pair_detail.items() if d.overlaps]
    components = overlap_connected_components(overlap_edges, n)
    pairs_subsumed: set[Tuple[int, int]] = set()

    for comp in components:
        idxs = sorted(comp)
        if len(idxs) < 2:
            continue
        grp = [rules_list[i] for i in idxs]
        titles = [(rules_list[i].title or "").strip() or str(rules_list[i].class_id or f"правило {i + 1}") for i in idxs]
        ex: Optional[Dict[str, Any]] = None
        ex_note: Optional[str] = None
        try:
            ex, ex_note = build_ambiguous_example_for_rule_group(grp)
        except Exception:
            ex, ex_note = None, "Не удалось сформировать пример признаков автоматически."
        example_ok = ex is not None and all(_rule_matches(ex, rules_list[i]) for i in idxs)
        if not example_ok:
            continue
        detail_g = analyze_rules_overlap_group(grp, titles)
        if not detail_g.overlaps:
            continue
        one_based: List[int] = [i + 1 for i in idxs]
        conflicts.append(
            RuleConflictItem(
                left_rule_index=one_based[0],
                right_rule_index=one_based[-1],
                left_class_id=str(rules_list[idxs[0]].class_id or ""),
                right_class_id=str(rules_list[idxs[-1]].class_id or ""),
                left_title=rules_list[idxs[0]].title,
                right_title=rules_list[idxs[-1]].title,
                rule_indices=one_based,
                rule_class_ids=[str(rules_list[i].class_id or "") for i in idxs],
                rule_titles=[rules_list[i].title for i in idxs],
                reason_ru=detail_g.reason_ru,
                ambiguous_example=ex,
                ambiguous_example_note_ru=ex_note,
                corridor_risk_ru=detail_g.corridor_risk_ru,
                overlap_context_note_ru=detail_g.overlap_context_note_ru,
                simplified_analysis_note_ru=detail_g.simplified_analysis_note_ru,
                priority_resolution_ru=detail_g.priority_resolution_ru,
                range_intersections_ru=detail_g.range_intersections_ru,
                adjustment_recommendations_ru=detail_g.adjustment_recommendations_ru,
                overlap_axis_summary_ru=detail_g.overlap_axis_summary_ru,
                overlap_columns=_rule_overlap_columns_for_indices(rules_list, idxs),
            )
        )
        for a, b in combinations(idxs, 2):
            pairs_subsumed.add((a, b))

    for i in range(n):
        for j in range(i + 1, n):
            if (i, j) in pairs_subsumed:
                continue
            detail = pair_detail[(i, j)]
            if not detail.overlaps and not detail.corridor_risk_ru:
                continue
            ex2: Optional[Dict[str, Any]] = None
            ex_note2: Optional[str] = None
            if detail.overlaps:
                try:
                    ex2, ex_note2 = build_ambiguous_example_for_rule_group([rules_list[i], rules_list[j]])
                except Exception:
                    ex2, ex_note2 = None, "Не удалось сформировать пример признаков автоматически."
            conflicts.append(
                RuleConflictItem(
                    left_rule_index=i + 1,
                    right_rule_index=j + 1,
                    left_class_id=str(rules_list[i].class_id or ""),
                    right_class_id=str(rules_list[j].class_id or ""),
                    left_title=(rules_list[i].title or None),
                    right_title=(rules_list[j].title or None),
                    rule_indices=[i + 1, j + 1],
                    rule_class_ids=[str(rules_list[i].class_id or ""), str(rules_list[j].class_id or "")],
                    rule_titles=[rules_list[i].title, rules_list[j].title],
                    reason_ru=detail.reason_ru,
                    ambiguous_example=ex2,
                    ambiguous_example_note_ru=ex_note2,
                    corridor_risk_ru=detail.corridor_risk_ru,
                    overlap_context_note_ru=detail.overlap_context_note_ru,
                    simplified_analysis_note_ru=detail.simplified_analysis_note_ru,
                    priority_resolution_ru=detail.priority_resolution_ru,
                    range_intersections_ru=detail.range_intersections_ru,
                    adjustment_recommendations_ru=detail.adjustment_recommendations_ru,
                    overlap_axis_summary_ru=detail.overlap_axis_summary_ru,
                    overlap_columns=_rule_overlap_columns_for_indices(rules_list, [i, j]),
                )
            )
    return conflicts


@router.get("/{rule_id}/classification-conflicts", response_model=RuleConflictsResponse)
def classification_conflicts(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> RuleConflictsResponse:
    """
    Анализ пересечений правил классификации активной версии DSL.

    Связные по «overlaps» правила, для которых один синтетический пример одновременно проходит все правила,
    объединяются в одну запись (тройка и далее). Остальные случаи остаются попарными.

    Запись также создаётся для пары с corridor_risk_ru без overlaps (пример не строится).
    """
    rv: RuleVersion | None = (
        db.query(RuleVersion)
        .filter(RuleVersion.rule_id == rule_id, RuleVersion.is_active.is_(True))
        .order_by(RuleVersion.version.desc())
        .first()
    )
    if not rv:
        raise HTTPException(status_code=404, detail="Active rule version not found")
    try:
        dsl = RuleDSL.model_validate(rv.dsl_json)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rule parse failed: {e}")

    clf = dsl.classification
    rules = list(clf.rules) if clf and clf.rules else []
    conflicts = classification_conflict_items_for_rules(rules)
    return RuleConflictsResponse(has_conflicts=len(conflicts) > 0, conflicts=conflicts)


@router.get("/{rule_id}/semantic-threshold")
def get_semantic_threshold_for_rule(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, Any]:
    """
    Порог SimCheck для справочника: по парам эталонов внутри одного assigned_class_id
    считается Jaccard по токенам; эффективный порог — доля от медианы внутриклассовых схожестей.
    Если эталонов мало или все в разных классах — клиенту следует взять глобальный порог из pipeline.
    """
    global_default = float(os.getenv("SEMANTIC_SIMILARITY_THRESHOLD", "0.75"))

    rule: Rule | None = db.query(Rule).filter(Rule.id == rule_id).one_or_none()
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")

    rows = (
        db.query(RuleReferenceExample)
        .filter(RuleReferenceExample.rule_id == rule_id)
        .all()
    )
    if len(rows) < 2:
        return {
            "threshold": None,
            "source": "global_fallback",
            "n_examples": len(rows),
            "n_pairs": 0,
            "global_default_hint": global_default,
            "reason": "need_at_least_two_examples",
        }

    by_class: dict[str, list[str]] = {}
    for r in rows:
        cid = str(r.assigned_class_id or "").strip()
        if not cid:
            continue
        by_class.setdefault(cid, []).append(r.description_text or "")

    sims: list[float] = []
    for texts in by_class.values():
        if len(texts) < 2:
            continue
        for i in range(len(texts)):
            for j in range(i + 1, len(texts)):
                sims.append(_token_jaccard(texts[i], texts[j]))

    if not sims:
        return {
            "threshold": None,
            "source": "global_fallback",
            "n_examples": len(rows),
            "n_pairs": 0,
            "global_default_hint": global_default,
            "reason": "no_intra_class_pairs",
        }

    med = float(statistics.median(sims))
    calibrated = max(0.35, min(0.92, med * 0.85))
    return {
        "threshold": calibrated,
        "source": "reference_examples",
        "n_examples": len(rows),
        "n_pairs": len(sims),
        "median_intra_class_similarity": med,
        "global_default_hint": global_default,
    }


def _classification_class_ids_from_dsl(dsl: RuleDSL) -> set[str]:
    """Уникальные class_id из правил классификации (нижний регистр)."""
    c = dsl.classification
    if c is None or not c.rules:
        return set()
    out: set[str] = set()
    for r in c.rules:
        cid = str(r.class_id).strip().lower()
        if cid:
            out.add(cid)
    return out


class ReferenceExampleBulkItem(BaseModel):
    """Строка датасета: описание декларации + JSON признаков для детерминированной классификации."""

    description_text: str = ""
    data: Any
    assigned_class_id: Optional[str] = None
    """Явный класс от эксперта; должен совпадать с одним из class_id в classification.rules."""


class ReferenceExampleBulkIn(BaseModel):
    items: list[ReferenceExampleBulkItem] = Field(default_factory=list)


class ReferenceExampleBulkOut(BaseModel):
    inserted: int
    skipped: list[dict[str, Any]]


def _normalize_reference_description(raw: str) -> str:
    """Нормализует текст описания, подставляя маркер для пустых значений."""
    desc = (raw or "").strip()
    return desc if desc else "(без описания)"


@router.get("/{rule_id}/reference-examples")
def list_reference_examples(rule_id: uuid.UUID, db: Session = Depends(get_db_session)) -> Dict[str, Any]:
    """Список эталонных примеров справочника с эмбеддингами (если есть)."""
    rule: Rule | None = db.query(Rule).filter(Rule.id == rule_id).one_or_none()
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    rows = (
        db.query(RuleReferenceExample)
        .filter(RuleReferenceExample.rule_id == rule_id)
        .order_by(RuleReferenceExample.created_at.desc())
        .all()
    )
    ids = [r.id for r in rows]
    emb_rows = (
        db.query(RuleReferenceEmbedding)
        .filter(RuleReferenceEmbedding.reference_example_id.in_(ids))
        .all()
        if ids
        else []
    )
    emb_by_ref = {e.reference_example_id: e for e in emb_rows}
    return {
        "examples": [
            {
                "id": str(r.id),
                "rule_id": str(r.rule_id),
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "description_text": r.description_text,
                "features_json": r.features_json,
                "assigned_class_id": r.assigned_class_id,
                "embedding_model": emb_by_ref[r.id].embedding_model if r.id in emb_by_ref else None,
                "embedding": emb_by_ref[r.id].embedding_json.get("vector")
                if r.id in emb_by_ref and isinstance(emb_by_ref[r.id].embedding_json, dict)
                else None,
            }
            for r in rows
        ]
    }


@router.post("/{rule_id}/reference-examples/bulk", response_model=ReferenceExampleBulkOut)
def bulk_reference_examples(
    rule_id: uuid.UUID, body: ReferenceExampleBulkIn, db: Session = Depends(get_db_session)
) -> ReferenceExampleBulkOut:
    """Пакетная загрузка эталонов с валидацией структуры и класса."""
    rule: Rule | None = db.query(Rule).filter(Rule.id == rule_id).one_or_none()
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")

    rv: RuleVersion | None = (
        db.query(RuleVersion)
        .filter(RuleVersion.rule_id == rule_id, RuleVersion.is_active.is_(True))
        .order_by(RuleVersion.version.desc())
        .first()
    )
    if rv is None:
        raise HTTPException(status_code=404, detail="Active rule version not found")

    try:
        dsl = RuleDSL.model_validate(rv.dsl_json)
        compiled = compile_rule(dsl)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rule compilation failed: {e}")

    allowed_classes = _classification_class_ids_from_dsl(dsl)
    existing_descriptions = {
        (str(d or "").strip() or "(без описания)")
        for (d,) in db.query(RuleReferenceExample.description_text)
        .filter(RuleReferenceExample.rule_id == rule_id)
        .all()
    }
    seen_descriptions = set(existing_descriptions)

    inserted = 0
    skipped: list[dict[str, Any]] = []
    for idx, item in enumerate(body.items):
        desc = _normalize_reference_description(item.description_text or "")
        if desc in seen_descriptions:
            # Идентичные описания считаем дублями, чтобы не размывать датасет.
            skipped.append(
                {
                    "index": idx,
                    "reason": "duplicate_description_text",
                    "detail": "example with identical description_text already exists; existing record is preserved",
                }
            )
            continue

        ok, errors, validated_data, assigned_class = compiled.validate(item.data)
        if not ok:
            # Невалидные строки не импортируем, но возвращаем детали ошибки.
            skipped.append(
                {
                    "index": idx,
                    "reason": "validation_failed",
                    "errors": errors,
                }
            )
            continue

        expert_raw = (item.assigned_class_id or "").strip()
        expert_norm = expert_raw.lower() if expert_raw else ""
        if expert_norm:
            # Явный класс от эксперта разрешаем только из classification.rules.
            if expert_norm not in allowed_classes:
                skipped.append(
                    {
                        "index": idx,
                        "reason": "invalid_class_override",
                        "detail": "assigned_class_id must match a classification rule class_id",
                    }
                )
                continue
            final_class = expert_norm
        else:
            if not assigned_class:
                skipped.append(
                    {
                        "index": idx,
                        "reason": "no_class",
                        "errors": None,
                    }
                )
                continue
            final_class = str(assigned_class)

        row = RuleReferenceExample(
            rule_id=rule_id,
            description_text=desc[:500_000],
            features_json=validated_data if isinstance(validated_data, dict) else item.data,
            assigned_class_id=final_class,
        )
        db.add(row)
        seen_descriptions.add(desc)
        inserted += 1

    db.commit()
    return ReferenceExampleBulkOut(inserted=inserted, skipped=skipped)


@router.delete("/{rule_id}/reference-examples/{example_id}")
def delete_reference_example(
    rule_id: uuid.UUID, example_id: uuid.UUID, db: Session = Depends(get_db_session)
) -> Dict[str, str]:
    """Удаляет один эталонный пример из справочника."""
    row: RuleReferenceExample | None = (
        db.query(RuleReferenceExample)
        .filter(RuleReferenceExample.id == example_id, RuleReferenceExample.rule_id == rule_id)
        .one_or_none()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Example not found")
    db.delete(row)
    db.commit()
    return {"status": "ok"}

