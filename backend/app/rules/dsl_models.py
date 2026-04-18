from __future__ import annotations

import re
from typing import Annotated, Literal, Optional, Union, List, Dict, Any

from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator

from .formula_safe_eval import validate_formula_identifiers


FieldType = Literal["object", "array", "string", "number", "integer", "boolean"]

_ALLOWED_TN_VED_EAEU_LENGTHS = frozenset({2, 4, 6, 8, 10})


def normalize_tn_ved_eaeu_code_value(v: Any) -> Optional[str]:
    """Код ТН ВЭД ЕАЭС: 2 / 4 / 6 / 8 / 10 цифр, глава 01–97."""
    if v is None:
        return None
    if isinstance(v, str) and not v.strip():
        return None
    s = str(v).strip()
    if not s.isdigit():
        raise ValueError("tn_ved_group_code must contain only digits")
    if len(s) not in _ALLOWED_TN_VED_EAEU_LENGTHS:
        raise ValueError("tn_ved_group_code must have length 2, 4, 6, 8 or 10 (EAEU TN VED)")
    chapter = int(s[:2])
    if chapter < 1 or chapter > 97:
        raise ValueError("tn_ved_group_code: chapter (first two digits) must be 01–97")
    return s


class PropertyDef(BaseModel):
    """
    Описание свойства внутри object-схемы.
    """

    name: str = Field(min_length=1)
    schema_: "FieldSchema" = Field(alias="schema")

    model_config = ConfigDict(extra="forbid", protected_namespaces=(), populate_by_name=True)


class NumberConstraints(BaseModel):
    min: Optional[float] = None
    max: Optional[float] = None
    multiple_of: Optional[float] = None
    # Для удобства UI допускаем enum и для чисел
    enum: Optional[List[float]] = None


class IntegerConstraints(BaseModel):
    min: Optional[int] = None
    max: Optional[int] = None
    multiple_of: Optional[int] = None
    enum: Optional[List[int]] = None


class StringConstraintsModel(BaseModel):
    min_length: Optional[int] = None
    max_length: Optional[int] = None
    pattern: Optional[str] = None
    enum: Optional[List[str]] = None


class BaseFieldSchema(BaseModel):
    type: FieldType
    title: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class ObjectFieldSchema(BaseFieldSchema):
    type: Literal["object"] = "object"
    properties: List[PropertyDef] = Field(default_factory=list)
    required: List[str] = Field(default_factory=list)
    additional_properties: bool = False


class ArrayFieldSchema(BaseFieldSchema):
    type: Literal["array"] = "array"
    items: "FieldSchema"
    min_items: Optional[int] = None
    max_items: Optional[int] = None


class StringFieldSchema(BaseFieldSchema):
    type: Literal["string"] = "string"
    constraints: Optional[StringConstraintsModel] = None


class NumberFieldSchema(BaseFieldSchema):
    """Число или пара [min, max] (в JSON); в правилах интервал — среднее."""

    type: Literal["number"] = "number"
    constraints: Optional[NumberConstraints] = None

    @model_validator(mode="before")
    @classmethod
    def _drop_legacy_allow_interval_key(cls, data: Any) -> Any:
        if isinstance(data, dict) and "allow_two_element_interval" in data:
            data = {k: v for k, v in data.items() if k != "allow_two_element_interval"}
        return data


class IntegerFieldSchema(BaseFieldSchema):
    type: Literal["integer"] = "integer"
    constraints: Optional[IntegerConstraints] = None


class BooleanFieldSchema(BaseFieldSchema):
    type: Literal["boolean"] = "boolean"


FieldSchema = Annotated[
    Union[
        ObjectFieldSchema,
        ArrayFieldSchema,
        StringFieldSchema,
        NumberFieldSchema,
        IntegerFieldSchema,
        BooleanFieldSchema,
    ],
    Field(discriminator="type"),
]


class SumEqualsRule(BaseModel):
    template: Literal["sumEquals"] = "sumEquals"
    path: str = Field(min_length=1)
    expected: float
    tolerance: float = 0.0001

    model_config = ConfigDict(extra="forbid")


