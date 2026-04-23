from __future__ import annotations

import os
from typing import Literal

LLMBackend = Literal["ollama", "vllm"]


def llm_backend() -> LLMBackend:
    raw = (os.getenv("LLM_BACKEND") or "ollama").strip().lower()
    if raw in ("vllm", "v-llm"):
        return "vllm"
    return "ollama"


def is_vllm() -> bool:
    return llm_backend() == "vllm"


def ollama_base_url() -> str:
    return (os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").rstrip("/")


def vllm_base_url() -> str:
    return (os.getenv("VLLM_BASE_URL") or "http://127.0.0.1:8000").rstrip("/")


def runtime_base_url() -> str:
    return vllm_base_url() if is_vllm() else ollama_base_url()
