"""
Порог семантической схожести и параметры пайплайна (README mermaid: SimCheck).

Файл перечитывается при каждом запросе — правки без перезапуска контейнера.
Путь: PIPELINE_CONFIG_PATH или config/pipeline.json рядом с сервисом.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

CODE_DEFAULT: dict[str, Any] = {
    "semantic_similarity_threshold": 0.75,
}

ALLOWED_KEYS = frozenset(CODE_DEFAULT.keys())


def pipeline_config_path() -> Path:
    raw = os.getenv("PIPELINE_CONFIG_PATH", "").strip()
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parent.parent / "config" / "pipeline.json"


def load_pipeline_file() -> dict[str, Any]:
    path = pipeline_config_path()
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {}
        return {k: v for k, v in raw.items() if k in ALLOWED_KEYS}
    except Exception:
        return {}


def _clamp_config(merged: dict[str, Any]) -> dict[str, Any]:
    out = dict(merged)
    try:
        t = float(out["semantic_similarity_threshold"])
        out["semantic_similarity_threshold"] = max(0.0, min(t, 1.0))
    except (TypeError, ValueError):
        out["semantic_similarity_threshold"] = CODE_DEFAULT["semantic_similarity_threshold"]
    return out


def effective_pipeline_params(overrides: dict[str, Any] | None) -> dict[str, Any]:
    merged = {**CODE_DEFAULT, **load_pipeline_file()}
    if overrides:
        for k, v in overrides.items():
            if k in ALLOWED_KEYS:
                merged[k] = v
    return _clamp_config(merged)


def save_pipeline_file(params: dict[str, Any]) -> dict[str, Any]:
    path = pipeline_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    clamped = _clamp_config({**CODE_DEFAULT, **{k: v for k, v in params.items() if k in ALLOWED_KEYS}})
    path.write_text(json.dumps(clamped, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return clamped
