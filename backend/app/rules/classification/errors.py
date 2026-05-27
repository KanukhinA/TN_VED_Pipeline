"""
Ошибки правило-ориентированной классификации для ответа API.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel


class ClassificationError(BaseModel):
    """Структурированная ошибка классификации для ответа API."""

    message: str
    details: Optional[Dict[str, Any]] = None
