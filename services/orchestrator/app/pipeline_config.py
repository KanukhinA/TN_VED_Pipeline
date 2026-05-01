"""Чтение pipeline.json (тот же файл, что у api-gateway при монтировании в compose)."""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_THRESHOLD = 0.75
DEFAULT_NEIGHBOR_FLOOR_S0 = 0.35
DEFAULT_SUPPORT_THRESHOLD_TAU2 = 0.55


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


def _load_pipeline_dict() -> dict:
    path = pipeline_config_path()
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            return raw
    except Exception:
        pass
    return {}


def load_semantic_neighbor_similarity_floor_s0() -> float:
    raw = _load_pipeline_dict()
    if "semantic_neighbor_similarity_floor_s0" in raw:
        try:
            return max(-1.0, min(float(raw["semantic_neighbor_similarity_floor_s0"]), 1.0))
        except (TypeError, ValueError):
            pass
    try:
        return float(os.getenv("SEMANTIC_NEIGHBOR_SIMILARITY_FLOOR_S0", str(DEFAULT_NEIGHBOR_FLOOR_S0)))
    except (TypeError, ValueError):
        return DEFAULT_NEIGHBOR_FLOOR_S0


def load_semantic_support_threshold_tau2() -> float:
    raw = _load_pipeline_dict()
    if "semantic_support_threshold_tau2" in raw:
        try:
            return max(0.0, min(float(raw["semantic_support_threshold_tau2"]), 1.0))
        except (TypeError, ValueError):
            pass
    try:
        return float(os.getenv("SEMANTIC_SUPPORT_THRESHOLD_TAU2", str(DEFAULT_SUPPORT_THRESHOLD_TAU2)))
    except (TypeError, ValueError):
        return DEFAULT_SUPPORT_THRESHOLD_TAU2
