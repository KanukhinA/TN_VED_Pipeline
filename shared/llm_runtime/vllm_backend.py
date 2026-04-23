"""HTTP-клиент к vLLM через OpenAI-compatible API (/v1/completions, /v1/models).

Имена моделей — как на стороне сервера vLLM (часто HuggingFace id), не теги Ollama.
"""

from __future__ import annotations

from typing import Any

import httpx

from .config import vllm_base_url


def vllm_completions_generate(
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
    """Эквивалент ollama_generate: один нестриминговый ответ и те же ключи ответа."""
    del num_ctx, repeat_penalty, enable_thinking
    base = vllm_base_url()
    url = f"{base}/v1/completions"
    max_tokens = max(1, int(num_predict))
    body: dict[str, Any] = {
        "model": model.strip(),
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": float(temperature),
        "stream": False,
    }
    if top_p is not None:
        body["top_p"] = float(top_p)

    with httpx.Client(timeout=timeout) as client:
        r = client.post(url, json=body)
        r.raise_for_status()
        data = r.json()

    text = ""
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        ch0 = choices[0]
        if isinstance(ch0, dict):
            text = str(ch0.get("text") or "").strip()

    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    completion_tokens = usage.get("completion_tokens") if isinstance(usage, dict) else None

    return {
        "raw_response": text,
        "model": model,
        "done": True,
        "total_duration_ns": None,
        "eval_count": completion_tokens,
        "ollama_base_url": base,
    }


def vllm_generate_simple(
    model: str,
    prompt: str,
    *,
    num_ctx: int = 4096,
    num_predict: int = 128,
    temperature: float = 0.0,
    timeout: float = 120.0,
) -> dict[str, Any]:
    """Формат как у Ollama /api/generate: есть ключ response."""
    out = vllm_completions_generate(
        model,
        prompt,
        num_ctx=num_ctx,
        num_predict=num_predict,
        temperature=temperature,
        timeout=timeout,
    )
    return {
        "model": model,
        "response": out.get("raw_response") or "",
        "done": True,
        "ollama_base_url": out.get("ollama_base_url"),
    }


def vllm_list_models(timeout: float = 20.0) -> list[str]:
    base = vllm_base_url()
    url = f"{base}/v1/models"
    with httpx.Client(timeout=timeout) as client:
        r = client.get(url)
        r.raise_for_status()
        data = r.json()
    rows = data.get("data")
    if not isinstance(rows, list):
        return []
    out: list[str] = []
    for row in rows:
        if isinstance(row, dict):
            mid = str(row.get("id") or "").strip()
            if mid:
                out.append(mid)
    return out
