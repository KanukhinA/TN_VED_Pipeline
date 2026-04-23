"""Фасад: те же имена функций, что у старого ollama_client; маршрутизация по LLM_BACKEND."""

from __future__ import annotations

from typing import Any

from . import config
from . import ollama_backend
from . import vllm_backend


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
    if config.is_vllm():
        return vllm_backend.vllm_completions_generate(
            model,
            prompt,
            num_ctx=num_ctx,
            num_predict=num_predict,
            repeat_penalty=repeat_penalty,
            temperature=temperature,
            top_p=top_p,
            enable_thinking=enable_thinking,
            timeout=timeout,
        )
    return ollama_backend.ollama_generate(
        model,
        prompt,
        num_ctx=num_ctx,
        num_predict=num_predict,
        repeat_penalty=repeat_penalty,
        temperature=temperature,
        top_p=top_p,
        enable_thinking=enable_thinking,
        timeout=timeout,
    )


def ollama_generate_simple(
    model: str,
    prompt: str,
    *,
    num_ctx: int = 4096,
    num_predict: int = 128,
    temperature: float = 0.0,
    timeout: float = 120.0,
) -> dict[str, Any]:
    if config.is_vllm():
        return vllm_backend.vllm_generate_simple(
            model,
            prompt,
            num_ctx=num_ctx,
            num_predict=num_predict,
            temperature=temperature,
            timeout=timeout,
        )
    return ollama_backend.ollama_generate_simple(
        model,
        prompt,
        num_ctx=num_ctx,
        num_predict=num_predict,
        temperature=temperature,
        timeout=timeout,
    )


def ollama_list_models(timeout: float = 20.0) -> list[str]:
    if config.is_vllm():
        return vllm_backend.vllm_list_models(timeout=timeout)
    return ollama_backend.ollama_list_models(timeout=timeout)
