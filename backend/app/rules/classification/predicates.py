"""
Предикаты условий правила определения класса: числа, пути, таблица показателей, RuleMatcher.

Используются движком классификации и анализом логических пересечений (analysis.overlap).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from ..cross_rules import _compare
from ..dsl_models import (
    CANONICAL_DESCRIPTION_PATH,
    DESCRIPTION_PATH_ALIASES,
    ClassificationCondition,
    ClassificationRule,
    PathClassificationCondition,
    RowIndicatorCondition,
    RowPairRatioCondition,
    RowFormulaCondition,
)
from ..primitives.formula_safe_eval import eval_numeric_formula
from ..primitives.numeric_cell import coerce_numeric_cell_to_scalar, numeric_interval_from_cell
from ..primitives.path_utils import extract_first_value, extract_values

# Максимум относительной погрешности для rowPairRatio при сравнении фактического отношения value(left)/value(right)
_MAX_ROW_PAIR_RATIO_TOLERANCE_REL = 0.1

# gt (строго больше), gte (не меньше), lt (строго меньше), lte (не более).
_PATH_NUMERIC_OPS = frozenset({"equals", "gt", "gte", "lt", "lte"})


def _relative_slack_around_threshold(threshold: float, tolerance_rel: float) -> float:
    """Полоса у порога: tolerance_rel · max(|порог|, ε). При 0 — без расширения."""
    t = max(0.0, float(tolerance_rel))
    if t <= 0:
        return 0.0
    return t * max(abs(float(threshold)), 1e-12)


def scalar_numeric_op_feasible_interval(
    op: str, threshold: float, tolerance_rel: float
) -> Optional[Tuple[float, float]]:
    """
    Образ на числовой оси значений, удовлетворяющих одному скалярному сравнению с порогом
    (как в рантайме при tolerance_rel). Для анализа пересечений правил.
    """
    v = float(threshold)
    slack = _relative_slack_around_threshold(v, tolerance_rel)
    if op == "gt":
        return v - slack + 1e-12, float("inf")
    if op == "gte":
        return v - slack, float("inf")
    if op == "lt":
        return float("-inf"), v + slack - 1e-12
    if op == "lte":
        return float("-inf"), v + slack
    if op == "equals":
        tol = max(0.0, float(tolerance_rel))
        if tol <= 0:
            return v, v
        b = tol * max(abs(v), 1e-12)
        return v - b, v + b
    return None


def _numeric_compare_with_tolerance(lhs: float, op: str, rhs: float, tolerance_rel: float) -> bool:
    """Числовое сравнение с относительным допуском (0 — как строгое сравнение)."""
    t = max(0.0, float(tolerance_rel))
    if op == "equals":
        scale = max(abs(lhs), abs(rhs), 1e-12)
        return abs(lhs - rhs) <= t * scale
    slack = _relative_slack_around_threshold(rhs, t)
    if op == "gt":
        return lhs > rhs - slack
    if op == "gte":
        return lhs >= rhs - slack
    if op == "lt":
        return lhs < rhs + slack
    if op == "lte":
        return lhs <= rhs + slack
    return False


def _path_left_as_float(left: Any) -> Optional[float]:
    c = coerce_numeric_cell_to_scalar(left)
    if c is not None:
        return c
    try:
        return float(left)
    except (TypeError, ValueError):
        return None


def _effective_row_indicator_bounds(cond: RowIndicatorCondition) -> Tuple[Optional[float], Optional[float]]:
    """value_min/value_max с расширением коридора при tolerance_rel > 0."""
    tol = max(0.0, float(cond.tolerance_rel))
    vmin = cond.value_min
    vmax = cond.value_max
    if vmin is not None:
        fv = float(vmin)
        vmin = fv - _relative_slack_around_threshold(fv, tol)
    if vmax is not None:
        fv = float(vmax)
        vmax = fv + _relative_slack_around_threshold(fv, tol)
    return vmin, vmax


def _row_indicator_value_matches_range(lf: float, cond: RowIndicatorCondition) -> bool:
    """Проверяет числовое значение индикатора по диапазону из условия (с учётом tolerance_rel)."""
    vmin, vmax = _effective_row_indicator_bounds(cond)
    if vmin is not None and vmax is not None:
        return vmin <= lf <= vmax
    if vmin is not None:
        return lf >= vmin
    if vmax is not None:
        return lf <= vmax
    return False


def _row_indicator_data_interval_inside_rule_range(
    d_lo: float, d_hi: float, cond: RowIndicatorCondition
) -> bool:
    """Весь отрезок [d_lo, d_hi] из ячейки должен лежать в коридоре правила (с учётом tolerance_rel)."""
    vmin, vmax = _effective_row_indicator_bounds(cond)
    if vmin is not None and vmax is not None:
        return vmin <= d_lo and d_hi <= vmax
    if vmin is not None:
        return d_lo >= vmin
    if vmax is not None:
        return d_hi <= vmax
    return False


def row_indicator_numeric_value_satisfies(lf: float, cond: RowIndicatorCondition) -> bool:
    """
    Проверка числа для ячейки так же, как в рантайме при подстановке одного числового значения
    (без обхода массива строк). Используется анализом пересечений правил.
    """
    has_range = cond.value_min is not None or cond.value_max is not None
    if has_range:
        return _row_indicator_value_matches_range(lf, cond)
    if cond.op is not None and str(cond.op) in _PATH_NUMERIC_OPS and cond.value is not None:
        try:
            rhs = float(cond.value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return bool(_compare(lf, cond.op, cond.value))
        tol = max(0.0, float(cond.tolerance_rel))
        return _numeric_compare_with_tolerance(lf, str(cond.op), rhs, tol)
    if cond.op is not None:
        return bool(_compare(lf, cond.op, cond.value))
    return False


def _path_compare_one(left: Any, cond: PathClassificationCondition) -> bool:
    op = str(cond.op)
    if op in _PATH_NUMERIC_OPS and cond.value is not None:
        lf = _path_left_as_float(left)
        if lf is not None:
            try:
                rhs = float(cond.value)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                pass
            else:
                tol = max(0.0, float(cond.tolerance_rel))
                return _numeric_compare_with_tolerance(lf, op, rhs, tol)
    return bool(_compare(left, cond.op, cond.value))


def _rule_first_match_tiebreak_score(rule: ClassificationRule) -> float:
    """
    Эвристика «строгости» при равном priority: выше score — предпочтительнее при first_match.
    Нижняя граница порога (gte — не меньше, gt — строго больше) увеличивает score;
    верхняя (lte — не более, lt — строго меньше) — отрицательное смещение.
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
    3) Внутри слоя с одинаковым priority — максимум tiebreak_score (более высокий нижний порог gte — не меньше, и т.п.).
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


