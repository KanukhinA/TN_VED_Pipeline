from __future__ import annotations

import uuid
from datetime import datetime
import os
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
import httpx
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import String, cast, func, or_
from sqlalchemy.orm import Session

from ..db.models import ExpertDecisionItem, RuleReferenceEmbedding, RuleReferenceExample, RuleVersion
from ..db.session import get_db_session
from ..rules.compiler import compile_rule
from ..rules.dsl_models import RuleDSL

router = APIRouter(prefix="/api/expert-decisions", tags=["expert-decisions"])
SEMANTIC_SEARCH_URL = os.getenv("SEMANTIC_SEARCH_URL", "http://semantic-search:8001")


class ExpertDecisionCreate(BaseModel):
    category: str = Field(..., min_length=1, max_length=64)
    declaration_id: str = Field(..., min_length=1, max_length=512)
    summary_ru: str = ""
    payload: Dict[str, Any] = Field(default_factory=dict)
    rule_id: Optional[str] = None
    model_config = ConfigDict(extra="ignore")


class ExpertDecisionItemOut(BaseModel):
    id: str
    category: str
    rule_id: Optional[str] = None
    declaration_id: str
    status: str
    summary_ru: str
    payload_json: Dict[str, Any]
    resolution_json: Optional[Dict[str, Any]] = None
    created_at: str
    resolved_at: Optional[str] = None


class ExpertDecisionPatch(BaseModel):
    status: Literal["pending", "resolved", "dismissed"]
    resolution: Dict[str, Any] = Field(default_factory=dict)
    model_config = ConfigDict(extra="ignore")


class ExpertDecisionListPageOut(BaseModel):
    items: List[ExpertDecisionItemOut]
    total: int
    page: int
    page_size: int


ISSUE_TYPE_TO_CATEGORIES: Dict[str, List[str]] = {
    "class_confirmation": ["class_name_confirmation", "auto_classification_review", "classification_unresolved"],
    "auto_classification": ["auto_classification_review", "classification_unresolved"],
    "classification": ["classification_ambiguous", "classification_none", "classification_unresolved"],
    "inspector_correction": ["inspector_feature_correction"],
    "officer_decision": ["officer_final_decision"],
}


def _json_text_path(column: Any, *keys: str) -> Any:
    """Кросс-БД доступ к вложенному JSON-полю как к строковому выражению SQLAlchemy."""
    expr = column
    for key in keys:
        expr = expr[key]
    if hasattr(expr, "as_string"):
        return expr.as_string()
    if hasattr(expr, "astext"):
        return expr.astext
    return cast(expr, String)


def _parse_iso_datetime_or_400(raw: Optional[str], field_name: str) -> Optional[datetime]:
    """Парсит ISO-дату из query-параметра и возвращает 400 при неверном формате."""
    if raw is None or not str(raw).strip():
        return None
    val = str(raw).strip()
    # FastAPI often passes Zulu timestamps as "...Z"; fromisoformat expects "+00:00".
    if val.endswith("Z"):
        val = f"{val[:-1]}+00:00"
    try:
        return datetime.fromisoformat(val)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Некорректный формат {field_name}; используйте ISO-дату") from exc


def _to_out(row: ExpertDecisionItem) -> ExpertDecisionItemOut:
    """Преобразует ORM-модель в DTO ответа API."""
    return ExpertDecisionItemOut(
        id=str(row.id),
        category=row.category,
        rule_id=str(row.rule_id) if row.rule_id else None,
        declaration_id=row.declaration_id,
        status=row.status,
        summary_ru=row.summary_ru,
        payload_json=row.payload_json,
        resolution_json=row.resolution_json,
        created_at=row.created_at.isoformat() if row.created_at else "",
        resolved_at=row.resolved_at.isoformat() if row.resolved_at else None,
    )


def _item_tnved_code(item: ExpertDecisionItemOut) -> str:
    """Безопасно извлекает код ТН ВЭД из payload ответа."""
    payload = item.payload_json if isinstance(item.payload_json, dict) else {}
    llm_result = payload.get("llm_result")
    if not isinstance(llm_result, dict):
        return ""
    prompt_includes = llm_result.get("prompt_includes")
    if not isinstance(prompt_includes, dict):
        return ""
    return str(prompt_includes.get("tnved_code") or "").strip()


def _item_class_value(item: ExpertDecisionItemOut) -> str:
    """Возвращает выбранный/подтверждённый class_id для фильтрации и поиска."""
    res = item.resolution_json if isinstance(item.resolution_json, dict) else {}
    chosen = str(res.get("chosen_class_id") or "").strip()
    if chosen:
        return chosen
    return str(res.get("confirmed_class_id") or "").strip()


