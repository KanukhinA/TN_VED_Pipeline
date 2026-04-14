from __future__ import annotations

import os
from typing import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from .base import Base


def _ensure_rules_archived_column(engine: Engine) -> None:
    """Добавляем is_archived к существующим БД без Alembic (новые таблицы получают колонку из модели)."""
    insp = inspect(engine)
    if not insp.has_table("rules"):
        return
    cols = {c["name"] for c in insp.get_columns("rules")}
    if "is_archived" in cols:
        return
    with engine.begin() as conn:
        if engine.dialect.name == "postgresql":
            conn.execute(
                text("ALTER TABLE rules ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false")
            )
        else:
            conn.execute(text("ALTER TABLE rules ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT 0"))


def _get_database_url() -> str:
    """
    По умолчанию используем SQLite, чтобы разработка/прототип могли стартовать без инфраструктуры.
    Для прод-использования выставьте DATABASE_URL на PostgreSQL.
    """

    return os.getenv("DATABASE_URL", "sqlite:///./rules.db")


def get_engine() -> Engine:
    url = _get_database_url()
    connect_args = {}
    # SQLite требует check_same_thread False для работы с FastAPI.
    if url.startswith("sqlite"):
        connect_args = {"check_same_thread": False}

    return create_engine(url, pool_pre_ping=True, connect_args=connect_args)


def create_db_and_tables() -> None:
    engine = get_engine()
    Base.metadata.create_all(engine)
    _ensure_rules_archived_column(engine)


def get_session_factory() -> sessionmaker:
    engine = get_engine()
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db_session() -> Generator:
    SessionLocal = get_session_factory()
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()

