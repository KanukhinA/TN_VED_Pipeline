"""Обратная совместимость: те же имена; фактический бэкенд — Ollama или vLLM (LLM_BACKEND)."""

from __future__ import annotations

from shared.llm_runtime.compat import ollama_generate_simple, ollama_list_models
from shared.llm_runtime.config import runtime_base_url

OLLAMA_BASE_URL = runtime_base_url()

__all__ = ["OLLAMA_BASE_URL", "ollama_generate_simple", "ollama_list_models"]
