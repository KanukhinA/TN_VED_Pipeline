"""Чтение pipeline.json (тот же файл, что у api-gateway при монтировании в compose)."""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_THRESHOLD = 0.75


def pipeline_config_path() -> Path:
    raw = os.getenv("PIPELINE_CONFIG_PATH", "").strip()
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parent.parent / "config" / "pipeline.json"


def load_semantic_similarity_threshold() -> float:
    path = pipeline_config_path()
    if not path.is_file():
        try:
            return float(os.getenv("SEMANTIC_SIMILARITY_THRESHOLD", str(DEFAULT_THRESHOLD)))
        except (TypeError, ValueError):
            return DEFAULT_THRESHOLD
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and "semantic_similarity_threshold" in raw:
            return max(0.0, min(float(raw["semantic_similarity_threshold"]), 1.0))
    except Exception:
        pass
    try:
        return float(os.getenv("SEMANTIC_SIMILARITY_THRESHOLD", str(DEFAULT_THRESHOLD)))
    except (TypeError, ValueError):
        return DEFAULT_THRESHOLD
