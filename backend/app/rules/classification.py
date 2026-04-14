from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel

from .cross_rules import _compare
from .dsl_models import (
    ClassificationCondition,
    ClassificationConfig,
    ClassificationRule,
    PathClassificationCondition,
    RowIndicatorCondition,
    RowPairRatioCondition,
    RowFormulaCondition,
)
from .formula_safe_eval import eval_numeric_formula
from .numeric_cell import coerce_numeric_cell_to_scalar
from .path_utils import extract_first_value, extract_values


class ClassificationError(BaseModel):
    message: str
    details: Optional[Dict[str, Any]] = None


# Как у rowPairRatio: при value_min+value_max целевое значение — среднее, проверка «≈» по относительному допуску.
_ROW_INDICATOR_RANGE_TARGET_TOLERANCE_REL = 0.001

# Максимум относительной погрешности для rowPairRatio при сравнении фактического отношения value(left)/value(right)
# с ratio_left/ratio_right. В DSL допускается до 1.0; иначе при tolerance_rel ≥ 0.5 пара 26:26 проходит проверку «2:1»
# (|26·1−26·2|/max ≤ 0.5). Кламп не меняет типичные правила с tolerance_rel ≤ 0.01.
_MAX_ROW_PAIR_RATIO_TOLERANCE_REL = 0.1


def _row_indicator_value_matches_range(lf: float, cond: RowIndicatorCondition) -> bool:
    vmin = cond.value_min
    vmax = cond.value_max
    if vmin is not None and vmax is not None:
        target = (vmin + vmax) / 2.0
        return _formula_compare_numeric(lf, "equals", target, _ROW_INDICATOR_RANGE_TARGET_TOLERANCE_REL)
    if vmin is not None:
        return lf >= vmin
    if vmax is not None:
        return lf <= vmax
    return False


def _condition_is_primary(cond: ClassificationCondition) -> bool:
    if isinstance(cond, PathClassificationCondition):
        return cond.primary
    if isinstance(cond, RowIndicatorCondition):
        return cond.primary
    if isinstance(cond, RowPairRatioCondition):
        return cond.primary
    if isinstance(cond, RowFormulaCondition):
        return cond.primary
    return True


def _condition_conjunction(cond: ClassificationCondition) -> str:
    if isinstance(cond, PathClassificationCondition):
        return cond.conjunction
    if isinstance(cond, RowIndicatorCondition):
        return cond.conjunction
    if isinstance(cond, RowPairRatioCondition):
        return cond.conjunction
    if isinstance(cond, RowFormulaCondition):
        return cond.conjunction
    return "and"


def _condition_group_id(cond: ClassificationCondition) -> Optional[str]:
    if isinstance(cond, PathClassificationCondition):
        return cond.group_id
    if isinstance(cond, RowIndicatorCondition):
        return cond.group_id
    if isinstance(cond, RowPairRatioCondition):
        return cond.group_id
    if isinstance(cond, RowFormulaCondition):
        return cond.group_id
    return None


def _rule_matches_by_groups(data: Any, conditions: List[ClassificationCondition]) -> bool:
    groups: Dict[str, List[ClassificationCondition]] = {}
    order: List[str] = []
    for cond in conditions:
        group_id = _condition_group_id(cond)
        if not group_id:
            continue
        if group_id not in groups:
            groups[group_id] = []
            order.append(group_id)
        groups[group_id].append(cond)
    for group_id in order:
        group_conds = groups[group_id]
        if not group_conds:
            continue
        if all(_condition_holds(data, cond) for cond in group_conds):
            return True
    return False


def _rule_matches(data: Any, rule: ClassificationRule) -> bool:
    if not rule.conditions:
        return True
    primary_conds = [c for c in rule.conditions if _condition_is_primary(c)]
    # Если все помечены как необязательные — как раньше: проверяем все (обратная совместимость).
    to_check = primary_conds if primary_conds else rule.conditions
    if any(_condition_group_id(cond) for cond in to_check):
        return _rule_matches_by_groups(data, to_check)
    result = _condition_holds(data, to_check[0])
    for cond in to_check[1:]:
        if _condition_conjunction(cond) == "or":
            result = result or _condition_holds(data, cond)
        else:
            result = result and _condition_holds(data, cond)
    return result


def _condition_holds(data: Any, cond: ClassificationCondition) -> bool:
    if isinstance(cond, PathClassificationCondition):
        if cond.op == "exists":
            return bool(extract_values(data, cond.path))
        if cond.op == "notExists":
            return not extract_values(data, cond.path)
        values = extract_values(data, cond.path)
        if not values:
            left = extract_first_value(data, cond.path)
            return _compare(left, cond.op, cond.value)
        if cond.op in ("notEquals", "notRegex"):
            return all(_compare(left, cond.op, cond.value) for left in values)
        return any(_compare(left, cond.op, cond.value) for left in values)
    if isinstance(cond, RowIndicatorCondition):
        return _row_indicator_holds(data, cond)
    if isinstance(cond, RowPairRatioCondition):
        return _row_pair_ratio_holds(data, cond)
    if isinstance(cond, RowFormulaCondition):
        return _row_formula_holds(data, cond)
    raise TypeError(f"Unknown classification condition: {type(cond)}")


def _row_indicator_holds(data: Any, cond: RowIndicatorCondition) -> bool:
    arr = extract_first_value(data, cond.array_path)
    if not isinstance(arr, list):
        return False
    has_range = cond.value_min is not None or cond.value_max is not None
    for row in arr:
        if not isinstance(row, dict):
            continue
        if row.get(cond.name_field) != cond.name_equals:
            continue
        left = row.get(cond.value_field)
        if has_range:
            lf = coerce_numeric_cell_to_scalar(left)
            if lf is None:
                continue
            if _row_indicator_value_matches_range(lf, cond):
                return True
            continue
        if cond.op is not None and _compare(left, cond.op, cond.value):
            return True
    return False