class ConditionEvaluator:
    """
    Проверка одной строки подраздела «Условия» правила определения класса на признаках декларации.

    Тип условия в DSL соответствует выбору в «Что проверяем» интерфейса эксперта: поле структуры,
    таблица показателей, отношение показателей, формула.
    """

    def evaluate(self, data: Any, cond: ClassificationCondition) -> bool:
        """Истинно, если извлечённые признаки data удовлетворяют данному условию."""
        if isinstance(cond, PathClassificationCondition):
            return self._path_holds(data, cond)
        if isinstance(cond, RowIndicatorCondition):
            return _row_indicator_holds(data, cond)
        if isinstance(cond, RowPairRatioCondition):
            return _row_pair_ratio_holds(data, cond)
        if isinstance(cond, RowFormulaCondition):
            return _row_formula_holds(data, cond)
        raise TypeError(f"Unknown classification condition: {type(cond)}")

    @staticmethod
    def _description_candidates(data: Any) -> List[Any]:
        """
        Текст для проверки «Полное описание декларации».

        В подразделе «Условия» источник «Полное описание декларации» и режим «Полный текст описания»
        соответствуют каноническому пути description_text в DSL. В признаковом JSON после извлечения
        характеристик LLM или контура инспектора текст может оказаться под ключом description_text
        или description; при сохранении правила оба варианта пути в DSL приводятся к description_text,
        а при проверке декларации читаются оба ключа, чтобы условие «значение указано», «содержит»,
        «соответствует регулярному выражению» и т. п. сработало независимо от имени поля в ответе
        сервиса предобработки. Дубликаты одного и того же текста в обоих полях не учитываются дважды.
        """
        if not isinstance(data, dict):
            return []
        out: List[Any] = []
        # DESCRIPTION_PATH_ALIASES = {"description", "description_text"} — см. dsl_models.
        for key in DESCRIPTION_PATH_ALIASES:
            val = data.get(key)
            if val is not None:
                out.append(val)
        # Один и тот же текст могут продублировать в оба поля — для op exists/regex достаточно одной копии.
        seen: set[str] = set()
        uniq: List[Any] = []
        for item in out:
            marker = repr(item)
            if marker in seen:
                continue
            seen.add(marker)
            uniq.append(item)
        return uniq

    @classmethod
    def _extract_path_values(cls, data: Any, path: str) -> List[Any]:
        """Значения по выбранному полю структуры признаков; для полного описания — см. _description_candidates."""
        if path == CANONICAL_DESCRIPTION_PATH:
            return cls._description_candidates(data)
        return extract_values(data, path)

    @classmethod
    def _path_holds(cls, data: Any, cond: PathClassificationCondition) -> bool:
        """
        Условие по полю структуры декларации.

        Если по одному полю в признаках несколько значений, для обычных сравнений достаточно одного
        истинного (дизъюнкция по повторениям поля); для «не равно» и «не соответствует regex» — все.
        """
        values = cls._extract_path_values(data, cond.path)
        if cond.op == "exists":
            return bool(values)
        if cond.op == "notExists":
            return not values
        if not values:
            # Для description_text отдельный extract_first_value не вызываем — кандидаты уже собраны выше.
            left = extract_first_value(data, cond.path) if cond.path != CANONICAL_DESCRIPTION_PATH else None
            return _path_compare_one(left, cond)
        # Отрицание: все вхождения по пути должны удовлетворять; обычное сравнение — хотя бы одно.
        if cond.op in ("notEquals", "notRegex"):
            return all(_path_compare_one(left, cond) for left in values)
        return any(_path_compare_one(left, cond) for left in values)