class ComparisonOp(str):
    pass


ComparisonOpType = Literal[
    "equals",
    "notEquals",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "exists",
    "notExists",
    "regex",
    "notRegex",
]


class ComparisonCond(BaseModel):
    path: str = Field(min_length=1)
    op: ComparisonOpType
    value: Optional[Union[str, float, int, bool, List[Union[str, float, int, bool]]]] = None

    model_config = ConfigDict(extra="forbid")


class RequiredIfRule(BaseModel):
    template: Literal["requiredIf"] = "requiredIf"
    if_: ComparisonCond = Field(alias="if")
    then: "ThenRequired" = Field()

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

class ThenRequired(BaseModel):
    required_paths: List[str] = Field(min_length=1)


class AtLeastOnePresentRule(BaseModel):
    template: Literal["atLeastOnePresent"] = "atLeastOnePresent"
    paths: List[str] = Field(min_length=1)
    min_count: int = 1

    model_config = ConfigDict(extra="forbid")


CrossRule = Annotated[
    Union[SumEqualsRule, RequiredIfRule, AtLeastOnePresentRule],
    Field(discriminator="template"),
]


ClassificationStrategy = Literal["first_match", "exactly_one"]

AmbiguousMatchResolution = Literal["reject", "by_priority", "comma_join"]
ConditionConjunction = Literal["and", "or"]

RowFormulaOp = Literal["equals", "gt", "gte", "lt", "lte"]
_ROW_FORMULA_VAR_KEY_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


class PathClassificationCondition(BaseModel):
    """Скалярное условие по пути в нормализованном JSON."""

    type: Literal["path"] = "path"
    path: str = Field(min_length=1)
    op: ComparisonOpType
    value: Optional[Union[str, float, int, bool, List[Union[str, float, int, bool]]]] = None
    group_id: Optional[str] = None
    conjunction: ConditionConjunction = "and"
    primary: bool = Field(
        default=True,
        description="Если False, условие не обязательно для срабатывания правила (уточнение при совпадении основных).",
    )

    model_config = ConfigDict(extra="forbid")


class RowIndicatorCondition(BaseModel):
    """
    Условие по строке списка: есть элемент массива, где name_field == name_equals.

    Если заданы value_min и value_max: число сравнивается с целевым значением (value_min + value_max) / 2
    с относительным допуском 0.001 (как у rowPairRatio).

    Если задана только value_min: требуется значение >= value_min.
    Только value_max: значение <= value_max.

    Иначе — классическое сравнение op/value.
    """

    type: Literal["rowIndicator"] = "rowIndicator"
    array_path: str = Field(min_length=1)
    name_field: str = Field(min_length=1)
    name_equals: str = Field(min_length=1)
    value_field: str = Field(min_length=1)
    op: Optional[ComparisonOpType] = None
    value: Optional[Union[str, float, int, bool, List[Union[str, float, int, bool]]]] = None
    value_min: Optional[float] = None
    value_max: Optional[float] = None
    group_id: Optional[str] = None
    conjunction: ConditionConjunction = "and"
    primary: bool = Field(
        default=True,
        description="Если False, условие не обязательно для срабатывания правила (уточнение при совпадении основных).",
    )

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _row_indicator_range_or_op(self) -> RowIndicatorCondition:
        has_range = self.value_min is not None or self.value_max is not None
        if has_range:
            if self.value_min is not None and self.value_max is not None and self.value_min > self.value_max:
                raise ValueError("rowIndicator: value_min не может быть больше value_max")
            return self
        if self.op is None:
            raise ValueError("rowIndicator: укажите op/value или value_min и/или value_max")
        return self


