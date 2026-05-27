"""
Контракты хранилища PostgreSQL для сценариев движка правил.

RuleCatalogRepositoryPort — справочники, версии с dsl_json, эталоны и эмбеддинги;
ExpertDecisionRepositoryPort — очередь экспертизы интерфейса эксперта;
AppSettingsRepositoryPort — промпты извлечения признаков и карта основного справочника
по группе ТН ВЭД. Реализации — SqlAlchemy-репозитории в infrastructure.
"""

from __future__ import annotations

from typing import Any, Optional, Protocol
import uuid

from ...db.models import ExpertDecisionItem


class ExpertDecisionRepositoryPort(Protocol):

    def find_pending_by_category(
        self,
        *,
        category: str,
        declaration_id: str,
        rule_id: Optional[uuid.UUID],
    ) -> Optional[ExpertDecisionItem]:
        ...

    def add(self, row: ExpertDecisionItem) -> None:
        ...

    def get(self, item_id: uuid.UUID) -> Optional[ExpertDecisionItem]:
        ...

    def list_page(
        self,
        *,
        status: Optional[str],
        category: Optional[str],
        page: int,
        page_size: int,
    ) -> tuple[list[ExpertDecisionItem], int]:
        """Страница записей и общее число строк без учёта limit/offset."""
        ...


class RuleCatalogRepositoryPort(Protocol):
    """Порт доступа к справочникам и их версиям."""

    def get_active_rule_version(self, rule_id: uuid.UUID) -> Optional[Any]:
        ...

    def list_catalog_with_active_version(self, *, include_archived: bool) -> list[tuple[Any, Any]]:
        ...

    def get_rule(self, rule_id: uuid.UUID) -> Optional[Any]:
        ...

    def add(self, entity: Any) -> None:
        ...

    def flush(self) -> None:
        ...

    def delete(self, entity: Any) -> None:
        ...

    def list_active_versions_for_rule(self, rule_id: uuid.UUID) -> list[Any]:
        ...

    def latest_rule_version(self, rule_id: uuid.UUID) -> Optional[Any]:
        ...

    def list_reference_examples_ordered(self, rule_id: uuid.UUID) -> list[Any]:
        ...

    def list_embeddings_for_example_ids(self, ids: list[Any]) -> list[Any]:
        ...

    def reference_example_normalized_descriptions(self, rule_id: uuid.UUID) -> set[str]:
        ...

    def get_reference_example(self, rule_id: uuid.UUID, example_id: uuid.UUID) -> Optional[Any]:
        ...

    def model_id_exists(self, model_id: str) -> bool:
        ...


class AppSettingsRepositoryPort(Protocol):
    """Порт key-value настроек приложения."""

    def get_json(self, key: str) -> Optional[dict[str, Any]]:
        ...

    def upsert_json(self, key: str, value: dict[str, Any]) -> None:
        ...

