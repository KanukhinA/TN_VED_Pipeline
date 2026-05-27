"""
PostgreSQL: очередь экспертизы интерфейса эксперта (SQLAlchemy 2).

ExpertDecisionRepositoryPort — ExpertDecisionItem, фильтрация, подтверждение задач.
"""

from __future__ import annotations

from typing import Optional
import uuid

from sqlalchemy.orm import Session

from ...db.models import ExpertDecisionItem


class SqlAlchemyExpertDecisionRepository:

    def __init__(self, db: Session) -> None:
        self.db = db

    def find_pending_by_category(
        self,
        *,
        category: str,
        declaration_id: str,
        rule_id: Optional[uuid.UUID],
    ) -> Optional[ExpertDecisionItem]:
        """Возвращает последнюю pending-запись по категории/декларации (и rule_id при наличии)."""
        q = self.db.query(ExpertDecisionItem).filter(
            ExpertDecisionItem.category == category,
            ExpertDecisionItem.declaration_id == declaration_id,
            ExpertDecisionItem.status == "pending",
        )
        if rule_id is not None:
            q = q.filter(ExpertDecisionItem.rule_id == rule_id)
        return q.order_by(ExpertDecisionItem.created_at.desc()).first()

    def add(self, row: ExpertDecisionItem) -> None:
        """Добавляет ORM-сущность в текущую транзакцию сессии."""
        self.db.add(row)

    def get(self, item_id: uuid.UUID) -> Optional[ExpertDecisionItem]:
        """Возвращает запись экспертного решения по id."""
        return self.db.query(ExpertDecisionItem).filter(ExpertDecisionItem.id == item_id).one_or_none()

    def list_page(
        self,
        *,
        status: Optional[str],
        category: Optional[str],
        page: int,
        page_size: int,
    ) -> tuple[list[ExpertDecisionItem], int]:
        """
        Возвращает страницу экспертных решений.
        Базовый SQL-путь без тяжёлых JSON-фильтров оставлен в репозитории,
        чтобы use-case не зависел от SQLAlchemy API.
        """
        query = self.db.query(ExpertDecisionItem)
        if status and status.strip():
            query = query.filter(ExpertDecisionItem.status == status.strip())
        if category and category.strip():
            query = query.filter(ExpertDecisionItem.category == category.strip())
        total = query.count()
        offset = (page - 1) * page_size
        rows = query.order_by(ExpertDecisionItem.created_at.desc()).offset(offset).limit(page_size).all()
        return rows, total

