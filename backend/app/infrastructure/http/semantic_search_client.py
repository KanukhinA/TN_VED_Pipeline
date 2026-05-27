"""
HTTP-вызов микросервиса семантического поиска (SemanticSearchPort).

Построение эмбеддингов эталонов и сопоставление с полным описанием декларации; SEMANTIC_SEARCH_URL.
Используется officer-пайплайном и дозаполнением векторов в PostgreSQL. sentence-transformers
выполняется в отдельном контейнере, не в движке правил.
"""

from __future__ import annotations

from typing import Any, Dict, List

import httpx


class HttpSemanticSearchClient:
    """Тонкий HTTP-адаптер semantic-search для портового слоя."""

    def __init__(self, base_url: str, timeout: float = 25.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def embed_texts(self, texts: List[str]) -> Dict[str, Any]:
        """Запрашивает эмбеддинги списка текстов через `/api/v1/embed`."""
        with httpx.Client(timeout=self.timeout) as client:
            resp = client.post(f"{self.base_url}/api/v1/embed", json={"texts": texts})
            resp.raise_for_status()
            return resp.json()

