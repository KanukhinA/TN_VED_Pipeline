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

from app.semantic_cleaning import DEFAULT_SEMANTIC_CLEANING_PROMPT

CODE_DEFAULT: dict[str, Any] = {
    "semantic_similarity_threshold": 0.75,
    "semantic_neighbor_similarity_floor_s0": 0.35,
    "semantic_neighbor_weight_gamma": 2.0,
    "semantic_support_threshold_tau2": 0.55,
    "semantic_cleaning_prompt": DEFAULT_SEMANTIC_CLEANING_PROMPT,
    "semantic_cleaning_num_ctx": 8192,
    "semantic_cleaning_max_new_tokens": 1024,
    "semantic_cleaning_repetition_penalty": 1.0,
    "semantic_cleaning_temperature": 0.0,
    "semantic_cleaning_top_p": 1.0,
    "semantic_cleaning_enable_thinking": False,
    "semantic_cleaning_constrained_decoding": True,
    "semantic_cleaning_do_sample": False,
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
    try:
        s0 = float(out["semantic_neighbor_similarity_floor_s0"])
        out["semantic_neighbor_similarity_floor_s0"] = max(-1.0, min(s0, 1.0))
    except (TypeError, ValueError):
        out["semantic_neighbor_similarity_floor_s0"] = CODE_DEFAULT["semantic_neighbor_similarity_floor_s0"]
    try:
        tau2 = float(out["semantic_support_threshold_tau2"])
        out["semantic_support_threshold_tau2"] = max(0.0, min(tau2, 1.0))
    except (TypeError, ValueError):
        out["semantic_support_threshold_tau2"] = CODE_DEFAULT["semantic_support_threshold_tau2"]
    try:
        gamma = float(out["semantic_neighbor_weight_gamma"])
        out["semantic_neighbor_weight_gamma"] = max(1.0, min(gamma, 32.0))
    except (TypeError, ValueError):
        out["semantic_neighbor_weight_gamma"] = CODE_DEFAULT["semantic_neighbor_weight_gamma"]
    out["semantic_cleaning_prompt"] = str(out.get("semantic_cleaning_prompt") or CODE_DEFAULT["semantic_cleaning_prompt"]).strip()
    try:
        out["semantic_cleaning_num_ctx"] = max(256, min(int(out.get("semantic_cleaning_num_ctx")), 65536))
    except (TypeError, ValueError):
        out["semantic_cleaning_num_ctx"] = CODE_DEFAULT["semantic_cleaning_num_ctx"]
    try:
        out["semantic_cleaning_max_new_tokens"] = max(32, min(int(out.get("semantic_cleaning_max_new_tokens")), 8192))
    except (TypeError, ValueError):
        out["semantic_cleaning_max_new_tokens"] = CODE_DEFAULT["semantic_cleaning_max_new_tokens"]
    try:
        rp = float(out.get("semantic_cleaning_repetition_penalty"))
        out["semantic_cleaning_repetition_penalty"] = max(0.5, min(rp, 2.0))
    except (TypeError, ValueError):
        out["semantic_cleaning_repetition_penalty"] = CODE_DEFAULT["semantic_cleaning_repetition_penalty"]
    try:
        temp = float(out.get("semantic_cleaning_temperature"))
        out["semantic_cleaning_temperature"] = max(0.0, min(temp, 2.0))
    except (TypeError, ValueError):
        out["semantic_cleaning_temperature"] = CODE_DEFAULT["semantic_cleaning_temperature"]
    try:
        top_p = float(out.get("semantic_cleaning_top_p"))
        out["semantic_cleaning_top_p"] = max(0.0, min(top_p, 1.0))
    except (TypeError, ValueError):
        out["semantic_cleaning_top_p"] = CODE_DEFAULT["semantic_cleaning_top_p"]
    out["semantic_cleaning_enable_thinking"] = bool(out.get("semantic_cleaning_enable_thinking", CODE_DEFAULT["semantic_cleaning_enable_thinking"]))
    out["semantic_cleaning_constrained_decoding"] = bool(
        out.get("semantic_cleaning_constrained_decoding", CODE_DEFAULT["semantic_cleaning_constrained_decoding"])
    )
    out["semantic_cleaning_do_sample"] = bool(out.get("semantic_cleaning_do_sample", CODE_DEFAULT["semantic_cleaning_do_sample"]))
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