def _item_description(item: ExpertDecisionItemOut) -> str:
    """Возвращает извлечённый текст описания товара из payload."""
    payload = item.payload_json if isinstance(item.payload_json, dict) else {}
    llm_result = payload.get("llm_result")
    if not isinstance(llm_result, dict):
        return ""
    prompt_includes = llm_result.get("prompt_includes")
    if not isinstance(prompt_includes, dict):
        return ""
    return str(prompt_includes.get("description_excerpt") or "").strip()


def _officer_decision_description(payload: Dict[str, Any]) -> str:
    """Берёт описание из officer payload с приоритетом llm_result, затем officer_input."""
    llm_result = payload.get("llm_result") if isinstance(payload, dict) else None
    if isinstance(llm_result, dict):
        prompt_includes = llm_result.get("prompt_includes")
        if isinstance(prompt_includes, dict):
            desc = str(prompt_includes.get("description_excerpt") or "").strip()
            if desc:
                return desc
    officer_input = payload.get("officer_input") if isinstance(payload, dict) else None
    if isinstance(officer_input, dict):
        desc = str(officer_input.get("graph31") or "").strip()
        if desc:
            return desc
    return ""


def _officer_decision_class_id(payload: Dict[str, Any], resolution: Dict[str, Any]) -> str:
    """Определяет итоговый class_id из resolution/payload по приоритетному порядку."""
    chosen = str(resolution.get("chosen_class_id") or "").strip()
    if chosen:
        return chosen
    confirmed = str(resolution.get("confirmed_class_id") or "").strip()
    if confirmed:
        return confirmed
    manual = str(payload.get("manual_class_assigned_by_officer") or "").strip()
    if manual:
        return manual
    final_decision_class = str(payload.get("final_decision_class") or "").strip()
    if final_decision_class:
        return final_decision_class
    auto_before = str(payload.get("auto_class_before_decision") or "").strip()
    if auto_before:
        return auto_before
    return ""


