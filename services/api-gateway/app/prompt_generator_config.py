"""
Параметры вызова Ollama для POST /api/feature-extraction/generate-prompt.

Читаются из JSON (путь: PROMPT_GENERATOR_CONFIG_PATH или config/prompt_generator.json рядом с сервисом).
Файл перечитывается при каждом запросе — правки применяются без перезапуска контейнера.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

CODE_DEFAULT: dict[str, Any] = {
    "num_ctx": 8192,
    "max_new_tokens": 3904,
    "temperature": 0.22,
    "repetition_penalty": 1.0,
    "top_p": None,
    "enable_thinking": False,
}

ALLOWED_KEYS = frozenset(CODE_DEFAULT.keys())


def prompt_generator_config_path() -> Path:
    raw = os.getenv("PROMPT_GENERATOR_CONFIG_PATH", "").strip()
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parent.parent / "config" / "prompt_generator.json"


def load_prompt_generator_file() -> dict[str, Any]:
    path = prompt_generator_config_path()
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
        out["num_ctx"] = max(256, min(int(out["num_ctx"]), 131072))
    except (TypeError, ValueError):
        out["num_ctx"] = CODE_DEFAULT["num_ctx"]
    try:
        out["max_new_tokens"] = max(32, min(int(out["max_new_tokens"]), 65536))
    except (TypeError, ValueError):
        out["max_new_tokens"] = CODE_DEFAULT["max_new_tokens"]
    try:
        out["temperature"] = max(0.0, min(float(out["temperature"]), 2.0))
    except (TypeError, ValueError):
        out["temperature"] = CODE_DEFAULT["temperature"]
    try:
        out["repetition_penalty"] = max(0.5, min(float(out["repetition_penalty"]), 2.0))
    except (TypeError, ValueError):
        out["repetition_penalty"] = CODE_DEFAULT["repetition_penalty"]
    tp = out.get("top_p")
    if tp is None:
        out["top_p"] = None
    else:
        try:
            out["top_p"] = max(0.0, min(float(tp), 1.0))
        except (TypeError, ValueError):
            out["top_p"] = None
    out["enable_thinking"] = bool(out.get("enable_thinking"))
    return out


def effective_prompt_generator_params(overrides_from_request: dict[str, Any] | None) -> dict[str, Any]:
    """
    CODE_DEFAULT <- файл prompt_generator.json <- явные поля из тела запроса (exclude_unset).
    """
    merged: dict[str, Any] = {**CODE_DEFAULT, **load_prompt_generator_file()}
    if overrides_from_request:
        for k, v in overrides_from_request.items():
            if k in ALLOWED_KEYS:
                merged[k] = v
    return _clamp_config(merged)
