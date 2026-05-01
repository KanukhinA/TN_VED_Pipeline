from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

from .dsl_models import (
    CrossRule,
    SumEqualsRule,
    RequiredIfRule,
    AtLeastOnePresentRule,
    ComparisonCond,
    ComparisonOpType,
)
from .numeric_cell import coerce_numeric_cell_to_scalar
from .path_utils import extract_first_value, extract_values, path_exists


class CrossRuleError(BaseModel):
    """Структурированная ошибка проверки cross-rule."""
    template: str
    path: Optional[str] = None
    message: str
    details: Optional[Dict[str, Any]] = None


def _compare(left: Any, op: ComparisonOpType, right: Any) -> bool:
    """Унифицированное сравнение значений для условий кросс-правил."""
    if op == "exists":
        return left is not None
    if op == "notExists":
        return left is None
    if op in {"equals", "notEquals", "gt", "gte", "lt", "lte", "in"}:
        # Для интервалов вида [min, max] приводим к скаляру (среднее/граница).
        coerced = coerce_numeric_cell_to_scalar(left)
        if coerced is not None:
            left = coerced
    if op in {"equals", "notEquals"}:
        eq = left == right
        return eq if op == "equals" else (not eq)

    if op in {"gt", "gte", "lt", "lte"}:
        # В MVP стараемся сравнивать числа; иначе считаем несовместимость false.
        try:
            lf = float(left)
            rf = float(right)
        except (TypeError, ValueError):
            return False

        if op == "gt":
            return lf > rf
        if op == "gte":
            return lf >= rf
        if op == "lt":
            return lf < rf
        if op == "lte":
            return lf <= rf

    if op == "in":
        if right is None:
            return False
        if not isinstance(right, list):
            right = [right]
        return left in right

    if op in {"regex", "notRegex"}:
        if right is None or str(right).strip() == "":
            return False
        try:
            m = re.search(str(right), str(left)) is not None
        except re.error:
            return False
        return m if op == "regex" else (not m)

    return False


def validate_cross_rules(data: Any, rules: List[CrossRule]) -> List[CrossRuleError]:
    """Применяет все cross-rules к данным и возвращает накопленный список нарушений."""
    errors: List[CrossRuleError] = []

    for rule in rules:
        if isinstance(rule, SumEqualsRule):
            values = extract_values(data, rule.path)
            numeric_values: List[float] = []
            for v in values:
                c = coerce_numeric_cell_to_scalar(v)
                if c is not None:
                    numeric_values.append(c)
                elif isinstance(v, (int, float)):
                    numeric_values.append(float(v))

            # Если чисел нет, считаем это нарушением
            if not numeric_values:
                errors.append(
                    CrossRuleError(
                        template=rule.template,
                        path=rule.path,
                        message="No numeric values found for sumEquals",
                        details={"expected": rule.expected},
                    )
                )
                continue

            total = sum(numeric_values)
            if abs(total - rule.expected) > rule.tolerance:
                errors.append(
                    CrossRuleError(
                        template=rule.template,
                        path=rule.path,
                        message="sumEquals constraint violated",
                        details={"expected": rule.expected, "tolerance": rule.tolerance, "actual": total},
                    )
                )

        elif isinstance(rule, RequiredIfRule):
            cond: ComparisonCond = rule.if_
            left = extract_first_value(data, cond.path)

            # Для equals/gt/.. требуется cond.value
            satisfied = _compare(left, cond.op, cond.value)

            if satisfied:
                # Проверяем наличие всех обязательных путей, только если условие if выполнено.
                for req_path in rule.then.required_paths:
                    if not path_exists(data, req_path):
                        errors.append(
                            CrossRuleError(
                                template=rule.template,
                                path=req_path,
                                message="Field required by requiredIf rule",
                                details={"condition_path": cond.path, "condition_op": cond.op, "condition_value": cond.value},
                            )
                        )

        elif isinstance(rule, AtLeastOnePresentRule):
            present_count = 0
            for p in rule.paths:
                if path_exists(data, p):
                    present_count += 1
            if present_count < rule.min_count:
                # Нарушение, если присутствует меньше полей, чем требуется правилом.
                errors.append(
                    CrossRuleError(
                        template=rule.template,
                        path=None,
                        message="atLeastOnePresent constraint violated",
                        details={"min_count": rule.min_count, "present_count": present_count, "paths": rule.paths},
                    )
                )
        else:
            errors.append(
                CrossRuleError(
                    template="unknown",
                    message=f"Unsupported cross rule type: {type(rule)}",
                )
            )

    return errors

