from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy import JSON

from .base import Base


class Rule(Base):
    __tablename__ = "rules"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    versions: Mapped[list["RuleVersion"]] = relationship(back_populates="rule", cascade="all, delete-orphan")
    few_shot_runs: Mapped[list["FewShotAssistRun"]] = relationship(
        back_populates="rule", cascade="all, delete-orphan"
    )
    reference_examples: Mapped[list["RuleReferenceExample"]] = relationship(
        back_populates="rule", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_rules_model_id", "model_id"),
    )


class RuleVersion(Base):
    __tablename__ = "rule_versions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rules.id", ondelete="CASCADE"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False)

    # Сохраняем DSL как JSON.
    dsl_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    rule: Mapped[Rule] = relationship(back_populates="versions")

    __table_args__ = (
        Index("ix_rule_versions_rule_id_active", "rule_id", "is_active"),
    )


class RuleReferenceExample(Base):
    """
    Эталонные примеры для справочника: текст описания + JSON признаков + класс после детерминированной классификации.
    Используются для последующего сравнения (например, с порогом семантической схожести).
    """

    __tablename__ = "rule_reference_examples"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rules.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    description_text: Mapped[str] = mapped_column(Text, nullable=False)
    features_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
    assigned_class_id: Mapped[str] = mapped_column(String(512), nullable=False)

    rule: Mapped["Rule"] = relationship(back_populates="reference_examples")

    __table_args__ = (Index("ix_rule_reference_examples_rule_id_created", "rule_id", "created_at"),)


class FewShotAssistRun(Base):
    """Сохранённый ответ few-shot-assist (шлюз) для справочника — история прогонов."""

    __tablename__ = "few_shot_assist_runs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rules.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    result_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)

    rule: Mapped["Rule"] = relationship(back_populates="few_shot_runs")

    __table_args__ = (Index("ix_few_shot_assist_runs_rule_id_created", "rule_id", "created_at"),)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)


class ExpertDecisionItem(Base):
    """
    Очередь решений эксперта по пайплайну: спорная классификация, подтверждение имени класса от LLM и т.д.
    Категории: classification_ambiguous | classification_none | class_name_confirmation | …
    """

    __tablename__ = "expert_decision_items"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    rule_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("rules.id", ondelete="SET NULL"),
        nullable=True,
    )
    declaration_id: Mapped[str] = mapped_column(String(512), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    summary_ru: Mapped[str] = mapped_column(Text, nullable=False, default="")
    payload_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
    resolution_json: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    rule: Mapped[Optional["Rule"]] = relationship()

    __table_args__ = (
        Index("ix_expert_decision_items_status_created", "status", "created_at"),
        Index("ix_expert_decision_items_category_status", "category", "status"),
    )

