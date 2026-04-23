"""Прямой HTTP-клиент к Ollama (/api/generate, /api/tags)."""

from __future__ import annotations

from typing import Any

import httpx

from .config import ollama_base_url


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
    base = ollama_base_url()
    url = f"{base}/api/generate"
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
        "ollama_base_url": base,
    }


def ollama_generate_simple(
    model: str,
    prompt: str,
    *,
    num_ctx: int = 4096,
    num_predict: int = 128,
    temperature: float = 0.0,
    timeout: float = 120.0,
) -> dict[str, Any]:
    base = ollama_base_url()
    url = f"{base}/api/generate"
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


def ollama_list_models(timeout: float = 20.0) -> list[str]:
    base = ollama_base_url()
    url = f"{base}/api/tags"
    with httpx.Client(timeout=timeout) as client:
        r = client.get(url)
        r.raise_for_status()
        data = r.json()
    models = data.get("models")
    if not isinstance(models, list):
        return []
    out: list[str] = []
    for row in models:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if name:
            out.append(name)
    return out
