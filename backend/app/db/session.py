"""
Подключение движка правил к PostgreSQL (postgresql+psycopg2, SQLAlchemy 2).

create_db_and_tables — инициализация схемы при старте контейнера; get_db_session — сессия
на один HTTP-запрос FastAPI (транзакционное ведение справочников и экспертизы).
Строка подключения — DATABASE_URL.
"""

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
    Единая БД проекта — PostgreSQL. Если DATABASE_URL не задан, подключаемся к контейнеру compose
    на localhost:5432 (см. docker-compose.yml: сервис postgres, пользователь и БД rules).
    Переопределение: переменная окружения DATABASE_URL (как в Docker: postgresql+psycopg2://…).
    """
    explicit = (os.getenv("DATABASE_URL") or "").strip()
    if explicit:
        return explicit
    return "postgresql+psycopg2://rules_user:rules_pass@127.0.0.1:5432/rules"


def get_engine() -> Engine:
    """Создаёт SQLAlchemy engine с параметрами под текущий тип БД."""
    url = _get_database_url()
    connect_args = {}
    # SQLite требует check_same_thread False для работы с FastAPI.
    if url.startswith("sqlite"):
        connect_args = {"check_same_thread": False}

    return create_engine(url, pool_pre_ping=True, connect_args=connect_args)


def create_db_and_tables() -> None:
    """Инициализирует схему БД и минимальные совместимые миграции."""
    engine = get_engine()
    Base.metadata.create_all(engine)
    _ensure_rules_archived_column(engine)


def get_session_factory() -> sessionmaker:
    """Фабрика SQLAlchemy-сессий для dependency в FastAPI."""
    engine = get_engine()
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db_session() -> Generator:
    """Dependency FastAPI: выдаёт сессию и гарантированно закрывает её."""
    SessionLocal = get_session_factory()
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()