def _formula_compare_numeric(lhs: float, op: str, rhs: float, tolerance_rel: float) -> bool:
    if op == "equals":
        scale = max(abs(lhs), abs(rhs), 1e-12)
        return abs(lhs - rhs) <= tolerance_rel * scale
    return _compare(lhs, op, rhs)


def _row_formula_holds(data: Any, cond: RowFormulaCondition) -> bool:
    arr = extract_first_value(data, cond.array_path)
    if not isinstance(arr, list):
        return False
    num_vars: Dict[str, float] = {}
    for var_id, comp_raw in cond.variables.items():
        key = comp_raw.strip().lower()
        found: Optional[float] = None
        for row in arr:
            if not isinstance(row, dict):
                continue
            if str(row.get(cond.name_field, "")).strip().lower() != key:
                continue
            found = coerce_numeric_cell_to_scalar(row.get(cond.value_field))
            break
        if found is None:
            return False
        num_vars[var_id] = found
    try:
        lhs = eval_numeric_formula(cond.formula, num_vars)
    except Exception:
        return False
    if not isinstance(lhs, float) or lhs != lhs:  # NaN
        return False
    return _formula_compare_numeric(lhs, cond.op, float(cond.value), cond.tolerance_rel)


def _row_pair_ratio_holds(data: Any, cond: RowPairRatioCondition) -> bool:
    arr = extract_first_value(data, cond.array_path)
    if not isinstance(arr, list):
        return False
    left_key = cond.left_name.strip().lower()
    right_key = cond.right_name.strip().lower()
    v_left: Optional[float] = None
    v_right: Optional[float] = None
    for row in arr:
        if not isinstance(row, dict):
            continue
        raw_name = row.get(cond.name_field)
        if raw_name is None:
            continue
        name_norm = str(raw_name).strip().lower()
        if name_norm == left_key:
            c = coerce_numeric_cell_to_scalar(row.get(cond.value_field))
            if c is not None:
                v_left = c
            else:
                continue
        if name_norm == right_key:
            c = coerce_numeric_cell_to_scalar(row.get(cond.value_field))
            if c is not None:
                v_right = c
            else:
                continue
    if v_left is None or v_right is None:
        return False
    if v_right == 0.0:
        return False
    expected = cond.ratio_left / cond.ratio_right
    actual = v_left / v_right
    scale = max(abs(expected), abs(actual), 1e-12)
    tol = min(float(cond.tolerance_rel), _MAX_ROW_PAIR_RATIO_TOLERANCE_REL)
    return abs(actual - expected) <= tol * scale


def _ordered_rules_list(rules: List[ClassificationRule]) -> List[ClassificationRule]:
    indexed = sorted(enumerate(rules), key=lambda x: (x[1].priority, x[0]))
    return [r for _, r in indexed]


def find_first_matching_classification_rule(
    data: Any,
    config: Optional[ClassificationConfig],
) -> Optional[ClassificationRule]:
    """Для strategy first_match — первое подошедшее правило (для подписей в UI)."""
    if config is None or not config.rules:
        return None
    if config.strategy != "first_match":
        return None
    ordered = _ordered_rules_list(config.rules)
    for rule in ordered:
        if _rule_matches(data, rule):
            return rule
    return None


def evaluate_classification(
    data: Any,
    config: Optional[ClassificationConfig],
) -> Tuple[bool, Optional[str], List[ClassificationError]]:
    """
    Возвращает (ok, assigned_class_id, errors).
    assigned_class_id заполнен при успешной классификации; иначе None.
    """
    if config is None or not config.rules:
        return (True, None, [])

    ordered = _ordered_rules_list(config.rules)

    if config.strategy == "first_match":
        for rule in ordered:
            if _rule_matches(data, rule):
                return (True, rule.class_id, [])
        if config.default_class_id:
            return (True, config.default_class_id, [])
        return (
            False,
            None,
            [
                ClassificationError(
                    message="classification: ни одно правило не подошло и не задан default_class_id",
                    details={"strategy": config.strategy},
                )
            ],
        )

    if config.strategy == "exactly_one":
        matched_indices = [i for i, r in enumerate(ordered) if _rule_matches(data, r)]
        if len(matched_indices) == 1:
            return (True, ordered[matched_indices[0]].class_id, [])
        if len(matched_indices) == 0:
            return (
                False,
                None,
                [
                    ClassificationError(
                        message="classification: для exactly_one должно выполняться ровно одно правило",
                        details={"matched_count": 0, "matched_class_ids": []},
                    )
                ],
            )
        res = config.ambiguous_match_resolution
        if res == "by_priority":
            bi = min(matched_indices, key=lambda i: (ordered[i].priority, i))
            return (True, ordered[bi].class_id, [])
        if res == "comma_join":
            seen: set[str] = set()
            parts: List[str] = []
            for i in matched_indices:
                cid = ordered[i].class_id
                if cid not in seen:
                    seen.add(cid)
                    parts.append(cid)
            return (True, ",".join(parts), [])
        return (
            False,
            None,
            [
                ClassificationError(
                    message="classification: для exactly_one должно выполняться ровно одно правило",
                    details={
                        "matched_count": len(matched_indices),
                        "matched_class_ids": [ordered[i].class_id for i in matched_indices],
                    },
                )
            ],
        )

    return (False, None, [ClassificationError(message=f"Unknown classification strategy: {config.strategy}")])
