"""
Проверка блока meta.feature_extraction_configs в машиночитаемом описании справочника.

Согласованность конфигураций промптов для модуля извлечения признаков LLM (вкладка
«Настройка справочников») перед сохранением в PostgreSQL. PutFeatureExtractionSettingsUseCase.
"""

from __future__ import annotations

from typing import Any


def _cfg_feature_extraction_primary(item: dict) -> bool:
    v = item.get("feature_extraction_primary")
    return v is True or v == "true"


def _models_shared_across_feature_configs(cfgs: list) -> bool:
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


def validate_feature_extraction_configs(meta: Any) -> None:
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
        raise ValueError(
            "В meta.feature_extraction_configs может быть только одна конфигурация с feature_extraction_primary=true."
        )
    shared = _models_shared_across_feature_configs(cfgs)
    if shared and len(primary_cfgs) != 1:
        raise ValueError(
            "Одна и та же модель отмечена в нескольких конфигурациях извлечения признаков. "
            "Укажите ровно одну конфигурацию как основную (feature_extraction_primary)."
        )
