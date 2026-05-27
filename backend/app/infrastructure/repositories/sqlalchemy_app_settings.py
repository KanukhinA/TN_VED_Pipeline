"""
PostgreSQL: прикладные настройки движка правил (SQLAlchemy 2).

AppSettingsRepositoryPort — промпты извлечения признаков, карта основного справочника
по группе ТН ВЭД (таблица AppSetting).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from ...db.models import AppSetting


class SqlAlchemyAppSettingsRepository:

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_json(self, key: str) -> Optional[dict[str, Any]]:
        row: AppSetting | None = self.db.query(AppSetting).filter(AppSetting.key == key).one_or_none()
        if row is None or not isinstance(row.value_json, dict):
            return None
        return row.value_json

    def upsert_json(self, key: str, value: dict[str, Any]) -> None:
        row: AppSetting | None = self.db.query(AppSetting).filter(AppSetting.key == key).one_or_none()
        if row is None:
            self.db.add(AppSetting(key=key, value_json=value, updated_at=datetime.utcnow()))
            return
        row.value_json = value
        row.updated_at = datetime.utcnow()
