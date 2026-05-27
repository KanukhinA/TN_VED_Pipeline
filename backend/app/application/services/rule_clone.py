"""
Дублирование справочника в каталоге: имя копии и уникальный model_id.

CloneRuleUseCase при операции клонирования из интерфейса эксперта.
"""

from __future__ import annotations

import uuid
from typing import Optional

from ..ports.repositories import RuleCatalogRepositoryPort


def clone_copy_name(base_name: Optional[str]) -> str:
    base = (base_name or "").strip()
    if not base:
        return "Справочник (копия)"
    if base.endswith("(копия)"):
        return base
    return f"{base} (копия)"


def make_unique_clone_model_id(repo: RuleCatalogRepositoryPort, source_model_id: str) -> str:
    src = source_model_id.strip() or "spravochnik"
    candidate = f"{src}_{uuid.uuid4().hex[:8]}"
    while repo.model_id_exists(candidate):
        candidate = f"{src}_{uuid.uuid4().hex[:8]}"
    return candidate
