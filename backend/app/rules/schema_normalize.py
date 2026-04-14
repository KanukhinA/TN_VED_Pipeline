"""
Нормализация входных данных под схему DSL до Pydantic-валидации.
"""

from __future__ import annotations

from typing import Any

from .dsl_models import (
    ArrayFieldSchema,
    BooleanFieldSchema,
    FieldSchema,
    IntegerFieldSchema,
    NumberFieldSchema,
    ObjectFieldSchema,
    StringFieldSchema,
)


def lowercase_enum_constrained_strings(data: Any, schema: FieldSchema) -> Any:
    """
    Для каждого string-поля, у которого в схеме задан непустой enum, приводит значение к lower().
    Остальные ветки схемы обходятся рекурсивно; прочие строки не меняются.
    """

    if isinstance(schema, ObjectFieldSchema):
        if not isinstance(data, dict):
            return data
        props_by_name = {p.name: p.schema_ for p in schema.properties}
        return {k: lowercase_enum_constrained_strings(v, props_by_name[k]) if k in props_by_name else v for k, v in data.items()}

    if isinstance(schema, ArrayFieldSchema):
        if not isinstance(data, list):
            return data
        return [lowercase_enum_constrained_strings(item, schema.items) for item in data]

    if isinstance(schema, StringFieldSchema):
        if isinstance(data, str):
            c = schema.constraints
            if c is not None and c.enum is not None and len(c.enum) > 0:
                return data.lower()
        return data

    if isinstance(schema, (NumberFieldSchema, IntegerFieldSchema, BooleanFieldSchema)):
        return data

    return data
