from __future__ import annotations

from typing import Any, Dict, List, Protocol


class SemanticSearchPort(Protocol):
    """Порт внешнего сервиса семантического поиска."""

    def embed_texts(self, texts: List[str]) -> Dict[str, Any]:
        ...