class RuleMatcher:
    """
    Проверка, подходит ли правило определения класса к признакам декларации.

    Учитывает флажок «Основное условие», группы с логическим «и» внутри группы и «или» между
    группами. Используется при валидации декларации и при сборке примера
    для экрана логических пересечений.
    """

    def __init__(self, evaluator: Optional[ConditionEvaluator] = None) -> None:
        self._evaluator = evaluator or ConditionEvaluator()

    def condition_holds(self, data: Any, cond: ClassificationCondition) -> bool:
        return self._evaluator.evaluate(data, cond)

    def _evaluate_primary_chain(self, data: Any, conds: List[ClassificationCondition]) -> bool:
        """Связка условий по полю conjunction у каждого условия после первого (как в плоском списке DSL)."""
        if not conds:
            return True
        result = self.condition_holds(data, conds[0])
        # У каждого условия после первого своя связка «и»/«или» с предыдущим результатом.
        for cond in conds[1:]:
            if _condition_conjunction(cond) == "or":
                result = result or self.condition_holds(data, cond)
            else:
                result = result and self.condition_holds(data, cond)
        return result

    def rule_matches_by_groups(self, data: Any, conditions: List[ClassificationCondition]) -> bool:
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
        # Стратегия «групп»: достаточно, чтобы полностью выполнилась любая группа условий.
        for group_id in order:
            group_conds = groups[group_id]
            if not group_conds:
                continue
            if self._evaluate_primary_chain(data, group_conds):
                return True
        return False

    def rule_matches(self, data: Any, rule: ClassificationRule) -> bool:
        if not rule.conditions:
            return True
        primary_conds = [c for c in rule.conditions if _condition_is_primary(c)]
        to_check = primary_conds if primary_conds else rule.conditions
        if any(_condition_group_id(cond) for cond in to_check):
            return self.rule_matches_by_groups(data, to_check)
        return self._evaluate_primary_chain(data, to_check)


_DEFAULT_RULE_MATCHER = RuleMatcher()


def _normalized_rule_class_id(rule: ClassificationRule) -> str:
    return (rule.class_id or "").strip()


def _rule_refinement_holds(data: Any, rule: ClassificationRule) -> bool:
    """Уточняющие условия (primary=False): если их нет — считаем выполненными."""
    refining = [c for c in (rule.conditions or []) if not _condition_is_primary(c)]
    if not refining:
        return True
    probe = ClassificationRule(
        class_id=rule.class_id,
        title=rule.title,
        priority=rule.priority,
        tn_ved_group_code=rule.tn_ved_group_code,
        condition_groups=list(rule.condition_groups or []),
        conditions=refining,
    )
    return _DEFAULT_RULE_MATCHER.rule_matches(data, probe)


def _narrow_first_match_by_refinements_when_multi_class(
    data: Any,
    matches: List[ClassificationRule],
) -> List[ClassificationRule]:
    """
    Если по основным подошли правила минимум двух разных классов — оставляем те,
    у которых выполняются и уточняющие условия; при пустом результате возвращаем исходный набор.
    """
    if len(matches) <= 1:
        return matches
    classes = {_normalized_rule_class_id(r) for r in matches if _normalized_rule_class_id(r)}
    if len(classes) < 2:
        return matches
    refined = [r for r in matches if _rule_refinement_holds(data, r)]
    return refined if refined else matches


def _rule_matches(data: Any, rule: ClassificationRule) -> bool:
    """Проверяет, выполняется ли правило классификации для данных."""
    return _DEFAULT_RULE_MATCHER.rule_matches(data, rule)


def _condition_holds(data: Any, cond: ClassificationCondition) -> bool:
    """Диспетчер проверки одного условия по его типу."""
    return _DEFAULT_RULE_MATCHER.condition_holds(data, cond)


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
            span = numeric_interval_from_cell(left)
            if span is None:
                continue
            d_lo, d_hi = span
            if _row_indicator_data_interval_inside_rule_range(d_lo, d_hi, cond):
                return True
            continue
        if cond.op is not None:
            if str(cond.op) in _PATH_NUMERIC_OPS and cond.value is not None:
                lf = _path_left_as_float(left)
                if lf is not None:
                    try:
                        rhs = float(cond.value)  # type: ignore[arg-type]
                    except (TypeError, ValueError):
                        pass
                    else:
                        tol = max(0.0, float(cond.tolerance_rel))
                        if _numeric_compare_with_tolerance(lf, str(cond.op), rhs, tol):
                            return True
                        continue
            if _compare(left, cond.op, cond.value):
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

