"""Обратная совместимость: реэкспорт из shared.llm_runtime (Ollama или vLLM по LLM_BACKEND)."""

from __future__ import annotations

from shared.llm_runtime.compat import ollama_generate
from shared.llm_runtime.config import runtime_base_url

OLLAMA_BASE_URL = runtime_base_url()

__all__ = ["OLLAMA_BASE_URL", "ollama_generate"]
