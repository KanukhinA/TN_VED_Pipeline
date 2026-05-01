from __future__ import annotations

import itertools
from enum import Enum
from typing import Annotated, Any, Dict, List, Optional, Tuple, Type, Union

from pydantic import BaseModel, ConfigDict, Field, create_model

from .classification import evaluate_classification
from .dsl_models import (
    ObjectFieldSchema,
    ArrayFieldSchema,
    StringFieldSchema,
    NumberFieldSchema,
    IntegerFieldSchema,
    BooleanFieldSchema,
    FieldSchema,
    RuleDSL,
    ClassificationConfig,
)
from .cross_rules import validate_cross_rules
from .schema_normalize import lowercase_enum_constrained_strings


def _make_dynamic_enum(values: List[Any], *, name_prefix: str) -> Type[Enum]:
    """
    Динамически создаем enum под список allowed-значений.
    """

    # Pydantic использует значения enum-типов для сравнения/валидации.
    # Имена members делаем безопасными и уникальными.
    members = {f"V{i}": v for i, v in enumerate(values)}
    enum_name = f"{name_prefix}Enum"
    # Тип Enum берём из типа первого значения (если список пустой, не вызываем).
    enum_type = type(values[0])
    return Enum(enum_name, members, type=enum_type)  # type: ignore[misc]


def _compile_field_type(schema: FieldSchema, *, model_name_prefix: str, counter: itertools.count) -> Tuple[Any, Dict[str, Any]]:
    """
    Возвращает (python_type, pydantic_field_constraints_kwargs).
    constraints_kwargs будет помещён в Field(..., **kwargs) на уровне конкретного поля.
    """

    if isinstance(schema, ObjectFieldSchema):
        class_name = f"{model_name_prefix}Object{next(counter)}"
        properties: Dict[str, Any] = {}

        for prop in schema.properties:
            required = prop.name in schema.required
            field_type, field_constraints = _compile_field_type(
                prop.schema_,
                model_name_prefix=f"{model_name_prefix}_{prop.name}",
                counter=counter,
            )
            if required:
                properties[prop.name] = (field_type, Field(default=..., **field_constraints))
            else:
                properties[prop.name] = (Optional[field_type], Field(default=None, **field_constraints))

        return (
            create_model(
                class_name,
                __config__=ConfigDict(extra="allow", use_enum_values=True),
                **properties,
            ),
            {},
        )

    if isinstance(schema, ArrayFieldSchema):
        item_type, _ = _compile_field_type(
            schema.items,
            model_name_prefix=f"{model_name_prefix}_items",
            counter=counter,
        )

        constraints: Dict[str, Any] = {}
        if schema.min_items is not None:
            constraints["min_length"] = schema.min_items
        if schema.max_items is not None:
            constraints["max_length"] = schema.max_items

        return (List[item_type], constraints)

    if isinstance(schema, StringFieldSchema):
        constraints: Dict[str, Any] = {}
        if schema.constraints:
            c = schema.constraints
            if c.min_length is not None:
                constraints["min_length"] = c.min_length
            if c.max_length is not None:
                constraints["max_length"] = c.max_length
            if c.pattern is not None:
                constraints["pattern"] = c.pattern
            if c.enum is not None and len(c.enum) > 0:
                # enum в DSL — подсказка для UI и нормализации регистра ( см. lowercase_enum_constrained_strings ),
                # не жёсткий список: новые коды (вещества и т.д.) не должны ломать валидацию и классификацию.
                return (str, constraints)

        return (str, constraints)

    if isinstance(schema, NumberFieldSchema):
        pair = Annotated[List[Optional[Union[int, float]]], Field(min_length=2, max_length=2)]
        if schema.constraints:
            c = schema.constraints
            if c.enum is not None and len(c.enum) > 0:
                enum_type = _make_dynamic_enum(c.enum, name_prefix=model_name_prefix)
                return (enum_type, {})
            c_kwargs: Dict[str, Any] = {}
            if c.min is not None:
                c_kwargs["ge"] = c.min
            if c.max is not None:
                c_kwargs["le"] = c.max
            if c.multiple_of is not None:
                c_kwargs["multiple_of"] = c.multiple_of
            if c_kwargs:
                scalar = Annotated[Union[int, float], Field(**c_kwargs)]
            else:
                scalar = Union[int, float]
            return (Union[scalar, pair], {})

        return (Union[int, float, pair], {})

    if isinstance(schema, IntegerFieldSchema):
        pair = Annotated[List[Optional[Union[int, float]]], Field(min_length=2, max_length=2)]
        if schema.constraints:
            c = schema.constraints
            if c.enum is not None and len(c.enum) > 0:
                enum_type = _make_dynamic_enum(c.enum, name_prefix=model_name_prefix)
                return (enum_type, {})
            c_kwargs: Dict[str, Any] = {}
            if c.min is not None:
                c_kwargs["ge"] = c.min
            if c.max is not None:
                c_kwargs["le"] = c.max
            if c.multiple_of is not None:
                c_kwargs["multiple_of"] = c.multiple_of
            if c_kwargs:
                scalar = Annotated[int, Field(**c_kwargs)]
            else:
                scalar = int
            return (Union[scalar, pair], {})

        return (Union[int, pair], {})

    if isinstance(schema, BooleanFieldSchema):
        return (bool, {})

    raise ValueError(f"Unsupported field schema: {schema}")


class CompiledRule(BaseModel):
    """
    Результат компиляции DSL в исполняемую валидацию.
    """

    rule_id: Optional[str] = None
    model_id: str
    model: Type[BaseModel]
    cross_rules: List[Any]
    classification: Optional[ClassificationConfig] = None
    root_schema: ObjectFieldSchema

    def validate(self, data: Any) -> Tuple[bool, List[Any], Optional[Any], Optional[str]]:
        """
        Возвращает (ok, errors, validated_data, assigned_class_id).
        """
        try:
            data = lowercase_enum_constrained_strings(data, self.root_schema)
            validated = self.model.model_validate(data)
        except Exception as e:
            # В MVP отдадим сырые ошибки pydantic как строки.
            return (False, [str(e)], None, None)

        # Cross-rule evaluator работает по dict-структуре.
        validated_dict = validated.model_dump()
        errors = validate_cross_rules(validated_dict, self.cross_rules)
        if errors:
            return (False, [e.model_dump() for e in errors], validated_dict, None)

        ok_clf, assigned, clf_errors = evaluate_classification(validated_dict, self.classification)
        if not ok_clf:
            return (False, [e.model_dump() for e in clf_errors], validated_dict, None)
        return (True, [], validated_dict, assigned)


def compile_rule(dsl: RuleDSL) -> CompiledRule:
    """Компилирует DSL в `CompiledRule`: pydantic-модель + cross-rules + классификация."""
    counter = itertools.count(1)
    root_type, _ = _compile_field_type(
        dsl.schema_,
        model_name_prefix="Rule",
        counter=counter,
    )

    # Корневой тип обязан быть object-моделью, но тип-ассертим.
    if not isinstance(root_type, type) or not issubclass(root_type, BaseModel):
        raise TypeError("Root schema compilation must produce a Pydantic model type")

    return CompiledRule(
        model_id=dsl.model_id,
        model=root_type,
        cross_rules=list(dsl.cross_rules),
        classification=dsl.classification,
        root_schema=dsl.schema_,
    )