def _upsert_reference_embedding(
    db: Session,
    ref: RuleReferenceExample,
) -> None:
    """Создаёт или обновляет эмбеддинг эталонного примера через semantic-search сервис."""
    desc = (ref.description_text or "").strip()
    if not desc:
        return
    try:
        with httpx.Client(timeout=25.0) as client:
            resp = client.post(
                f"{SEMANTIC_SEARCH_URL}/api/v1/embed",
                json={"texts": [desc]},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        # Ошибки внешнего сервиса не должны ломать основной сценарий сохранения решения.
        return
    model_name = str(data.get("embedding_model") or "").strip()
    vectors = data.get("vectors")
    if not model_name or not isinstance(vectors, list) or len(vectors) == 0 or not isinstance(vectors[0], list):
        return
    vector = vectors[0]
    if not vector:
        return
    emb = (
        db.query(RuleReferenceEmbedding)
        .filter(RuleReferenceEmbedding.reference_example_id == ref.id)
        .one_or_none()
    )
    payload = {"vector": vector}
    now = datetime.utcnow()
    if emb is None:
        emb = RuleReferenceEmbedding(
            reference_example_id=ref.id,
            embedding_model=model_name,
            embedding_json=payload,
            created_at=now,
            updated_at=now,
        )
        db.add(emb)
    else:
        emb.embedding_model = model_name
        emb.embedding_json = payload
        emb.updated_at = now


def _sync_reference_example_from_officer_decision(db: Session, row: ExpertDecisionItem) -> None:
    """Синхронизирует officer-решение в таблицу эталонов для последующего семантического поиска."""
    if row.category != "officer_final_decision":
        return
    if row.rule_id is None:
        return
    payload = row.payload_json if isinstance(row.payload_json, dict) else {}
    resolution = row.resolution_json if isinstance(row.resolution_json, dict) else {}
    desc = _officer_decision_description(payload)
    class_id = _officer_decision_class_id(payload, resolution)
    if not desc or not class_id:
        return
    features = payload.get("parsed_features")
    features_json = features if isinstance(features, dict) else {}
    ref = (
        db.query(RuleReferenceExample)
        .filter(
            RuleReferenceExample.rule_id == row.rule_id,
            RuleReferenceExample.description_text == desc,
        )
        .one_or_none()
    )
    if ref is None:
        ref = RuleReferenceExample(
            rule_id=row.rule_id,
            description_text=desc[:500_000],
            features_json=features_json,
            assigned_class_id=class_id,
        )
        db.add(ref)
        db.flush()
    else:
        ref.assigned_class_id = class_id
        if features_json:
            ref.features_json = features_json
    _upsert_reference_embedding(db, ref)


def _reference_example_to_out(row: RuleReferenceExample) -> ExpertDecisionItemOut:
    """Преобразует импортированный эталон в формат карточки expert decision."""
    rid = str(row.id)
    short = rid.split("-")[0]
    payload: Dict[str, Any] = {
        "source": "dataset_import",
        "origin": "external_source",
        "import_source": "rule_reference_examples",
        "llm_result": {
            "prompt_includes": {
                "description_excerpt": row.description_text,
            }
        },
        "features_json": row.features_json if isinstance(row.features_json, dict) else {},
    }
    return ExpertDecisionItemOut(
        id=f"import-{rid}",
        category="dataset_import",
        rule_id=str(row.rule_id) if row.rule_id else None,
        declaration_id=f"IMPORT-{short}",
        status="resolved",
        summary_ru="Импортирована из внешнего источника (датасет)",
        payload_json=payload,
        resolution_json={
            "chosen_class_id": row.assigned_class_id,
            "source": "dataset_import",
        },
        created_at=row.created_at.isoformat() if row.created_at else "",
        resolved_at=row.created_at.isoformat() if row.created_at else None,
    )


@router.post("", response_model=ExpertDecisionItemOut)
def create_expert_decision(payload: ExpertDecisionCreate, db: Session = Depends(get_db_session)) -> ExpertDecisionItemOut:
    """Создаёт запись очереди решения эксперта; для class_name_confirmation избегает дублей pending."""
    category = payload.category.strip()
    declaration_id = payload.declaration_id.strip()
    rid: Optional[uuid.UUID] = None
    if payload.rule_id and str(payload.rule_id).strip():
        try:
            rid = uuid.UUID(str(payload.rule_id).strip())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Некорректный rule_id") from exc

    if category == "class_name_confirmation":
        # Для одной декларации и правила держим единственную активную задачу подтверждения.
        existing_q = db.query(ExpertDecisionItem).filter(
            ExpertDecisionItem.category == "class_name_confirmation",
            ExpertDecisionItem.declaration_id == declaration_id,
            ExpertDecisionItem.status == "pending",
        )
        if rid is not None:
            existing_q = existing_q.filter(ExpertDecisionItem.rule_id == rid)
        existing = existing_q.order_by(ExpertDecisionItem.created_at.desc()).first()
        if existing is not None:
            return _to_out(existing)

    row = ExpertDecisionItem(
        category=category,
        rule_id=rid,
        declaration_id=declaration_id,
        status="pending",
        summary_ru=(payload.summary_ru or "").strip(),
        payload_json=dict(payload.payload),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.get("", response_model=ExpertDecisionListPageOut)
def list_expert_decisions(
    status: Optional[str] = Query(None, description="pending | resolved | dismissed"),
    category: Optional[str] = Query(None),
    issue_type: Optional[str] = Query(None, description="class_confirmation | auto_classification | classification | inspector_correction | officer_decision"),
    q: Optional[str] = Query(None, description="Поиск по декларации, описанию, коду ТН ВЭД, классу"),
    tnved_prefix: Optional[str] = Query(None, description="Фильтр по ветке ТН ВЭД (префикс кода)"),
    has_class: Optional[bool] = Query(None, description="true = есть класс, false = нет класса"),
    created_from: Optional[str] = Query(None, description="ISO datetime, начало диапазона"),
    created_to: Optional[str] = Query(None, description="ISO datetime, конец диапазона"),
    include_imported: bool = Query(False, description="Добавить импортированные из датасета записи"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    db: Session = Depends(get_db_session),
) -> ExpertDecisionListPageOut:
    """Возвращает страницу задач эксперта с фильтрами и опциональным объединением с импортом."""
    query = db.query(ExpertDecisionItem)
    if status and status.strip():
        query = query.filter(ExpertDecisionItem.status == status.strip())
    if category and category.strip():
        query = query.filter(ExpertDecisionItem.category == category.strip())
    issue_categories: Optional[List[str]] = None
    if issue_type and issue_type.strip():
        issue_categories = ISSUE_TYPE_TO_CATEGORIES.get(issue_type.strip())
        if issue_categories is not None:
            query = query.filter(ExpertDecisionItem.category.in_(issue_categories))

    created_from_dt = _parse_iso_datetime_or_400(created_from, "created_from")
    created_to_dt = _parse_iso_datetime_or_400(created_to, "created_to")
    if created_from_dt is not None:
        query = query.filter(ExpertDecisionItem.created_at >= created_from_dt)
    if created_to_dt is not None:
        query = query.filter(ExpertDecisionItem.created_at <= created_to_dt)

    tnved_code_expr = _json_text_path(
        ExpertDecisionItem.payload_json,
        "llm_result",
        "prompt_includes",
        "tnved_code",
    )
    if tnved_prefix and tnved_prefix.strip():
        prefix = "".join(ch for ch in tnved_prefix if ch.isdigit())
        if prefix:
            query = query.filter(func.replace(func.coalesce(tnved_code_expr, ""), " ", "").like(f"{prefix}%"))

    chosen_class_expr = _json_text_path(ExpertDecisionItem.resolution_json, "chosen_class_id")
    confirmed_class_expr = _json_text_path(ExpertDecisionItem.resolution_json, "confirmed_class_id")
    class_expr = func.coalesce(chosen_class_expr, confirmed_class_expr, "")
    class_exists = func.length(func.trim(class_expr)) > 0
    if has_class is True:
        query = query.filter(class_exists)
    elif has_class is False:
        query = query.filter(~class_exists)

    if q and str(q).strip():
        search = f"%{str(q).strip().lower()}%"
        description_expr = _json_text_path(
            ExpertDecisionItem.payload_json,
            "llm_result",
            "prompt_includes",
            "description_excerpt",
        )
        query = query.filter(
            or_(
                func.lower(ExpertDecisionItem.declaration_id).like(search),
                func.lower(ExpertDecisionItem.summary_ru).like(search),
                func.lower(ExpertDecisionItem.category).like(search),
                func.lower(func.coalesce(tnved_code_expr, "")).like(search),
                func.lower(func.coalesce(description_expr, "")).like(search),
                func.lower(func.coalesce(class_expr, "")).like(search),
            )
        )

    if not include_imported:
        # Быстрый путь: фильтруем и пагинируем только SQL-данные.
        total = query.count()
        offset = (page - 1) * page_size
        rows = query.order_by(ExpertDecisionItem.created_at.desc()).offset(offset).limit(page_size).all()
        return ExpertDecisionListPageOut(
            items=[_to_out(r) for r in rows],
            total=total,
            page=page,
            page_size=page_size,
        )

    items_out: list[ExpertDecisionItemOut] = [_to_out(r) for r in query.order_by(ExpertDecisionItem.created_at.desc()).all()]

    allow_imported_by_status = status is None or not str(status).strip() or str(status).strip() == "resolved"
    allow_imported_by_category = category is None or not str(category).strip() or str(category).strip() == "dataset_import"
    allow_imported_by_issue_type = issue_categories is None
    if allow_imported_by_status and allow_imported_by_category and allow_imported_by_issue_type:
        rq = db.query(RuleReferenceExample)
        if created_from_dt is not None:
            rq = rq.filter(RuleReferenceExample.created_at >= created_from_dt)
        if created_to_dt is not None:
            rq = rq.filter(RuleReferenceExample.created_at <= created_to_dt)
        imported_rows = rq.order_by(RuleReferenceExample.created_at.desc()).all()
        items_out.extend(_reference_example_to_out(r) for r in imported_rows)

    # В смешанном режиме (SQL + импорт) повторяем фильтры в памяти, чтобы поведение было единым.
    if tnved_prefix and tnved_prefix.strip():
        prefix = "".join(ch for ch in tnved_prefix if ch.isdigit())
        if prefix:
            items_out = [x for x in items_out if _item_tnved_code(x).replace(" ", "").startswith(prefix)]
    if q and str(q).strip():
        search = str(q).strip().lower()
        items_out = [
            x
            for x in items_out
            if search in str(x.declaration_id).lower()
            or search in str(x.summary_ru).lower()
            or search in str(x.category).lower()
            or search in _item_tnved_code(x).lower()
            or search in _item_description(x).lower()
            or search in _item_class_value(x).lower()
        ]
    if has_class is True:
        items_out = [x for x in items_out if _item_class_value(x).strip()]
    elif has_class is False:
        items_out = [x for x in items_out if not _item_class_value(x).strip()]

    items_out.sort(key=lambda x: x.created_at, reverse=True)
    total = len(items_out)
    offset = (page - 1) * page_size
    page_items = items_out[offset : offset + page_size]
    return ExpertDecisionListPageOut(items=page_items, total=total, page=page, page_size=page_size)


@router.patch("/{item_id}", response_model=ExpertDecisionItemOut)
def patch_expert_decision(
    item_id: str,
    body: ExpertDecisionPatch,
    db: Session = Depends(get_db_session),
) -> ExpertDecisionItemOut:
    """Изменяет статус/резолюцию задачи эксперта и, при закрытии, синхронизирует эталон."""
    try:
        uid = uuid.UUID(item_id.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Некорректный id") from exc
    row = db.query(ExpertDecisionItem).filter(ExpertDecisionItem.id == uid).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    row.status = body.status
    row.resolution_json = dict(body.resolution) if body.resolution else {}
    if body.status == "pending":
        row.resolved_at = None
    else:
        row.resolved_at = datetime.utcnow()
    if body.status in ("resolved", "dismissed"):
        # При финальном статусе переносим officer-решение в базу эталонных примеров.
        _sync_reference_example_from_officer_decision(db, row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.delete("/{item_id}")
def delete_expert_decision(
    item_id: str,
    db: Session = Depends(get_db_session),
) -> Dict[str, Any]:
    """Удаляет задачу эксперта по id."""
    try:
        uid = uuid.UUID(item_id.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Некорректный id") from exc
    row = db.query(ExpertDecisionItem).filter(ExpertDecisionItem.id == uid).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    db.delete(row)
    db.commit()
    return {"status": "deleted", "id": item_id}


@router.post("/{item_id}/recheck-current-catalog")
def recheck_class_name_decision_with_current_catalog(
    item_id: str,
    db: Session = Depends(get_db_session),
) -> Dict[str, Any]:
    """Переоценивает pending class_name_confirmation по текущей активной версии справочника."""
    try:
        uid = uuid.UUID(item_id.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Некорректный id") from exc

    row = db.query(ExpertDecisionItem).filter(ExpertDecisionItem.id == uid).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Запись не найдена")

    if row.category != "class_name_confirmation":
        raise HTTPException(status_code=400, detail="Операция доступна только для category=class_name_confirmation")

    if row.status != "pending":
        # Уже обработанную запись не переклассифицируем повторно.
        return {
            "status": "skipped",
            "resolved": False,
            "reason": f"Запись уже имеет статус {row.status}",
            "item": _to_out(row).model_dump(),
        }

    if row.rule_id is None:
        return {
            "status": "pending",
            "resolved": False,
            "reason": "Для записи не указан rule_id; переклассификация невозможна.",
            "item": _to_out(row).model_dump(),
        }

    payload = row.payload_json if isinstance(row.payload_json, dict) else {}
    llm_result = payload.get("llm_result") if isinstance(payload, dict) else None
    llm_result = llm_result if isinstance(llm_result, dict) else {}
    suggested = str(llm_result.get("suggested_class_name") or "").strip()
    if not suggested:
        return {
            "status": "pending",
            "resolved": False,
            "reason": "В payload отсутствует suggested_class_name.",
            "item": _to_out(row).model_dump(),
        }

    rv: RuleVersion | None = (
        db.query(RuleVersion)
        .filter(RuleVersion.rule_id == row.rule_id, RuleVersion.is_active.is_(True))
        .order_by(RuleVersion.version.desc())
        .first()
    )
    if rv is None:
        return {
            "status": "pending",
            "resolved": False,
            "reason": "Активная версия справочника не найдена.",
            "item": _to_out(row).model_dump(),
        }

    try:
        dsl = RuleDSL.model_validate(rv.dsl_json)
        compiled = compile_rule(dsl)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Ошибка компиляции актуального справочника: {exc}") from exc

    class_ids: set[str] = set()
    if compiled.classification and compiled.classification.rules:
        for r in compiled.classification.rules:
            cid = (r.class_id or "").strip()
            if cid:
                class_ids.add(cid.lower())

    if suggested.lower() in class_ids:
        # Если имя класса появилось в актуальном справочнике, закрываем задачу автоматически.
        row.status = "resolved"
        row.resolution_json = {
            "confirmed_class_id": suggested,
            "source": "current_catalog_recheck",
            "auto_resolved": True,
        }
        row.resolved_at = datetime.utcnow()
        db.commit()
        db.refresh(row)
        return {
            "status": "resolved",
            "resolved": True,
            "reason": "Имя класса найдено в актуальном справочнике; запись закрыта автоматически.",
            "item": _to_out(row).model_dump(),
        }

    return {
        "status": "pending",
        "resolved": False,
        "reason": "По актуальному справочнику декларация всё ещё требует решения эксперта.",
        "item": _to_out(row).model_dump(),
    }
