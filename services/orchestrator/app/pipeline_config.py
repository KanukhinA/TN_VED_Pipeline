"""Чтение pipeline.json (тот же файл, что у api-gateway при монтировании в compose)."""

from __future__ import annotations

import json
import os
from pathlib import Path

from app.semantic_cleaning import DEFAULT_SEMANTIC_CLEANING_PROMPT

DEFAULT_THRESHOLD = 0.75
DEFAULT_NEIGHBOR_FLOOR_S0 = 0.35
DEFAULT_NEIGHBOR_WEIGHT_GAMMA = 2.0
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


def load_semantic_neighbor_weight_gamma() -> float:
    raw = _load_pipeline_dict()
    if "semantic_neighbor_weight_gamma" in raw:
        try:
            return max(1.0, min(float(raw["semantic_neighbor_weight_gamma"]), 32.0))
        except (TypeError, ValueError):
            pass
    try:
        return float(os.getenv("SEMANTIC_NEIGHBOR_WEIGHT_GAMMA", str(DEFAULT_NEIGHBOR_WEIGHT_GAMMA)))
    except (TypeError, ValueError):
        return DEFAULT_NEIGHBOR_WEIGHT_GAMMA


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


def load_semantic_cleaning_settings() -> dict[str, object]:
    raw = _load_pipeline_dict()
    prompt = str(raw.get("semantic_cleaning_prompt") or DEFAULT_SEMANTIC_CLEANING_PROMPT).strip()

    def _int_val(key: str, default: int, lo: int, hi: int) -> int:
        try:
            return max(lo, min(int(raw.get(key, default)), hi))
        except (TypeError, ValueError):
            return default

    def _float_val(key: str, default: float, lo: float, hi: float) -> float:
        try:
            return max(lo, min(float(raw.get(key, default)), hi))
        except (TypeError, ValueError):
            return default

    return {
        "model": "",
        "prompt": prompt,
        "num_ctx": _int_val("semantic_cleaning_num_ctx", 8192, 256, 65536),
        "max_new_tokens": _int_val("semantic_cleaning_max_new_tokens", 1024, 32, 8192),
        "repetition_penalty": _float_val("semantic_cleaning_repetition_penalty", 1.0, 0.5, 2.0),
        "temperature": _float_val("semantic_cleaning_temperature", 0.0, 0.0, 2.0),
        "top_p": _float_val("semantic_cleaning_top_p", 1.0, 0.0, 1.0),
        "enable_thinking": bool(raw.get("semantic_cleaning_enable_thinking", False)),
        "constrained_decoding": bool(raw.get("semantic_cleaning_constrained_decoding", True)),
        "do_sample": bool(raw.get("semantic_cleaning_do_sample", False)),
    }
