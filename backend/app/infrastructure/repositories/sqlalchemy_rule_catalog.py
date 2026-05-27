"""
PostgreSQL: справочники, версии dsl_json, эталоны и эмбеддинги (SQLAlchemy 2).

Реализация RuleCatalogRepositoryPort для сценариев модуля создания машиночитаемых правил.
Таблицы Rule, RuleVersion, RuleReferenceExample, RuleReferenceEmbedding.
"""

from __future__ import annotations

from typing import Any, Optional
import uuid

from sqlalchemy.orm import Session

from ...db.models import Rule, RuleReferenceEmbedding, RuleReferenceExample, RuleVersion


class SqlAlchemyRuleCatalogRepository:

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_active_rule_version(self, rule_id: uuid.UUID) -> Optional[RuleVersion]:
        return (
            self.db.query(RuleVersion)
            .filter(RuleVersion.rule_id == rule_id, RuleVersion.is_active.is_(True))
            .order_by(RuleVersion.version.desc())
            .first()
        )

    def list_catalog_with_active_version(self, *, include_archived: bool) -> list[tuple[Rule, RuleVersion]]:
        stmt = (
            self.db.query(Rule, RuleVersion)
            .join(RuleVersion, RuleVersion.rule_id == Rule.id)
            .filter(RuleVersion.is_active.is_(True))
        )
        if not include_archived:
            stmt = stmt.filter(Rule.is_archived.is_(False))
        return list(stmt.order_by(RuleVersion.created_at.desc()).all())

    def get_rule(self, rule_id: uuid.UUID) -> Optional[Rule]:
        return self.db.query(Rule).filter(Rule.id == rule_id).one_or_none()

    def add(self, entity: Any) -> None:
        self.db.add(entity)

    def flush(self) -> None:
        self.db.flush()

    def delete(self, entity: Any) -> None:
        self.db.delete(entity)

    def list_active_versions_for_rule(self, rule_id: uuid.UUID) -> list[RuleVersion]:
        return (
            self.db.query(RuleVersion)
            .filter(RuleVersion.rule_id == rule_id, RuleVersion.is_active.is_(True))
            .all()
        )

    def latest_rule_version(self, rule_id: uuid.UUID) -> Optional[RuleVersion]:
        return (
            self.db.query(RuleVersion)
            .filter(RuleVersion.rule_id == rule_id)
            .order_by(RuleVersion.version.desc())
            .first()
        )

    def list_reference_examples_ordered(self, rule_id: uuid.UUID) -> list[RuleReferenceExample]:
        return (
            self.db.query(RuleReferenceExample)
            .filter(RuleReferenceExample.rule_id == rule_id)
            .order_by(RuleReferenceExample.created_at.desc())
            .all()
        )

    def list_embeddings_for_example_ids(self, ids: list[uuid.UUID]) -> list[RuleReferenceEmbedding]:
        if not ids:
            return []
        return (
            self.db.query(RuleReferenceEmbedding)
            .filter(RuleReferenceEmbedding.reference_example_id.in_(ids))
            .all()
        )

    def reference_example_normalized_descriptions(self, rule_id: uuid.UUID) -> set[str]:
        rows = (
            self.db.query(RuleReferenceExample.description_text)
            .filter(RuleReferenceExample.rule_id == rule_id)
            .all()
        )
        return {(str(d or "").strip() or "(без описания)") for (d,) in rows}

    def get_reference_example(
        self, rule_id: uuid.UUID, example_id: uuid.UUID
    ) -> Optional[RuleReferenceExample]:
        return (
            self.db.query(RuleReferenceExample)
            .filter(RuleReferenceExample.id == example_id, RuleReferenceExample.rule_id == rule_id)
            .one_or_none()
        )

    def model_id_exists(self, model_id: str) -> bool:
        return self.db.query(Rule.id).filter(Rule.model_id == model_id).first() is not None