class RowPairRatioCondition(BaseModel):
    """
    Две строки одного массива (по name_field): значения числового поля value_field
    в отношении ratio_left : ratio_right (например N и S в пропорции 2:1 ⇔ value_N / value_S ≈ 2/1).
    Сравнение по перекрёстному произведению с относительной погрешностью tolerance_rel.
    """

    type: Literal["rowPairRatio"] = "rowPairRatio"
    array_path: str = Field(min_length=1)
    name_field: str = Field(min_length=1)
    value_field: str = Field(min_length=1)
    left_name: str = Field(min_length=1, description="Значение компонента для левой части отношения (например n)")
    right_name: str = Field(min_length=1, description="Значение компонента для правой части (например s)")
    ratio_left: float = Field(gt=0)
    ratio_right: float = Field(gt=0)
    tolerance_rel: float = Field(
        default=0.001,
        ge=0.0,
        le=1.0,
        description="Относительная погрешность для |value(left)/value(right) − ratio_left/ratio_right|; при проверке не более 0.1 (см. classification._row_pair_ratio_holds)",
    )
    group_id: Optional[str] = None
    conjunction: ConditionConjunction = "and"
    primary: bool = Field(
        default=True,
        description="Если False, условие не обязательно для срабатывания правила (уточнение при совпадении основных).",
    )

    model_config = ConfigDict(extra="forbid")

    @field_validator("left_name", "right_name", mode="before")
    @classmethod
    def _normalize_pair_names(cls, v: Any) -> str:
        return str(v or "").strip().lower()

    @model_validator(mode="after")
    def _names_distinct(self) -> RowPairRatioCondition:
        if self.left_name == self.right_name:
            raise ValueError("rowPairRatio: left_name и right_name должны различаться")
        return self


class RowFormulaCondition(BaseModel):
    """
    Несколько строк одного массива связываются именами переменных; по ним подставляются числа из value_field,
    затем вычисляется formula (только + − * /, скобки, числа). Результат сравнивается с value через op.
    Пример: variables {n, s, k}, formula «(n + s) / k», op equals, value 1.0.
    """

    type: Literal["rowFormula"] = "rowFormula"
    array_path: str = Field(min_length=1)
    name_field: str = Field(min_length=1)
    value_field: str = Field(min_length=1)
    variables: Dict[str, str] = Field(
        description="Имя переменной в формуле → значение поля компонента в строке (как name_equals)",
    )
    formula: str = Field(min_length=1, description="Выражение над именами из variables")
    op: RowFormulaOp
    value: float
    tolerance_rel: float = Field(default=0.001, ge=0.0, le=1.0, description="Для op=equals: относительная погрешность")
    group_id: Optional[str] = None
    conjunction: ConditionConjunction = "and"
    primary: bool = Field(
        default=True,
        description="Если False, условие не обязательно для срабатывания правила (уточнение при совпадении основных).",
    )

    model_config = ConfigDict(extra="forbid")

    @field_validator("variables", mode="before")
    @classmethod
    def _normalize_variable_map(cls, v: Any) -> Dict[str, str]:
        if not isinstance(v, dict):
            raise ValueError("rowFormula: variables должен быть объектом")
        out: Dict[str, str] = {}
        for k_raw, val_raw in v.items():
            k = str(k_raw).strip()
            comp = str(val_raw).strip().lower()
            if not k or not comp:
                continue
            out[k] = comp
        return out

    @model_validator(mode="after")
    def _validate_keys_and_formula(self) -> RowFormulaCondition:
        if not self.variables:
            raise ValueError("rowFormula: нужна хотя бы одна переменная с непустым компонентом")
        for k in self.variables:
            if not _ROW_FORMULA_VAR_KEY_RE.match(k):
                raise ValueError(
                    f"rowFormula: имя переменной «{k}» недопустимо (латиница, цифры, _, с буквы или _)"
                )
        validate_formula_identifiers(self.formula, set(self.variables.keys()))
        return self


ClassificationCondition = Annotated[
    Union[
        PathClassificationCondition,
        RowIndicatorCondition,
        RowPairRatioCondition,
        RowFormulaCondition,
    ],
    Field(discriminator="type"),
]


