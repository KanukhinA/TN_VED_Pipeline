"""DTO ответов API каталога правил (общие для роутов и application-слоя)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class CreateRuleResponse(BaseModel):
    """Ответ создания новой версии справочника."""

    rule_id: uuid.UUID
    version: int
    dsl: Dict[str, Any]
    created_at: datetime


class ValidateRequest(BaseModel):
    """Тело запроса на валидацию произвольных данных по DSL-правилу."""

    data: Any


class ValidateResponse(BaseModel):
    """Результат валидации: ошибки, нормализованные данные и назначенный класс."""

    ok: bool
    errors: list[Any] = []
    validated_data: Optional[Dict[str, Any]] = None
    assigned_class: Optional[str] = None


class RuleOverlapColumnItem(BaseModel):
    """Одна колонка в сетке «пересекающиеся правила» (заголовок + компактные условия)."""

    rule_index: int
    label_ru: str = Field(description="Название или class_id для шапки колонки.")
    constraints_compact_ru: str = Field(description="Числовые/табличные условия одной строкой.")


class RuleConflictItem(BaseModel):
    """Описывает одно потенциальное пересечение/конфликт правил."""

    left_rule_index: int
    right_rule_index: int
    left_class_id: str
    right_class_id: str
    left_title: Optional[str] = None
    right_title: Optional[str] = None
    rule_indices: list[int] = Field(
        default_factory=list,
        description="1-based индексы всех правил в группе (пара или больше); для обратной совместимости есть left/right.",
    )
    rule_class_ids: list[str] = Field(default_factory=list)
    rule_titles: list[Optional[str]] = Field(default_factory=list)
    reason_ru: str
    ambiguous_example: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Синтетический JSON признаков, по возможности удовлетворяющий обоим правилам.",
    )
    ambiguous_example_note_ru: Optional[str] = Field(
        default=None,
        description="Пояснение, если пример частичный или не прошёл проверку условий.",
    )
    corridor_risk_ru: Optional[str] = Field(
        default=None,
        description="Риск спецификации: коридоры min–max на оси пересекаются, но одновременная проверка как в декларации невозможна.",
    )
    overlap_context_note_ru: Optional[str] = Field(
        default=None,
        description="Контекст: несколько условий, «или», группы.",
    )
    simplified_analysis_note_ru: Optional[str] = Field(
        default=None,
        description="Упрощённый анализ при «или» или группах условий.",
    )
    priority_resolution_ru: Optional[str] = Field(
        default=None,
        description="Кому отдан приоритет при одновременном выполнении и почему.",
    )
    range_intersections_ru: list[str] = Field(
        default_factory=list,
        description="Явное описание пересечения числовых диапазонов по полю декларации или ячейке таблицы.",
    )
    adjustment_recommendations_ru: list[str] = Field(
        default_factory=list,
        description="Практические подсказки, что подкрутить в правилах.",
    )
    overlap_axis_summary_ru: Optional[str] = Field(
        default=None,
        description="Кратко: где пересекаются диапазоны по числу.",
    )
    overlap_columns: list[RuleOverlapColumnItem] = Field(
        default_factory=list,
        description="Правила в виде столбцов: подпись и компактные условия.",
    )


class RuleConflictsResponse(BaseModel):
    """Сводный ответ по анализу конфликтов правил."""

    has_conflicts: bool
    conflicts: list[RuleConflictItem] = Field(default_factory=list)


class RuleListItem(BaseModel):
    """Краткая карточка справочника в списке."""

    rule_id: uuid.UUID
    model_id: str
    name: Optional[str] = None
    description: Optional[str] = None
    tn_ved_group_code: Optional[str] = None
    version: int
    created_at: datetime
    is_archived: bool = False


class CloneRuleRequest(BaseModel):
    """Параметры клонирования справочника."""

    name: Optional[str] = None
    model_id: Optional[str] = None


class ReferenceExampleBulkItem(BaseModel):
    """Один эталонный пример для bulk-импорта."""

    description_text: str = ""
    data: Any
    assigned_class_id: Optional[str] = None


class ReferenceExampleBulkIn(BaseModel):
    """Пакет эталонных примеров для bulk-операции."""

    items: list[ReferenceExampleBulkItem] = Field(default_factory=list)


class ReferenceExampleBulkOut(BaseModel):
    """Результат bulk-импорта эталонных примеров."""

    inserted: int
    skipped: list[dict[str, Any]]
