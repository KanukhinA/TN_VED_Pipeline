"""
Русскоязычные тексты условий для сообщений об ошибках классификации.
"""

from __future__ import annotations

from typing import Any, List

from ..dsl_models import (
    ClassificationCondition,
    ClassificationRule,
    PathClassificationCondition,
    RowIndicatorCondition,
    RowPairRatioCondition,
    RowFormulaCondition,
)
from .predicates import (
    _condition_holds,
    _condition_is_primary,
)

def _op_to_text(op: str) -> str:
    """Преобразует внутренний оператор в человекочитаемый вид (с пояснением на русском в скобках)."""
    m = {
        "equals": "=",
        "notEquals": "!=",
        "gt": "> (строго больше)",
        "gte": "≥ (не меньше)",
        "lt": "< (строго меньше)",
        "lte": "≤ (не более)",
        "in": "in",
        "notIn": "not in",
        "regex": "~",
        "notRegex": "!~",
        "exists": "exists",
        "notExists": "not exists",
    }
    return m.get(op, op)


def _path_to_ru(path: str) -> str:
    """Делает путь поля читаемым для русскоязычного UI."""
    p = str(path or "").strip()
    if not p:
        return "поле"
    p = p.replace("[*]", "")
    p = p.replace(".", " -> ")
    return f"поле «{p}»"


def _value_to_ru(value: Any) -> str:
    if isinstance(value, str):
        return f"«{value}»"
    if isinstance(value, (list, tuple)):
        items = ", ".join(f"«{str(v)}»" for v in value)
        return f"[{items}]"
    return str(value)


def _tolerance_suffix_ru(tol: float) -> str:
    if tol <= 0:
        return ""
    return f", относительный допуск {tol:g}"


def _condition_to_ru(cond: ClassificationCondition) -> str:
    """Строит краткое русское описание условия для сообщений об ошибках."""
    if isinstance(cond, PathClassificationCondition):
        field_name = _path_to_ru(cond.path)
        if cond.op == "exists":
            return f"{field_name} должно быть заполнено"
        if cond.op == "notExists":
            return f"{field_name} должно отсутствовать"
        if cond.op == "in":
            return f"{field_name} должно быть одним из значений {_value_to_ru(cond.value)}"
        if cond.op == "notIn":
            return f"{field_name} не должно входить в набор {_value_to_ru(cond.value)}"
        if cond.op == "equals":
            return f"{field_name} должно быть равно {_value_to_ru(cond.value)}{_tolerance_suffix_ru(float(cond.tolerance_rel))}"
        if cond.op == "notEquals":
            return f"{field_name} не должно быть равно {_value_to_ru(cond.value)}"
        return f"{field_name}: {_op_to_text(cond.op)} {_value_to_ru(cond.value)}{_tolerance_suffix_ru(float(cond.tolerance_rel))}"
    if isinstance(cond, RowIndicatorCondition):
        if cond.value_min is not None or cond.value_max is not None:
            lo = cond.value_min if cond.value_min is not None else "—"
            hi = cond.value_max if cond.value_max is not None else "—"
            return (
                f"для строки с показателем «{cond.name_equals}» число должно соответствовать диапазону от {lo} до {hi} "
                f"(как в мастере: «У поля с таким значением, диапазон числа»){_tolerance_suffix_ru(float(cond.tolerance_rel))}"
            )
        return (
            f"для строки с показателем «{cond.name_equals}» число в таблице: "
            f"{_op_to_text(str(cond.op or 'equals'))} {_value_to_ru(cond.value)}{_tolerance_suffix_ru(float(cond.tolerance_rel))}"
        )
    if isinstance(cond, RowPairRatioCondition):
        return (
            f"«Отношение двух показателей (A : B = …)»: «{cond.left_name}» к «{cond.right_name}» "
            f"в пропорции {cond.ratio_left} : {cond.ratio_right} (допуск {cond.tolerance_rel})"
        )
    if isinstance(cond, RowFormulaCondition):
        return (
            f"«Формула по нескольким показателям»: выражение {cond.formula!r} — "
            f"{_op_to_text(cond.op)} {_value_to_ru(cond.value)}"
        )
    return "условие неизвестного типа"


def _semantic_rule_mismatch_details_ru(data: Any, rule: ClassificationRule, max_items: int = 3) -> str:
    """Формирует короткое объяснение, какие условия правила не выполнились."""
    primary_conds = [c for c in rule.conditions if _condition_is_primary(c)]
    to_check = primary_conds if primary_conds else rule.conditions
    if not to_check:
        return "У правила нет условий, но проверка вернула несоответствие."

    failed = [c for c in to_check if not _condition_holds(data, c)]
    if not failed:
        return "Нарушение зафиксировано на уровне логики групп/связок условий."

    parts = [_condition_to_ru(c) for c in failed[:max_items]]
    more = len(failed) - len(parts)
    if more > 0:
        parts.append(f"... и ещё {more}")
    return "; ".join(parts)
