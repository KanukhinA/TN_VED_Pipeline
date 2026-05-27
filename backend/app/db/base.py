"""
Декларативная основа SQLAlchemy 2 для сущностей движка правил в PostgreSQL.

Общий Base для таблиц справочников, экспертизы и настроек; create_db_and_tables в session.
"""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass

