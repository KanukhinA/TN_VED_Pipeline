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


# Максимум относительной погрешности для rowPairRatio при сравнении фактического отношения value(left)/value(right)
# с ratio_left/ratio_right. В DSL допускается до 1.0; иначе при tolerance_rel ≥ 0.5 пара 26:26 проходит проверку «2:1»
# (|26·1−26·2|/max ≤ 0.5). Кламп не меняет типичные правила с tolerance_rel ≤ 0.01.
_MAX_ROW_PAIR_RATIO_TOLERANCE_REL = 0.1


def _row_indicator_value_matches_range(lf: float, cond: RowIndicatorCondition) -> bool:
    """Проверяет числовое значение индикатора по диапазону из условия."""
    vmin = cond.value_min
    vmax = cond.value_max
    if vmin is not None and vmax is not None:
        return vmin <= lf <= vmax
    if vmin is not None:
        return lf >= vmin
    if vmax is not None:
        return lf <= vmax
    return False


def row_indicator_numeric_value_satisfies(lf: float, cond: RowIndicatorCondition) -> bool:
    """
    Проверка числа для ячейки так же, как в рантайме при подстановке одного числового значения
    (без обхода массива строк). Используется анализом пересечений правил.
    """
    has_range = cond.value_min is not None or cond.value_max is not None
    if has_range:
        return _row_indicator_value_matches_range(lf, cond)
    if cond.op is not None:
        return bool(_compare(lf, cond.op, cond.value))
    return False


def _rule_first_match_tiebreak_score(rule: ClassificationRule) -> float:
    """
    Эвристика «строгости» при равном priority: выше score — предпочтительнее при first_match.
    Нижняя граница порога (gte/gt) увеличивает score; верхняя (lte/lt) — отрицательное смещение.
    """
    score = 0.0
    for c in rule.conditions or []:
        if not _condition_is_primary(c):
            continue
        if isinstance(c, RowIndicatorCondition):
            if c.value_min is not None or c.value_max is not None:
                continue
            op = str(c.op or "")
            try:
                v = float(c.value)
            except (TypeError, ValueError):
                continue
            if op in ("gte", "gt"):
                score += v
            elif op in ("lte", "lt"):
                score -= v
        elif isinstance(c, PathClassificationCondition):
            op = str(c.op)
            try:
                v = float(c.value)
            except (TypeError, ValueError):
                continue
            if op in ("gte", "gt"):
                score += v
            elif op in ("lte", "lt"):
                score -= v
    return score


def select_rule_for_first_match(
    matches: List[ClassificationRule],
    ordered: List[ClassificationRule],
) -> ClassificationRule:
    """
    Среди правил, для которых _rule_matches(data, rule) истинно, выбираем одно «победителя».

    1) Один матч — возвращаем его.
    2) Иначе узкий слой с минимальным priority (чем меньше число, тем выше приоритет в конфиге).
    3) Внутри слоя с одинаковым priority — максимум tiebreak_score (более высокий нижний порог gte и т.п.).
    4) При равном score — правило, что раньше в ordered (стабильный запасной тай-брейк).
    """
    if len(matches) == 1:
        return matches[0]
    best_pri = min(r.priority for r in matches)
    tier = [r for r in matches if r.priority == best_pri]
    if len(tier) == 1:
        return tier[0]
    return sorted(
        tier,
        key=lambda r: (-_rule_first_match_tiebreak_score(r), ordered.index(r)),
    )[0]


def _condition_is_primary(cond: ClassificationCondition) -> bool:
    """Возвращает флаг primary для любого поддерживаемого типа условия."""
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
    """Извлекает логическую связку (and/or) из условия."""
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
    """Возвращает group_id, если условие входит в группу."""
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
    """Проверяет правило в режиме групп: достаточно прохождения любой полной группы."""
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
    """Проверяет, выполняется ли правило классификации для данных."""
    if not rule.conditions:
        return True
    primary_conds = [c for c in rule.conditions if _condition_is_primary(c)]
    # Если нет primary-условий, проверяем все как в старом поведении.
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
    """Диспетчер проверки одного условия по его типу."""
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


def _op_to_text(op: str) -> str:
    """Преобразует внутренний оператор в человекочитаемый вид."""
    m = {
        "equals": "=",
        "notEquals": "!=",
        "gt": ">",
        "gte": ">=",
        "lt": "<",
        "lte": "<=",
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
            return f"{field_name} должно быть равно {_value_to_ru(cond.value)}"
        if cond.op == "notEquals":
            return f"{field_name} не должно быть равно {_value_to_ru(cond.value)}"
        return f"{field_name}: {_op_to_text(cond.op)} {_value_to_ru(cond.value)}"
    if isinstance(cond, RowIndicatorCondition):
        if cond.value_min is not None or cond.value_max is not None:
            lo = cond.value_min if cond.value_min is not None else "—"
            hi = cond.value_max if cond.value_max is not None else "—"
            return (
                f"для строки с показателем «{cond.name_equals}» число должно соответствовать диапазону от {lo} до {hi} "
                f"(как в мастере: «У поля с таким значением, диапазон числа»)"
            )
        return (
            f"для строки с показателем «{cond.name_equals}» число в таблице: "
            f"{_op_to_text(str(cond.op or 'equals'))} {_value_to_ru(cond.value)}"
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


def _row_indicator_holds(data: Any, cond: RowIndicatorCondition) -> bool:
    """Проверяет rowIndicator: находит строку по имени и сверяет её значение."""
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
    """Сравнение чисел с относительным допуском для equals."""
    if op == "equals":
        scale = max(abs(lhs), abs(rhs), 1e-12)
        return abs(lhs - rhs) <= tolerance_rel * scale
    return _compare(lhs, op, rhs)


def _row_formula_holds(data: Any, cond: RowFormulaCondition) -> bool:
    """Проверяет rowFormula: собирает переменные, вычисляет формулу, сравнивает результат."""
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
            # Если любой обязательный компонент не найден, формулу проверить нельзя.
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
    """Проверяет условие отношения двух компонент с ограничением допуска."""
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
        # Защита от деления на ноль в фактическом отношении.
        return False
    expected = cond.ratio_left / cond.ratio_right
    actual = v_left / v_right
    scale = max(abs(expected), abs(actual), 1e-12)
    tol = min(float(cond.tolerance_rel), _MAX_ROW_PAIR_RATIO_TOLERANCE_REL)
    return abs(actual - expected) <= tol * scale


def _ordered_rules_list(rules: List[ClassificationRule]) -> List[ClassificationRule]:
    """Стабильно сортирует правила: сначала priority, затем исходный порядок."""
    indexed = sorted(enumerate(rules), key=lambda x: (x[1].priority, x[0]))
    return [r for _, r in indexed]


def find_classification_rule_for_class_id(
    config: Optional[ClassificationConfig],
    class_id: str,
) -> Optional[ClassificationRule]:
    """Правило классификации с данным class_id (точное совпадение или в comma_join)."""
    if not config or not config.rules or not (class_id or "").strip():
        return None
    cid = class_id.strip()
    for rule in config.rules:
        rid = (rule.class_id or "").strip()
        if not rid:
            continue
        if rid == cid:
            return rule
        if "," in rid:
            parts = [x.strip() for x in rid.split(",") if x.strip()]
            if cid in parts:
                return rule
    return None


def find_first_matching_classification_rule(
    data: Any,
    config: Optional[ClassificationConfig],
) -> Optional[ClassificationRule]:
    """Для strategy first_match — выигравшее подошедшее правило (тот же выбор, что при назначении класса)."""
    if config is None or not config.rules:
        return None
    if config.strategy != "first_match":
        return None
    ordered = _ordered_rules_list(config.rules)
    matches = [r for r in ordered if _rule_matches(data, r)]
    if not matches:
        return None
    return select_rule_for_first_match(matches, ordered)


def evaluate_classification(
    data: Any,
    config: Optional[ClassificationConfig],
) -> Tuple[bool, Optional[str], List[ClassificationError]]:
    """
    Возвращает (ok, assigned_class_id, errors).
    Для strategy exactly_one при нескольких совпадениях — несколько class_id через запятую
    (или один при by_priority); при нуле — default_class_id или None без ошибки.
    """
    if config is None or not config.rules:
        return (True, None, [])

    ordered = _ordered_rules_list(config.rules)

    if config.strategy == "first_match":
        # Перебираем не «первое совпавшее по списку», а все совпадения: затем select_rule_for_first_match
        # уважает priority и при равенстве — более узкие числовые пороги (см. _rule_first_match_tiebreak_score).
        matches = [r for r in ordered if _rule_matches(data, r)]
        if matches:
            winner = select_rule_for_first_match(matches, ordered)
            return (True, winner.class_id, [])
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
        # Ветвление по числу совпадений: 0 / 1 / несколько; при нескольких — отдельная политика из конфига.
        matched_indices = [i for i, r in enumerate(ordered) if _rule_matches(data, r)]
        if len(matched_indices) == 1:
            return (True, ordered[matched_indices[0]].class_id, [])
        if len(matched_indices) == 0:
            if config.default_class_id:
                return (True, config.default_class_id, [])
            return (True, None, [])
        res = config.ambiguous_match_resolution
        if res == "by_priority":
            # Один класс: правило с минимальным priority; при равенстве — более ранний индекс в ordered.
            bi = min(matched_indices, key=lambda i: (ordered[i].priority, i))
            return (True, ordered[bi].class_id, [])
        # comma_join (и устаревший reject): склеиваем уникальные class_id в порядке появления правил в списке.
        seen: set[str] = set()
        parts: List[str] = []
        for i in matched_indices:
            cid = ordered[i].class_id
            if cid not in seen:
                seen.add(cid)
                parts.append(cid)
        return (True, ",".join(parts), [])

    return (False, None, [ClassificationError(message=f"Unknown classification strategy: {config.strategy}")])


def semantic_candidate_matches_class_rule(
    data: Any,
    config: Optional[ClassificationConfig],
    candidate_class_id: str,
) -> tuple[bool, Optional[str]]:
    """
    Проверка ветки README RuleMatch2: извлечённые признаки не противоречат правилу для класса-кандидата.

    Возвращает (True, None) если правила для класса нет (нечего проверять) или условия выполняются;
    (False, message_ru) если правило есть и данные ему не соответствуют.
    """
    rule = find_classification_rule_for_class_id(config, candidate_class_id)
    if rule is None:
        return True, None
    if _rule_matches(data, rule):
        return True, None
    rule_name = (rule.title or "").strip() or (rule.class_id or "").strip() or candidate_class_id.strip()
    mismatch = _semantic_rule_mismatch_details_ru(data, rule)
    return (
        False,
        "Извлечённые значения не удовлетворяют условиям классификации справочника для класса, "
        f"выбранного по схожести с эталонами. Не выполнено правило: «{rule_name}»"
        f". А именно: {mismatch}.",
    )
