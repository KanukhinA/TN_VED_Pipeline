"""
Контракт микросервиса семантического поиска (sentence-transformers, эталоны справочника).

Движок правил не вычисляет эмбеддинги сам: запрашивает векторные представления текстов
эталонов и сопоставление с полным описанием декларации при officer-пайплайне и дозаполнении
кэша в PostgreSQL. Реализация — HttpSemanticSearchClient.
"""

from __future__ import annotations

from typing import Any, Dict, List, Protocol


class SemanticSearchPort(Protocol):

    def embed_texts(self, texts: List[str]) -> Dict[str, Any]:
        ...

