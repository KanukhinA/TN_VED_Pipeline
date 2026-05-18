from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional
import uuid

from ...db.models import ExpertDecisionItem
from ..ports.repositories import ExpertDecisionRepositoryPort


@dataclass
class ListExpertDecisionsCommand:
    status: Optional[str]
    category: Optional[str]
    page: int
    page_size: int


class ListExpertDecisionsUseCase:
    """Сценарий получения страницы expert-decision записей."""

    def __init__(self, repo: ExpertDecisionRepositoryPort) -> None:
        self._repo = repo

    def execute(self, cmd: ListExpertDecisionsCommand) -> tuple[list[ExpertDecisionItem], int]:
        return self._repo.list_page(
            status=cmd.status,
            category=cmd.category,
            page=cmd.page,
            page_size=cmd.page_size,
        )


@dataclass
class PatchExpertDecisionCommand:
    item_id: str
    status: str
    resolution: dict[str, Any]


class PatchExpertDecisionUseCase:
    """Сценарий смены статуса/резолюции expert-decision записи."""

    def __init__(self, repo: ExpertDecisionRepositoryPort) -> None:
        self._repo = repo

    def execute(self, cmd: PatchExpertDecisionCommand) -> Optional[ExpertDecisionItem]:
        uid = uuid.UUID(cmd.item_id.strip())
        row = self._repo.get(uid)
        if row is None:
            return None
        row.status = cmd.status
        row.resolution_json = dict(cmd.resolution) if cmd.resolution else {}
        row.resolved_at = None if cmd.status == "pending" else datetime.utcnow()
        return row
