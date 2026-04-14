from __future__ import annotations

import os
from typing import Any

import httpx

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")


def ollama_generate_simple(
    model: str,
    prompt: str,
    *,
    num_ctx: int = 4096,
    num_predict: int = 128,
    temperature: float = 0.0,
    timeout: float = 120.0,
) -> dict[str, Any]:
    url = f"{OLLAMA_BASE_URL}/api/generate"
    body: dict[str, Any] = {
        "model": model.strip(),
        "prompt": prompt,
        "stream": False,
        "options": {
            "num_ctx": num_ctx,
            "num_predict": num_predict,
            "temperature": temperature,
        },
    }
    with httpx.Client(timeout=timeout) as client:
        r = client.post(url, json=body)
        r.raise_for_status()
        return r.json()