class ClassificationRule(BaseModel):
    """Правило присвоения класса: по умолчанию все conditions связаны по И; с primary=False — только уточнение."""

    class_id: str = Field(min_length=1)
    title: Optional[str] = None
    priority: int = 0
    """Код ТН ВЭД ЕАЭС (2–10 цифр: глава … полная позиция), привязка класса к номенклатуре."""
    tn_ved_group_code: Optional[str] = None
    condition_groups: List[str] = Field(default_factory=list)
    conditions: List[ClassificationCondition] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")

    @field_validator("tn_ved_group_code", mode="before")
    @classmethod
    def _normalize_class_tn_ved(cls, v: Any) -> Optional[str]:
        return normalize_tn_ved_eaeu_code_value(v)


class ClassificationConfig(BaseModel):
    """Детерминированная классификация декларации по порогам показателей."""

    strategy: ClassificationStrategy
    rules: List[ClassificationRule] = Field(default_factory=list)
    """Устаревшее поле из старых правил; игнорируется движком."""
    declared_class_path: Optional[str] = None
    """Если для first_match ни одно правило не сработало, назначить этот класс (иначе ошибка)."""
    default_class_id: Optional[str] = None
    """
    Для strategy exactly_one, когда подходит больше одного правила:
    reject: ошибка (поведение по умолчанию для старых правил);
    by_priority: один класс с наилучшим приоритетом (меньше число, раньше), при равенстве порядок в списке;
    comma_join: в результат попадает строка из уникальных class_id через запятую (порядок: порядок правил в конфиге).
    """
    ambiguous_match_resolution: AmbiguousMatchResolution = "reject"

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_validate_declared(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        if out.get("strategy") == "validate_declared":
            out["strategy"] = "first_match"
        return out


class RuleMeta(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    # Человеко-читабельный номер версии (может совпадать с версией в БД, а может быть отдельно)
    version_label: Optional[str] = None
    # Код ТН ВЭД ЕАЭС (2 / 4 / 6 / 8 / 10 цифр), обязателен при создании справочника через API
    tn_ved_group_code: Optional[str] = None
    # Состояние разговорного мастера (восстановление формы без обратного разбора DSL)
    expert_draft: Optional[Dict[str, Any]] = None
    # Черновик мастера «числовые характеристики» (единый мастер справочника); произвольная структура как на фронте
    numeric_characteristics_draft: Optional[Dict[str, Any]] = None
    # Множественные конфигурации извлечения признаков (selected_models; prompt + дубли prompts_by_model для совместимости).
    # В элементах списка допускается feature_extraction_primary: если одна LLM в нескольких конфигурациях — ровно одна должна быть true.
    feature_extraction_configs: Optional[List[Dict[str, Any]]] = None
    # Активная конфигурация извлечения признаков (id из feature_extraction_configs)
    feature_extraction_active_config_id: Optional[str] = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _strip_legacy_feature_extraction_singletons(cls, data: Any) -> Any:
        """Удаляем устаревшие поля meta (раньше дублировали активную конфигурацию)."""
        if not isinstance(data, dict):
            return data
        out = dict(data)
        out.pop("feature_extraction_model", None)
        out.pop("feature_extraction_prompt", None)
        out.pop("selected_model", None)
        return out

    @field_validator("tn_ved_group_code", mode="before")
    @classmethod
    def _normalize_tn_ved_group_code(cls, v: Any) -> Optional[str]:
        return normalize_tn_ved_eaeu_code_value(v)


class RuleDSL(BaseModel):
    """
    Top-level DSL для правила валидации данных.

    В MVP мы валидируем:
    - структуру/типы/ограничения декларации через динамическую Pydantic-модель
    - кросс-полевые правила через post-validation.
    """

    model_id: str = Field(min_length=1)
    schema_: ObjectFieldSchema = Field(alias="schema")
    cross_rules: List[CrossRule] = Field(default_factory=list)
    classification: Optional[ClassificationConfig] = None
    meta: Optional[RuleMeta] = None

    model_config = ConfigDict(extra="forbid", protected_namespaces=(), populate_by_name=True)


# Разрешаем рекурсивные forward-references
PropertyDef.model_rebuild()
RuleDSL.model_rebuild()
RequiredIfRule.model_rebuild()

