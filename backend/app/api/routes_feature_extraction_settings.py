from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..db.models import AppSetting, FewShotAssistRun, Rule
from ..db.session import get_db_session
from ..primary_catalog_settings import get_effective_primary_catalog_map, validate_and_save_primary_catalog_map

router = APIRouter(prefix="/api/feature-extraction", tags=["feature-extraction-settings"])

SETTINGS_KEY = "feature_extraction_model_settings_v1"

DEFAULT_MODEL_SETTINGS: Dict[str, Any] = {
    "models": {
        "gemma2:2b-instruct-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "qwen2.5:3b-instruct-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "qwen3:4b-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "qwen3:8b-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "qwen3:14b-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "gemma3:4b-it-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "codegemma:7b-instruct-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "gemma3:12b-it-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "ministral-3:8b-instruct-2512-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "ministral-3:14b-instruct-2512-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "ministral-3:3b-instruct-2512-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "forzer/GigaChat3-10B-A1.8B": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
        "gigachat-20b-a3b-instruct-v1.5:q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        },
    },
}


class ModelRuntimeSettingsPayload(BaseModel):
    models: dict[str, dict[str, Any]] = Field(default_factory=dict)
    model_config = ConfigDict(extra="ignore")


def _normalize_settings(payload: Dict[str, Any]) -> Dict[str, Any]:
    models = payload.get("models")
    if not isinstance(models, dict):
        models = {}
    return {"models": models}


@router.get("/model-settings")
def get_feature_extraction_model_settings(db: Session = Depends(get_db_session)) -> Dict[str, Any]:
    row: AppSetting | None = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).one_or_none()
    if not row:
        return dict(DEFAULT_MODEL_SETTINGS)
    return _normalize_settings(row.value_json)


@router.put("/model-settings")
def put_feature_extraction_model_settings(
    payload: ModelRuntimeSettingsPayload, db: Session = Depends(get_db_session)
) -> Dict[str, Any]:
    normalized = _normalize_settings(payload.model_dump())
    row: AppSetting | None = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).one_or_none()
    if row is None:
        row = AppSetting(key=SETTINGS_KEY, value_json=normalized, updated_at=datetime.utcnow())
        db.add(row)
    else:
        row.value_json = normalized
        row.updated_at = datetime.utcnow()
    db.commit()
    return normalized


class PrimaryCatalogSettingsPayload(BaseModel):
    """Ключ — код группы ТН ВЭД (как в meta.tn_ved_group_code), значение — rule_id основного справочника."""

    by_group_code: dict[str, Optional[str]] = Field(default_factory=dict)
    model_config = ConfigDict(extra="ignore")


@router.get("/primary-catalog-settings")
def get_primary_catalog_settings(db: Session = Depends(get_db_session)) -> Dict[str, Any]:
    return {"by_group_code": get_effective_primary_catalog_map(db)}


@router.put("/primary-catalog-settings")
def put_primary_catalog_settings(
    payload: PrimaryCatalogSettingsPayload, db: Session = Depends(get_db_session)
) -> Dict[str, Any]:
    try:
        normalized = validate_and_save_primary_catalog_map(db, dict(payload.by_group_code))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"by_group_code": normalized}


class FewShotAssistRunCreate(BaseModel):
    rule_id: str
    result: Dict[str, Any] = Field(default_factory=dict)
    model_config = ConfigDict(extra="ignore")


def _parse_rule_id(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(raw).strip())
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail="Некорректный rule_id") from exc


@router.post("/few-shot-runs")
def create_few_shot_assist_run(
    payload: FewShotAssistRunCreate, db: Session = Depends(get_db_session)
) -> Dict[str, Any]:
    rid = _parse_rule_id(payload.rule_id)
    rule: Rule | None = db.query(Rule).filter(Rule.id == rid).one_or_none()
    if rule is None:
        raise HTTPException(status_code=404, detail="Справочник не найден")
    if not isinstance(payload.result, dict):
        raise HTTPException(status_code=400, detail="Поле result должно быть объектом")
    row = FewShotAssistRun(rule_id=rid, result_json=dict(payload.result))
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "id": str(row.id),
        "rule_id": str(row.rule_id),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "result": row.result_json,
    }


@router.get("/few-shot-runs")
def list_few_shot_assist_runs(
    rule_id: str = Query(..., description="UUID справочника"),
    db: Session = Depends(get_db_session),
) -> Dict[str, Any]:
    rid = _parse_rule_id(rule_id)
    if db.query(Rule).filter(Rule.id == rid).one_or_none() is None:
        raise HTTPException(status_code=404, detail="Справочник не найден")
    rows = (
        db.query(FewShotAssistRun)
        .filter(FewShotAssistRun.rule_id == rid)
        .order_by(FewShotAssistRun.created_at.desc())
        .all()
    )
    return {
        "runs": [
            {
                "id": str(r.id),
                "rule_id": str(r.rule_id),
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "result": r.result_json,
            }
            for r in rows
        ]
    }


@router.delete("/few-shot-runs/{run_id}")
def delete_few_shot_assist_run(
    run_id: str,
    db: Session = Depends(get_db_session),
) -> Dict[str, str]:
    uid = _parse_rule_id(run_id)
    row: FewShotAssistRun | None = db.query(FewShotAssistRun).filter(FewShotAssistRun.id == uid).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    db.delete(row)
    db.commit()
    return {"status": "ok"}
