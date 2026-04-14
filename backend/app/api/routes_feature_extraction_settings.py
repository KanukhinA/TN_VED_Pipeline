from __future__ import annotations

from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..db.models import AppSetting
from ..db.session import get_db_session

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
