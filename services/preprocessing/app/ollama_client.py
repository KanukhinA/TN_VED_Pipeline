"""HTTP-клиент к Ollama (/api/generate). do_sample=false соответствует temperature=0."""

from __future__ import annotations

import os
from typing import Any

import httpx

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")


def ollama_generate(
    model: str,
    prompt: str,
    *,
    num_ctx: int = 8192,
    num_predict: int = 3904,
    repeat_penalty: float = 1.0,
    temperature: float = 0.0,
    top_p: float | None = None,
    enable_thinking: bool = False,
    timeout: float = 600.0,
) -> dict[str, Any]:
    url = f"{OLLAMA_BASE_URL}/api/generate"
    options: dict[str, Any] = {
        "num_ctx": int(num_ctx),
        "num_predict": int(num_predict),
        "repeat_penalty": float(repeat_penalty),
        "temperature": float(temperature),
    }
    if top_p is not None:
        options["top_p"] = float(top_p)
    if enable_thinking:
        options["thinking"] = True

    body: dict[str, Any] = {
        "model": model.strip(),
        "prompt": prompt,
        "stream": False,
        "options": options,
    }

    with httpx.Client(timeout=timeout) as client:
        r = client.post(url, json=body)
        r.raise_for_status()
        data = r.json()

    text = (data.get("response") or "").strip()
    return {
        "raw_response": text,
        "model": model,
        "done": data.get("done"),
        "total_duration_ns": data.get("total_duration"),
        "eval_count": data.get("eval_count"),
        "ollama_base_url": OLLAMA_BASE_URL,
    }
