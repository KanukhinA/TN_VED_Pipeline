"""Прямой HTTP-клиент к Ollama (/api/chat для генерации, /api/tags).

Генерация идёт через ``/api/chat``, а не ``/api/generate``: у моделей с цепочкой
мышления (Qwen3 и др.) в ``/api/generate`` отключение thinking в ``options`` не
срабатывает, все токены уходят в скрытый trace, поле ``response`` остаётся
пустым при ``eval_count == num_predict``. См. ollama/ollama#14793.
"""

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
    response_format: dict[str, Any] | None = None,
    timeout: float = 600.0,
) -> dict[str, Any]:
    base = ollama_base_url()
    url = f"{base}/api/chat"
    options: dict[str, Any] = {
        "num_ctx": int(num_ctx),
        "num_predict": int(num_predict),
        "repeat_penalty": float(repeat_penalty),
        "temperature": float(temperature),
    }
    if top_p is not None:
        options["top_p"] = float(top_p)

    body: dict[str, Any] = {
        "model": model.strip(),
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "think": bool(enable_thinking),
        "options": options,
    }
    if response_format is not None:
        body["format"] = response_format

    with httpx.Client(timeout=timeout) as client:
        r = client.post(url, json=body)
        r.raise_for_status()
        data = r.json()

    msg = data.get("message")
    if not isinstance(msg, dict):
        msg = {}
    text = (msg.get("content") or "").strip()
    thinking = msg.get("thinking")
    thinking_s = thinking.strip() if isinstance(thinking, str) else ""

    out: dict[str, Any] = {
        "raw_response": text,
        "model": model,
        "done": data.get("done"),
        "total_duration_ns": data.get("total_duration"),
        "eval_count": data.get("eval_count"),
        "ollama_base_url": base,
    }
    if not text and thinking_s:
        out["ollama_thinking_excerpt"] = thinking_s[:4000]
    return out


def ollama_generate_simple(
    model: str,
    prompt: str,
    *,
    num_ctx: int = 4096,
    num_predict: int = 128,
    temperature: float = 0.0,
    timeout: float = 120.0,
) -> dict[str, Any]:
    """Ответ в форме, совместимой с ``/api/generate``: есть ключ ``response``."""
    base = ollama_base_url()
    url = f"{base}/api/chat"
    body: dict[str, Any] = {
        "model": model.strip(),
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "think": False,
        "options": {
            "num_ctx": num_ctx,
            "num_predict": num_predict,
            "temperature": temperature,
        },
    }
    with httpx.Client(timeout=timeout) as client:
        r = client.post(url, json=body)
        r.raise_for_status()
        data = r.json()

    msg = data.get("message")
    if not isinstance(msg, dict):
        msg = {}
    content = str(msg.get("content") or "")
    return {
        "model": str(data.get("model") or model).strip(),
        "created_at": data.get("created_at"),
        "response": content,
        "done": data.get("done", True),
        "total_duration": data.get("total_duration"),
        "load_duration": data.get("load_duration"),
        "prompt_eval_count": data.get("prompt_eval_count"),
        "eval_count": data.get("eval_count"),
        "ollama_base_url": base,
    }


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
