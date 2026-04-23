"""Переключаемый бэкенд LLM: Ollama или vLLM (OpenAI-compatible)."""

from .compat import (
    ollama_generate,
    ollama_generate_simple,
    ollama_list_models,
)
from .config import (
    is_vllm,
    llm_backend,
    runtime_base_url,
)

__all__ = [
    "ollama_generate",
    "ollama_generate_simple",
    "ollama_list_models",
    "is_vllm",
    "llm_backend",
    "runtime_base_url",
]
