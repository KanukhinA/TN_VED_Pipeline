"""
Совместимость пары правил классификации для API «анализ пересечений».

Идея: ответ «два правила могли бы сработать на одних и тех же данных» должен опираться на те же
предикаты, что и _rule_matches на декларации, а не на упрощённые отрезки на оси. Поэтому:

- path: объединяем все PathClassificationCondition с одним path из обоих правил и ищем значение,
  удовлетворяющее конъюнкции (см. _feasible_value_for_path_conditions).
- rowIndicator: группируем по одной логической строке таблицы (массив, поле имени, значение имени показателя)
  и по полю числа; для числовых ограничений ищем число так же строго, как в рантайме — для min+max это
  не весь отрезок [min,max], а узкая окрестность середины (как в classification._row_indicator_value_matches_range).
- rowPairRatio / rowFormula: проверка явных противоречий пропорций и совпадающих формул с equals.

analyze_rules_overlap собирает человекочитаемые пояснения (риск «двух коридоров», упрощение при «или»/группах,
кто бы победил по priority при одновременном матче).
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .classification import (
    _MAX_ROW_PAIR_RATIO_TOLERANCE_REL,
    _condition_is_primary,
    _condition_group_id,
    _rule_first_match_tiebreak_score,
    _rule_matches,
    row_indicator_numeric_value_satisfies,
    scalar_numeric_op_feasible_interval,
    select_rule_for_first_match,
)
from .dsl_models import (
    ClassificationCondition,
    ClassificationRule,
    PathClassificationCondition,
    RowIndicatorCondition,
    RowPairRatioCondition,
    RowFormulaCondition,
)
from .path_utils import parse_path

# Как в интерфейсе мастера правил (ClassificationRulesPanel): не показывать пользователю внутренние имена DSL.
_UI_CONDITION_RATIO = "Отношение двух показателей (A : B = …)"
_UI_CONDITION_FORMULA = "Формула по нескольким показателям"
_UI_CONDITION_TABLE_NUMBER = "число в строке таблицы (условие «У поля с таким значением, диапазон числа»)"
_UI_CONDITION_SCALAR = "числовое сравнение на поле декларации"


def _is_primary(cond: Any) -> bool:
    return bool(getattr(cond, "primary", True))


def _primary_and_conjunction_conds(rule: ClassificationRule) -> list[ClassificationCondition]:
    """
    Условия, которые участвуют в упрощённом анализе пересечений:
    только primary и со связкой «and». Связки «or» и group_id здесь не разворачиваются —
    на это указывает rule_uses_or_or_groups и текст simplified_analysis_note_ru.
    """
    return [
        c
        for c in (rule.conditions or [])
        if _is_primary(c) and getattr(c, "conjunction", "and") == "and"
    ]


def row_indicator_group_key(
    c: RowIndicatorCondition,
) -> tuple[str, str, str]:
    """
    Ключ строки таблицы: тот же смысл, что при сопоставлении в движке
    (name_equals как в правиле, без приведения регистра).
    """
    return (
        str(c.array_path).strip(),
        str(c.name_field).strip(),
        str(c.name_equals).strip(),
    )


def rule_uses_or_or_groups(rule: ClassificationRule) -> bool:
    """Если True — полная семантика _rule_matches сложнее конъюнкции primary+and; предупреждаем в ответе API."""
    for c in rule.conditions or []:
        if not _is_primary(c):
            continue
        if getattr(c, "conjunction", "and") == "or":
            return True
        if _condition_group_id(c):
            return True
    return False


def _numeric_interval_from_path(cond: PathClassificationCondition) -> Optional[tuple[float, float]]:
    """Допустимый интервал для скалярного сравнения по полю (gt/gte/lt/lte/equals) при объединении условий на одном path."""
    op = str(cond.op)
    val = cond.value
    tol = max(0.0, float(cond.tolerance_rel))
    try:
        v = float(val)
    except (TypeError, ValueError):
        return None
    return scalar_numeric_op_feasible_interval(op, v, tol)


def _fmt_overlap_num(x: float) -> str:
    """Человекочитаемое число для текстов пересечений диапазонов."""
    if x == float("inf"):
        return "+∞"
    if x == float("-inf"):
        return "−∞"
    if x != x:  # nan
        return "нечисло"
    if abs(x - round(x)) < 1e-9:
        return str(int(round(x)))
    s = f"{round(x, 6)}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def _intersect_axis_intervals(segs: list[tuple[float, float]]) -> Optional[tuple[float, float]]:
    if not segs:
        return None
    lo = max(s[0] for s in segs)
    hi = min(s[1] for s in segs)
    if lo > hi:
        return None
    return lo, hi


def _path_cond_numeric_piece(
    c: PathClassificationCondition, rule_lbl: str
) -> Optional[tuple[tuple[float, float], str]]:
    op = str(c.op)
    if op == "equals":
        try:
            x = float(c.value)
            return (x, x), f"«{rule_lbl}»: равно {_fmt_overlap_num(x)}"
        except (TypeError, ValueError):
            return None
    if op in ("gt", "gte", "lt", "lte"):
        inter = _numeric_interval_from_path(c)
        if inter is None:
            return None
        try:
            fv = float(c.value)
            xs = _fmt_overlap_num(fv)
        except (TypeError, ValueError):
            xs = str(c.value)
        if op == "gt":
            human = f"«{rule_lbl}»: строго больше {xs}"
        elif op == "gte":
            human = f"«{rule_lbl}»: не меньше {xs}"
        elif op == "lt":
            human = f"«{rule_lbl}»: строго меньше {xs}"
        else:
            human = f"«{rule_lbl}»: не больше {xs}"
        return inter, human
    return None


def _row_cond_numeric_piece(
    c: RowIndicatorCondition, rule_lbl: str
) -> Optional[tuple[tuple[float, float], str]]:
    if c.value_min is not None or c.value_max is not None:
        inter0 = _numeric_interval_from_row_indicator_legacy(c)
        if inter0 is None:
            return None
        lo, hi = inter0
        if c.value_min is not None and c.value_max is not None:
            return (lo, hi), f"«{rule_lbl}»: от {_fmt_overlap_num(lo)} до {_fmt_overlap_num(hi)}"
        if c.value_min is not None and c.value_max is None:
            return (lo, float("inf")), f"«{rule_lbl}»: не меньше {_fmt_overlap_num(lo)}"
        return (float("-inf"), hi), f"«{rule_lbl}»: не больше {_fmt_overlap_num(hi)}"
    inter = _numeric_interval_from_row_indicator_legacy(c)
    if inter is None:
        return None
    op = str(c.op or "")
    try:
        fv = float(c.value)
        xs = _fmt_overlap_num(fv)
    except (TypeError, ValueError):
        xs = str(c.value)
    if op == "gt":
        human = f"«{rule_lbl}»: строго больше {xs}"
    elif op == "gte":
        human = f"«{rule_lbl}»: не меньше {xs}"
    elif op == "lt":
        human = f"«{rule_lbl}»: строго меньше {xs}"
    elif op == "lte":
        human = f"«{rule_lbl}»: не больше {xs}"
    elif op == "equals":
        human = f"«{rule_lbl}»: равно {xs}"
    else:
        human = f"«{rule_lbl}»: числовое ограничение"
    return inter, human


def _tagged_primary_conds(
    per_conds: list[list[ClassificationCondition]],
    titles: Sequence[str],
) -> list[tuple[ClassificationCondition, str]]:
    out: list[tuple[ClassificationCondition, str]] = []
    for idx, pc in enumerate(per_conds):
        lbl = titles[idx]
        for c in pc:
            out.append((c, lbl))
    return out


def _range_intersection_descriptions(
    per_conds: list[list[ClassificationCondition]],
    titles: Sequence[str],
) -> list[str]:
    """
    Явно перечисляет числовые отрезки по одному path и по одной ячейке таблицы (показатель + поле числа)
    и пересечение на оси, если условий с числом два и больше.
    """
    tagged = _tagged_primary_conds(per_conds, titles)
    lines: list[str] = []

    by_path: dict[str, list[tuple[PathClassificationCondition, str]]] = {}
    for c, lbl in tagged:
        if isinstance(c, PathClassificationCondition):
            by_path.setdefault(str(c.path).strip(), []).append((c, lbl))

    for path, plist in by_path.items():
        pieces: list[tuple[tuple[float, float], str]] = []
        for c, lbl in plist:
            p = _path_cond_numeric_piece(c, lbl)
            if p:
                pieces.append((p[0], p[1]))
        if len(pieces) < 2:
            continue
        segs = [x[0] for x in pieces]
        inter = _intersect_axis_intervals(segs)
        parts_txt = "; ".join(x[1] for x in pieces)
        if inter is None:
            lines.append(
                f"По полю «{path}»: {parts_txt}. На числовой оси общего пересечения нет (интервалы не накладываются)."
            )
        else:
            lo, hi = inter
            lines.append(
                f"По полю «{path}»: {parts_txt}. Пересечение на числовой оси: от {_fmt_overlap_num(lo)} до {_fmt_overlap_num(hi)}."
            )

    by_row: dict[tuple[str, str, str], list[tuple[RowIndicatorCondition, str]]] = {}
    for c, lbl in tagged:
        if isinstance(c, RowIndicatorCondition):
            by_row.setdefault(row_indicator_group_key(c), []).append((c, lbl))

    for key, rlist in by_row.items():
        ap, _nf, ne = key
        by_vf: dict[str, list[tuple[RowIndicatorCondition, str]]] = {}
        for c, lbl in rlist:
            by_vf.setdefault(str(c.value_field).strip(), []).append((c, lbl))
        for vf, vlist in by_vf.items():
            pieces: list[tuple[tuple[float, float], str]] = []
            mid_notes: list[str] = []
            for c, lbl in vlist:
                p = _row_cond_numeric_piece(c, lbl)
                if p:
                    pieces.append((p[0], p[1]))
                if c.value_min is not None and c.value_max is not None:
                    mid = (float(c.value_min) + float(c.value_max)) / 2.0
                    mid_notes.append(f"для «{lbl}» середина коридора ≈ {_fmt_overlap_num(mid)}")
            if len(pieces) < 2:
                continue
            segs = [x[0] for x in pieces]
            inter = _intersect_axis_intervals(segs)
            parts_txt = "; ".join(x[1] for x in pieces)
            mid_txt = (
                f" При проверке декларации для пар «min–max» сравнение идёт с узкой целью у середины: {', '.join(mid_notes)}."
                if mid_notes
                else ""
            )
            if inter is None:
                lines.append(
                    f"Показатель «{ne}», поле «{vf}» (таблица «{ap}»): {parts_txt}. На числовой оси общего пересечения нет."
                )
            else:
                lo, hi = inter
                lines.append(
                    f"Показатель «{ne}», поле «{vf}» (таблица «{ap}»): {parts_txt}. "
                    f"Пересечение коридоров на оси: от {_fmt_overlap_num(lo)} до {_fmt_overlap_num(hi)}.{mid_txt}"
                )

    return lines


def _overlap_axis_headline_ru(range_lines: list[str]) -> Optional[str]:
    """Краткая строка для UI: суть пересечения по оси без дублирования длинных пояснений."""
    if not range_lines:
        return None
    for ln in range_lines:
        if "На числовой оси общего пересечения нет" in ln or "общего пересечения нет" in ln:
            return "Общего числового пересечения по этим условиям нет."
        for key in ("Пересечение коридоров на оси:", "Пересечение на числовой оси:"):
            if key in ln:
                tail = ln.split(key, 1)[1].strip()
                if " При проверке декларации" in tail:
                    tail = tail.split(" При проверке декларации", 1)[0].strip()
                if tail:
                    return f"Пересечение по числу: {tail}"
    first = range_lines[0].strip()
    return first if len(first) <= 260 else first[:257] + "…"


def _path_field_short(path: str) -> str:
    p = str(path).strip()
    if not p:
        return "поле"
    return p.split(".")[-1]


def _fmt_scalar_compact(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "да" if value else "нет"
    if isinstance(value, (int, float)):
        return _fmt_overlap_num(float(value))
    return str(value)


def _path_ultracompact(c: PathClassificationCondition) -> Optional[str]:
    op = str(c.op)
    if op in ("exists", "notExists", "notEquals", "notIn", "notRegex", "in"):
        return None
    short = _path_field_short(str(c.path))
    if op == "equals":
        return f"{short}={_fmt_scalar_compact(c.value)}"
    if op == "gt":
        return f"{short}>{_fmt_scalar_compact(c.value)}"
    if op == "gte":
        return f"{short}≥{_fmt_scalar_compact(c.value)}"
    if op == "lt":
        return f"{short}<{_fmt_scalar_compact(c.value)}"
    if op == "lte":
        return f"{short}≤{_fmt_scalar_compact(c.value)}"
    return None


def _row_indicator_ultracompact(c: RowIndicatorCondition) -> Optional[str]:
    ne = str(c.name_equals).strip() or "?"
    if c.value_min is not None and c.value_max is not None:
        lo, hi = float(c.value_min), float(c.value_max)
        return f"{ne}[{_fmt_overlap_num(lo)}–{_fmt_overlap_num(hi)}]"
    if c.value_min is not None and c.value_max is None:
        return f"{ne}≥{_fmt_overlap_num(float(c.value_min))}"
    if c.value_max is not None and c.value_min is None:
        return f"{ne}≤{_fmt_overlap_num(float(c.value_max))}"
    op = str(c.op or "")
    try:
        fv = float(c.value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    vs = _fmt_overlap_num(fv)
    if op == "gt":
        return f"{ne}>{vs}"
    if op == "gte":
        return f"{ne}≥{vs}"
    if op == "lt":
        return f"{ne}<{vs}"
    if op == "lte":
        return f"{ne}≤{vs}"
    if op == "equals":
        return f"{ne}={vs}"
    return None


def _pair_ratio_ultracompact(c: RowPairRatioCondition) -> str:
    ln = str(c.left_name).strip()
    rn = str(c.right_name).strip()
    rl = float(c.ratio_left)
    rr = float(c.ratio_right)
    return f"{ln}/{rn}≈{_fmt_overlap_num(rl)}:{_fmt_overlap_num(rr)}"


def _formula_ultracompact(c: RowFormulaCondition) -> str:
    return f"({c.formula}) {c.op} {_fmt_scalar_compact(c.value)}"


def compact_numeric_constraints_for_rule(rule: ClassificationRule) -> str:
    """Компактные числовые условия правила (primary + «и») — для колонок в UI пересечений."""
    parts: list[str] = []
    for c in _primary_and_conjunction_conds(rule):
        if isinstance(c, RowIndicatorCondition):
            s = _row_indicator_ultracompact(c)
            if s:
                parts.append(s)
        elif isinstance(c, PathClassificationCondition):
            s = _path_ultracompact(c)
            if s:
                parts.append(s)
        elif isinstance(c, RowPairRatioCondition):
            parts.append(_pair_ratio_ultracompact(c))
        elif isinstance(c, RowFormulaCondition):
            parts.append(_formula_ultracompact(c))
    return " ".join(parts) if parts else "—"


def _adjustment_recommendations_ru(
    rules: Sequence[ClassificationRule],
    *,
    overlaps: bool,
    corridor_risk: bool,
    range_lines: list[str],
    adv_infeasible: bool,
    has_or_groups_simplification: bool,
    path_or_row_infeasible: bool,
    empty_primary_conds: bool = False,
) -> list[str]:
    recs: list[str] = []
    if empty_primary_conds:
        recs.append(
            "Добавьте в правила сопоставимые обязательные условия (поле декларации или строка таблицы с числом), иначе пересечения нечего анализировать."
        )
    if adv_infeasible:
        recs.append(
            "Согласуйте между правилами пропорции показателей или целевые значения формулы; при необходимости вынесите взаимоисключающие условия в разные классы."
        )
    if corridor_risk:
        recs.append(
            "Для пар условий «от … до …» по одной ячейке: сузьте или разведите границы так, чтобы совпадали «цели» у середины каждого коридора (с учётом допуска), либо замените одно из условий на одностороннее (≥ или ≤)."
        )
    if path_or_row_infeasible and not corridor_risk:
        recs.append(
            "Согласуйте числовые ограничения по указанному полю или показателю: ослабьте порог, измените границы диапазона или разведите классы по непересекающимся отрезкам."
        )
    if overlaps and range_lines:
        recs.append(
            "Чтобы исключить одновременное попадание в несколько классов по числам, задайте непересекающиеся диапазоны/пороги на оси или явно разведите приоритеты правил."
        )
    if overlaps and len(rules) >= 2:
        prios = {int(r.priority) for r in rules}
        if len(prios) == 1:
            recs.append(
                "Сейчас у правил одинаковый приоритет: задайте разные числа приоритета (меньше — важнее) или ужесточите условия так, чтобы оставался один однозначный класс."
            )
    if has_or_groups_simplification:
        recs.append(
            "Проверьте вручную связки «или» и группы условий: автоматический разбор здесь использует только основные условия с «и»."
        )
    if overlaps and not range_lines and not adv_infeasible and not has_or_groups_simplification:
        recs.append(
            "Дополнительно проверьте пропорции, формулы и текстовые условия — они могут различать классы даже при совпадении числовых коридоров."
        )
    # уникальные, порядок сохраняем
    seen: set[str] = set()
    out: list[str] = []
    for r in recs:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def _numeric_interval_from_row_indicator_legacy(cond: RowIndicatorCondition) -> Optional[tuple[float, float]]:
    """Грубые отрезки для «сырых» коридоров min–max (подсветка риска спецификации)."""
    if cond.value_min is not None or cond.value_max is not None:
        lo = float(cond.value_min) if cond.value_min is not None else float("-inf")
        hi = float(cond.value_max) if cond.value_max is not None else float("inf")
        tol = max(0.0, float(cond.tolerance_rel))
        if lo != float("-inf"):
            lo -= tol * max(abs(lo), 1e-12)
        if hi != float("inf"):
            hi += tol * max(abs(hi), 1e-12)
        return lo, hi
    op = cond.op
    try:
        v = float(cond.value)
    except Exception:
        return None
    inter = scalar_numeric_op_feasible_interval(str(op or ""), v, max(0.0, float(cond.tolerance_rel)))
    return inter


def _pair_ratio_key(c: RowPairRatioCondition) -> tuple[str, str, str, str, str]:
    return (
        str(c.array_path).strip(),
        str(c.name_field).strip(),
        str(c.value_field).strip(),
        str(c.left_name).strip().lower(),
        str(c.right_name).strip().lower(),
    )


def _ratio_satisfies_spec(actual: float, expected: float, tolerance_rel: float) -> bool:
    """Один фактический множитель отношения v_left/v_right против ожидаемого ratio_left/ratio_right (как в классификаторе)."""
    if actual <= 0 or actual != actual:
        return False
    t = min(float(tolerance_rel), _MAX_ROW_PAIR_RATIO_TOLERANCE_REL)
    scale = max(abs(expected), abs(actual), 1e-12)
    return abs(actual - expected) <= t * scale


def _row_pair_ratio_specs_feasible(specs: list[tuple[float, float]]) -> bool:
    """
    Несколько rowPairRatio на одну и ту же пару компонентов: существует ли положительное отношение R = v_left/v_right,
    одновременно удовлетворяющее всем (expected_i, tolerance_i). Явного решения нет — перебираем R по логарифмической сетке.
    """
    if len(specs) <= 1:
        return True
    clamped = [(float(e), float(t)) for e, t in specs]
    abs_es = [abs(e) for e, _ in clamped if abs(e) > 1e-15]
    if not abs_es:
        return True
    # Диапазон перебора: от масштаба минимального ожидаемого отношения до максимального (широкий, чтобы поймать пересечение допусков).
    lo = min(abs_es) * 1e-9
    hi = max(abs_es) * 1e9
    if hi <= lo:
        hi = lo * 1e6
    steps = 400
    for i in range(steps + 1):
        r = lo * (hi / lo) ** (i / steps)
        ok = True
        for e, t in clamped:
            if not _ratio_satisfies_spec(r, e, t):
                ok = False
                break
        if ok:
            return True
    return False


def _row_formula_group_key(c: RowFormulaCondition) -> tuple:
    return (
        str(c.array_path).strip(),
        str(c.name_field).strip(),
        str(c.value_field).strip(),
        frozenset((str(k).strip(), str(v).strip().lower()) for k, v in sorted((c.variables or {}).items())),
        str(c.formula).strip(),
        str(c.op),
    )


def _row_formula_equals_targets_feasible(conds: list[RowFormulaCondition]) -> bool:
    """Одинаковая формула и variables: пересекаются ли интервалы целевого value при относительных допусках equals."""
    if len(conds) < 2:
        return True
    lo_b = float("-inf")
    hi_b = float("inf")
    for c in conds:
        v = float(c.value)
        t = float(c.tolerance_rel)
        scale = max(abs(v), 1e-12)
        lo_b = max(lo_b, v - t * scale)
        hi_b = min(hi_b, v + t * scale)
    return lo_b <= hi_b + 1e-9


def _advanced_overlap_feasible(advanced: list[Any]) -> tuple[bool, Optional[str]]:
    """
    Только rowPairRatio и rowFormula: без path/rowIndicator проверяем лишь явные числовые противоречия
    (разные пропорции на одной паре; разные цели equals для одной формулы).
    """
    ratios = [c for c in advanced if isinstance(c, RowPairRatioCondition)]
    formulas = [c for c in advanced if isinstance(c, RowFormulaCondition)]

    by_pr: dict[tuple[str, str, str, str, str], list[RowPairRatioCondition]] = {}
    for c in ratios:
        by_pr.setdefault(_pair_ratio_key(c), []).append(c)
    for key, lst in by_pr.items():
        specs = [(c.ratio_left / c.ratio_right, c.tolerance_rel) for c in lst]
        if not _row_pair_ratio_specs_feasible(specs):
            left_n, right_n = key[3], key[4]
            return False, (
                f"Условия «{_UI_CONDITION_RATIO}» для пары показателей «{left_n}» и «{right_n}» в таблице «{key[0]}» "
                f"несовместимы: не существует таких значений в строках, чтобы одновременно выполнились все заданные пропорции с допусками."
            )

    by_fk: dict[tuple, list[RowFormulaCondition]] = {}
    for c in formulas:
        by_fk.setdefault(_row_formula_group_key(c), []).append(c)
    for _fk, lst in by_fk.items():
        if len(lst) < 2:
            continue
        op = str(lst[0].op)
        if op != "equals":
            continue
        if not _row_formula_equals_targets_feasible(lst):
            return False, (
                f"Условия «{_UI_CONDITION_FORMULA}» с одинаковым выражением и теми же показателями задают несовместимые "
                f"целевые значения при сравнении «равно» (с учётом относительных допусков)."
            )
    return True, None


def _required_component_names_from_advanced(conds: list[Any]) -> set[str]:
    out: set[str] = set()
    for c in conds:
        if isinstance(c, RowPairRatioCondition):
            out.add(str(c.left_name).strip().lower())
            out.add(str(c.right_name).strip().lower())
        elif isinstance(c, RowFormulaCondition):
            for _k, v in (c.variables or {}).items():
                s = str(v).strip().lower()
                if s:
                    out.add(s)
    return out


def _row_indicators_all_numeric(conds: list[RowIndicatorCondition]) -> bool:
    """
    True, если все условия можно проверить одним вещественным числом (диапазоны min/max, числовые сравнения).
    Если есть нечисловое equals и т.п. — переходим на запасную ветку слияния «грубых» интервалов.
    """
    for c in conds:
        if c.value_min is not None or c.value_max is not None:
            continue
        op = str(c.op or "")
        if op in ("gt", "gte", "lt", "lte", "equals"):
            try:
                float(c.value)
            except (TypeError, ValueError):
                return False
            continue
        return False
    return len(conds) > 0


def _feasible_value_for_row_field(conds: list[RowIndicatorCondition]) -> tuple[Any | None, bool]:
    """
    Подобрать одно значение поля числа для строки таблицы, чтобы выполнились все rowIndicator в группе.

    Ветка «всё числовое»: перебор x по логарифмической сетке и проверка через row_indicator_numeric_value_satisfies
    (совпадает с логикой декларации, включая min+max как узкую цель у середины).

    Иначе — упрощённое слияние интервалов/равенств (менее точное; используется для смешанных ограничений).
    """
    if not conds:
        return None, False
    if not _row_indicators_all_numeric(conds):
        # Запасной путь: склеиваем классические числовые интервалы и equals без полной семантики min+max как в рантайме.
        intervals: list[tuple[float, float]] = []
        eq_val: Any = None
        for c in conds:
            if c.value_min is not None or c.value_max is not None:
                inter = _numeric_interval_from_row_indicator_legacy(c)
                if inter:
                    intervals.append(inter)
                continue
            op = str(c.op or "")
            if op == "equals" and c.value is not None:
                if eq_val is not None and eq_val != c.value:
                    return None, False
                eq_val = c.value
            else:
                inter = _numeric_interval_from_row_indicator_legacy(c)
                if inter:
                    intervals.append(inter)
                else:
                    return None, False
        merged: Optional[tuple[float, float]] = None
        for it in intervals:
            merged = it if merged is None else (max(merged[0], it[0]), min(merged[1], it[1]))
            if merged[0] > merged[1]:
                return None, False
        if eq_val is not None:
            if merged is not None:
                try:
                    fv = float(eq_val)  # type: ignore[arg-type]
                except (TypeError, ValueError):
                    return eq_val, True
                if not (merged[0] <= fv <= merged[1]):
                    return None, False
            return eq_val, True
        if merged is not None:
            lo, hi = merged
            if hi == float("inf"):
                return lo + 1.0, True
            if lo == float("-inf"):
                return hi - 1.0, True
            return (lo + hi) / 2.0, True
        return 1.0, True

    # Основной путь: ищем x > 0, проходящий все предикаты одновременно (в т.ч. несколько коридоров min–max).
    lo = 1e-12
    hi = 1e12
    steps = 2500
    for i in range(steps + 1):
        if steps == 0:
            x = lo
        else:
            x = lo * (hi / lo) ** (i / steps)
        if all(row_indicator_numeric_value_satisfies(x, c) for c in conds):
            return x, True
    return None, False


def _raw_minmax_corridors_intersect(conds: list[RowIndicatorCondition]) -> bool:
    """Сырые отрезки [min,max] по числовой оси пересекаются (без учёта «цели у середины»)."""
    segs: list[tuple[float, float]] = []
    for c in conds:
        if c.value_min is not None and c.value_max is not None:
            segs.append((float(c.value_min), float(c.value_max)))
    if not segs:
        return False
    merged = segs[0]
    for a, b in segs[1:]:
        merged = (max(merged[0], a), min(merged[1], b))
        if merged[0] > merged[1]:
            return False
    return True


def _feasible_value_for_path_conditions(conds: list[PathClassificationCondition]) -> tuple[Any | None, bool]:
    """
    Все условия на одном DSL-path из двух правил должны выполняться одним значением (конъюнкция).

    Этапы: собрать интервалы для неравенств, согласовать несколько equals, пересечь списки для «in»,
    затем проверить совместимость выбранного значения с пересечением интервалов.
    Отрицания (not*) здесь не поддерживаются — для таких комбинаций пересечение считается невозможным.
    """
    if not conds:
        return None, True
    path0 = str(conds[0].path).strip()
    intervals: list[tuple[float, float]] = []
    eq_vals: list[Any] = []
    in_lists: list[list[Any]] = []
    need_exists = False
    for c in conds:
        if str(c.path).strip() != path0:
            return None, False
        op = str(c.op)
        if op == "exists":
            need_exists = True
            continue
        if op in ("notExists", "notEquals", "notIn", "notRegex"):
            return None, False
        if op == "equals":
            eq_vals.append(c.value)
        elif op == "in" and isinstance(c.value, list):
            in_lists.append(list(c.value))
        else:
            inter = _numeric_interval_from_path(c)
            if inter is not None:
                intervals.append(inter)
            else:
                return None, False
    for a, b in zip(eq_vals, eq_vals[1:]):
        if a != b:
            return None, False
    eq_val = eq_vals[0] if eq_vals else None
    inter_set: Optional[set[Any]] = None
    for lst in in_lists:
        s = set(lst)
        inter_set = s if inter_set is None else inter_set & s
    if in_lists and (inter_set is None or len(inter_set) == 0):
        return None, False
    pick_in = next(iter(inter_set)) if inter_set else None

    merged: Optional[tuple[float, float]] = None
    for it in intervals:
        merged = it if merged is None else (max(merged[0], it[0]), min(merged[1], it[1]))
        if merged[0] > merged[1]:
            return None, False

    if eq_val is not None:
        if pick_in is not None and pick_in != eq_val:
            return None, False
        if merged is not None:
            try:
                fv = float(eq_val)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return None, False
            if not (merged[0] <= fv <= merged[1]):
                return None, False
        return eq_val, True

    if pick_in is not None:
        if merged is not None:
            try:
                fv = float(pick_in)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return pick_in, True
            if not (merged[0] <= fv <= merged[1]):
                return None, False
        return pick_in, True

    if merged is not None:
        lo, hi = merged
        if lo == float("-inf") and hi == float("inf"):
            return 1.0, True
        if hi == float("inf"):
            return lo + 1.0, True
        if lo == float("-inf"):
            return hi - 1.0, True
        return (lo + hi) / 2.0, True

    if need_exists:
        return "—", True
    return None, False


def _materialize_path_value(root: Dict[str, Any], path: str, value: Any) -> None:
    """Записать значение в dict по шагам пути DSL (в т.ч. [*] → первый элемент списка)."""
    steps = parse_path(path)
    cur: Any = root
    for i, step in enumerate(steps):
        is_last = i == len(steps) - 1
        if step.kind == "prop":
            key = step.name
            assert key is not None
            if not isinstance(cur, dict):
                return
            if is_last:
                cur[key] = value
                return
            if key not in cur:
                nxt = steps[i + 1]
                cur[key] = [] if nxt.kind == "wildcard" else {}
            cur = cur[key]
        else:
            if not isinstance(cur, list):
                return
            if len(cur) == 0:
                cur.append({})
            cur = cur[0]


@dataclass
class RuleOverlapDetail:
    """Результат анализа пары правил для classification-conflicts (одна запись в списке конфликтов)."""
    overlaps: bool
    reason_ru: str
    corridor_risk_ru: Optional[str] = None
    overlap_context_note_ru: Optional[str] = None
    simplified_analysis_note_ru: Optional[str] = None
    priority_resolution_ru: Optional[str] = None
    range_intersections_ru: list[str] = field(default_factory=list)
    adjustment_recommendations_ru: list[str] = field(default_factory=list)
    overlap_axis_summary_ru: Optional[str] = None


def _pairwise_priority_resolution_ru(
    rule_a: ClassificationRule,
    rule_b: ClassificationRule,
    title_a: str,
    title_b: str,
) -> str:
    """
    Текст для UI: если бы оба правила выполнились на одних данных, кто бы «выиграл» при разрешении как у first_match.

    Ветки: разный priority → меньший wins; равный priority → сравнение эвристики строгости порогов;
    равенство и там → остаётся порядок в конфиге (как при переборе в first_match после фильтра совпадений).
    """
    pa, pb = int(rule_a.priority), int(rule_b.priority)
    if pa < pb:
        return (
            f"При одновременном выполнении условий выше приоритет у правила «{title_a}» "
            f"(в настройках правила меньше число приоритета: {pa} и {pb})."
        )
    if pb < pa:
        return (
            f"При одновременном выполнении условий выше приоритет у правила «{title_b}» "
            f"(в настройках правила меньше число приоритета: {pb} и {pa})."
        )
    sa, sb = _rule_first_match_tiebreak_score(rule_a), _rule_first_match_tiebreak_score(rule_b)
    if sa > sb:
        return (
            f"При одинаковом приоритете ({pa}) для правила «{title_a}» заданы более строгие числовые пороги "
            f"в смысле сравнения условий — оно бы выбрано при автоматической классификации."
        )
    if sb > sa:
        return (
            f"При одинаковом приоритете ({pa}) для правила «{title_b}» заданы более строгие числовые пороги "
            f"в смысле сравнения условий — оно бы выбрано при автоматической классификации."
        )
    return (
        f"При одинаковом приоритете ({pa}) и сходной строгости порогов из подошедших правил выбирается то, "
        f"которое раньше в списке правил справочника (режим «первое подходящее»)."
    )


def _group_priority_resolution_ru(rules: Sequence[ClassificationRule], titles: Sequence[str]) -> str:
    """Пояснение для API: кто выиграл бы при first_match, если бы все перечисленные правила совпали."""
    if len(rules) == 2:
        return _pairwise_priority_resolution_ru(rules[0], rules[1], titles[0], titles[1])
    ordered = list(rules)
    winner = select_rule_for_first_match(ordered, ordered)
    wi = ordered.index(winner)
    wtitle = titles[wi]
    wp = int(winner.priority)
    other_labels = [f"«{titles[k]}»" for k in range(len(titles)) if k != wi]
    others_txt = ", ".join(other_labels) if other_labels else "—"
    return (
        f"При одновременном выполнении условий всех перечисленных правил автоматический выбор класса "
        f"(режим «первое подходящее») отдал бы преимущество правилу «{wtitle}» (приоритет {wp}; при равенстве приоритетов "
        f"учитываются более строгие числовые пороги и порядок правил в справочнике). Остальные в этой группе: {others_txt}."
    )


def _analyze_rules_overlap_core(
    rules: Sequence[ClassificationRule],
    titles: Sequence[str],
) -> RuleOverlapDetail:
    """Объединённый анализ для пары или большей группы правил (только primary + связка «и»)."""
    if len(rules) < 2 or len(titles) != len(rules):
        raise ValueError("rules и titles: минимум два элемента и одинаковая длина.")
    per_conds = [_primary_and_conjunction_conds(r) for r in rules]
    priority_resolution = _group_priority_resolution_ru(rules, titles)

    simplified_notes: list[str] = []
    if any(rule_uses_or_or_groups(r) for r in rules):
        simplified_notes.append(
            "В одном или нескольких правилах есть связка «или» или сгруппированные условия: здесь учтены только основные "
            "условия, объединённые «и»; полное совпадение с проверкой по реальной декларации не гарантируется."
        )
    simplified_analysis_note_ru = " ".join(simplified_notes) if simplified_notes else None

    or_simp = bool(simplified_analysis_note_ru)
    axis_summary: Optional[str] = None
    if any(not pc for pc in per_conds):
        return RuleOverlapDetail(
            overlaps=False,
            reason_ru="Недостаточно обязательных условий для анализа пересечений.",
            simplified_analysis_note_ru=simplified_analysis_note_ru,
            priority_resolution_ru=priority_resolution,
            overlap_axis_summary_ru=None,
            adjustment_recommendations_ru=_adjustment_recommendations_ru(
                rules,
                overlaps=False,
                corridor_risk=False,
                range_lines=[],
                adv_infeasible=False,
                has_or_groups_simplification=or_simp,
                path_or_row_infeasible=False,
                empty_primary_conds=True,
            ),
        )

    n = len(rules)
    all_conds = [c for pc in per_conds for c in pc]
    paths = [c for c in all_conds if isinstance(c, PathClassificationCondition)]
    rows = [c for c in all_conds if isinstance(c, RowIndicatorCondition)]
    advanced = [c for c in all_conds if isinstance(c, (RowPairRatioCondition, RowFormulaCondition))]
    range_lines = _range_intersection_descriptions(per_conds, titles) if (paths or rows) else []
    axis_summary = _overlap_axis_headline_ru(range_lines)

    adv_ok, adv_err = _advanced_overlap_feasible(advanced)
    if not adv_ok:
        return RuleOverlapDetail(
            overlaps=False,
            reason_ru=adv_err
            or (
                f"Условия «{_UI_CONDITION_RATIO}» и «{_UI_CONDITION_FORMULA}» несовместимы: при одной и той же декларации "
                f"их нельзя выполнить одновременно."
            ),
            simplified_analysis_note_ru=simplified_analysis_note_ru,
            priority_resolution_ru=priority_resolution,
            range_intersections_ru=range_lines,
            overlap_axis_summary_ru=axis_summary,
            adjustment_recommendations_ru=_adjustment_recommendations_ru(
                rules,
                overlaps=False,
                corridor_risk=False,
                range_lines=range_lines,
                adv_infeasible=True,
                has_or_groups_simplification=or_simp,
                path_or_row_infeasible=False,
            ),
        )

    if not paths and not rows:
        if advanced:
            names_set: set[str] = set()
            for pc in per_conds:
                names_set |= _required_component_names_from_advanced(pc)
            names_union = sorted(names_set)
            names_txt = ", ".join(names_union) if names_union else "—"
            ctx_parts: list[str] = []
            if any(len(pc) > 1 for pc in per_conds):
                ctx_parts.append(
                    "У правил несколько условий; при отсутствии строк таблицы и числового сравнения на полях проверена "
                    "только совместимость отношений двух показателей и формул — убедитесь, что остальные ограничения не разводят классы."
                )
            both_or_all = "оба правила" if n == 2 else "все перечисленные правила"
            return RuleOverlapDetail(
                overlaps=True,
                reason_ru=(
                    f"В правилах заданы только «{_UI_CONDITION_RATIO}» и/или «{_UI_CONDITION_FORMULA}»; "
                    f"ограничений по {_UI_CONDITION_SCALAR} и по {_UI_CONDITION_TABLE_NUMBER} нет. "
                    f"Проверена совместимость пропорций на одной паре показателей и совпадающих формул при сравнении «равно». "
                    f"Чтобы {both_or_all} могли выполниться на одних данных, в таблице должны быть строки с показателями: {names_txt}."
                ),
                overlap_context_note_ru=" ".join(ctx_parts) if ctx_parts else None,
                simplified_analysis_note_ru=simplified_analysis_note_ru,
                priority_resolution_ru=priority_resolution,
                range_intersections_ru=[],
                adjustment_recommendations_ru=_adjustment_recommendations_ru(
                    rules,
                    overlaps=True,
                    corridor_risk=False,
                    range_lines=[],
                    adv_infeasible=False,
                    has_or_groups_simplification=or_simp,
                    path_or_row_infeasible=False,
                ),
                overlap_axis_summary_ru=axis_summary,
            )
        return RuleOverlapDetail(
            overlaps=False,
            reason_ru=(
                f"Нет условий «{_UI_CONDITION_SCALAR}» или {_UI_CONDITION_TABLE_NUMBER}, "
                f"по которым можно было бы проверить пересечение (кроме «{_UI_CONDITION_RATIO}» / «{_UI_CONDITION_FORMULA}»)."
            ),
            simplified_analysis_note_ru=simplified_analysis_note_ru,
            priority_resolution_ru=priority_resolution,
            range_intersections_ru=[],
            overlap_axis_summary_ru=axis_summary,
            adjustment_recommendations_ru=_adjustment_recommendations_ru(
                rules,
                overlaps=False,
                corridor_risk=False,
                range_lines=[],
                adv_infeasible=False,
                has_or_groups_simplification=or_simp,
                path_or_row_infeasible=False,
            ),
        )

    by_path: dict[str, list[PathClassificationCondition]] = {}
    for c in paths:
        by_path.setdefault(str(c.path).strip(), []).append(c)

    path_fail = (
        "По полю «{path}» объединённые требования правил несовместимы: нет значения, "
        "при котором выполнялись бы условия всех правил сразу."
        if n > 2
        else (
            "По полю «{path}» объединённые требования двух правил несовместимы: нет значения, "
            "при котором выполнялись бы условия обоих правил сразу."
        )
    )
    for path, lst in by_path.items():
        _val, ok = _feasible_value_for_path_conditions(lst)
        if not ok:
            return RuleOverlapDetail(
                overlaps=False,
                reason_ru=path_fail.format(path=path),
                simplified_analysis_note_ru=simplified_analysis_note_ru,
                priority_resolution_ru=priority_resolution,
                range_intersections_ru=range_lines,
                adjustment_recommendations_ru=_adjustment_recommendations_ru(
                    rules,
                    overlaps=False,
                    corridor_risk=False,
                    range_lines=range_lines,
                    adv_infeasible=False,
                    has_or_groups_simplification=or_simp,
                    path_or_row_infeasible=True,
                ),
                overlap_axis_summary_ru=axis_summary,
            )

    by_row: dict[tuple[str, str, str], list[RowIndicatorCondition]] = {}
    for c in rows:
        by_row.setdefault(row_indicator_group_key(c), []).append(c)

    corridor_both = (
        "одного числа, подходящего обоим правилам, нет. Возможна ошибка в формулировке условий."
        if n == 2
        else "одного числа, подходящего всем правилам сразу, нет. Возможна ошибка в формулировке условий."
    )
    row_fail = (
        "Для показателя «{ne}» (число в «{vf}») объединённые требования двух правил несовместимы "
        "в смысле той же проверки, что и при валидации декларации."
        if n == 2
        else "Для показателя «{ne}» (число в «{vf}») объединённые требования правил несовместимы "
        "в смысле той же проверки, что и при валидации декларации."
    )

    for key, lst in by_row.items():
        _ap, _nf, ne = key
        by_vf: dict[str, list[RowIndicatorCondition]] = {}
        for c in lst:
            by_vf.setdefault(str(c.value_field).strip(), []).append(c)
        for vf, vcs in by_vf.items():
            _v, ok = _feasible_value_for_row_field(vcs)
            mm = [c for c in vcs if c.value_min is not None and c.value_max is not None]
            local_corridor_risk: Optional[str] = None
            if (
                not ok
                and len(mm) >= 2
                and _raw_minmax_corridors_intersect(mm)
            ):
                local_corridor_risk = (
                    f"Для показателя «{ne}» (поле «{vf}») заданные диапазоны «от … до …» на числовой прямой накладываются друг на друга, "
                    f"но при реальной проверке декларации каждое правило требует попадания в узкую цель у середины диапазона — "
                    f"{corridor_both}"
                )
            if not ok:
                return RuleOverlapDetail(
                    overlaps=False,
                    reason_ru=row_fail.format(ne=ne, vf=vf),
                    corridor_risk_ru=local_corridor_risk,
                    simplified_analysis_note_ru=simplified_analysis_note_ru,
                    priority_resolution_ru=priority_resolution,
                    range_intersections_ru=range_lines,
                    adjustment_recommendations_ru=_adjustment_recommendations_ru(
                        rules,
                        overlaps=False,
                        corridor_risk=bool(local_corridor_risk),
                        range_lines=range_lines,
                        adv_infeasible=False,
                        has_or_groups_simplification=or_simp,
                        path_or_row_infeasible=not bool(local_corridor_risk),
                    ),
                    overlap_axis_summary_ru=axis_summary,
                )

    if n == 2:
        note = (
            "Ограничения по скалярным полям и строкам таблицы совместны: возможна декларация, которую отнесли бы "
            "и к одному, и к другому классу (по этим условиям)."
        )
    else:
        note = (
            "Ограничения по скалярным полям и строкам таблицы совместны: возможна декларация, которую отнесли бы "
            "к любому из перечисленных классов (по этим условиям)."
        )
    if advanced:
        note += (
            " Дополнительно: rowPairRatio/rowFormula проверены на явные числовые противоречия "
            "(одна пара компонентов / одна и та же формула equals); остальные комбинации формул и неравенств — вручную."
        )

    ctx_overlap: Optional[str] = None
    if any(len(pc) > 1 for pc in per_conds):
        ctx_overlap = (
            "У правил несколько условий с «и»: совместимость проверена по объединению всех таких ограничений; "
            "если бы справочник использовал «или» или группы, интерпретация может отличаться."
        )

    return RuleOverlapDetail(
        overlaps=True,
        reason_ru=note,
        overlap_context_note_ru=ctx_overlap,
        simplified_analysis_note_ru=simplified_analysis_note_ru,
        priority_resolution_ru=priority_resolution,
        range_intersections_ru=range_lines,
        adjustment_recommendations_ru=_adjustment_recommendations_ru(
            rules,
            overlaps=True,
            corridor_risk=False,
            range_lines=range_lines,
            adv_infeasible=False,
            has_or_groups_simplification=or_simp,
            path_or_row_infeasible=False,
        ),
        overlap_axis_summary_ru=axis_summary,
    )


def analyze_rules_overlap(
    rule_a: ClassificationRule,
    rule_b: ClassificationRule,
    *,
    left_title: str,
    right_title: str,
) -> RuleOverlapDetail:
    """
    Полный разбор пары правил.

    Порядок проверок:
    1) есть ли вообще условия для анализа;
    2) совместимы ли только advanced-условия (ratio/formula);
    3) если нет path и row — либо только advanced (пересечение по пропорциям), либо нечего проверять;
    4) по каждому path — общее значение поля;
    5) по каждой группе строки таблицы и полю числа — общее значение ячейки; при неудаче и двух min–max
       проверяем «сырой» пересечок отрезков → при пересечении на оси, но неудаче рантайм-предиката, заполняем corridor_risk_ru;
    6) успех: overlaps=True и пояснения про множественные условия / advanced.
    """
    return _analyze_rules_overlap_core([rule_a, rule_b], [left_title, right_title])


def analyze_rules_overlap_group(
    rules: Sequence[ClassificationRule],
    titles: Sequence[str],
) -> RuleOverlapDetail:
    """Тот же анализ, что и для пары, но для трёх и более правил (общие ограничения склеиваются)."""
    return _analyze_rules_overlap_core(rules, titles)


def overlap_connected_components(overlap_edges: Iterable[tuple[int, int]], n_rules: int) -> list[list[int]]:
    """
    Связные компоненты по рёбрам «пересечение возможно» (индексы правил 0..n_rules-1).
    В компоненту попадают только вершины, инцидентные хотя бы одному ребру.
    """
    adj: list[list[int]] = [[] for _ in range(n_rules)]
    for a, b in overlap_edges:
        if 0 <= a < n_rules and 0 <= b < n_rules and a != b:
            adj[a].append(b)
            adj[b].append(a)
    seen = [False] * n_rules
    out: list[list[int]] = []
    for s in range(n_rules):
        if seen[s] or not adj[s]:
            continue
        stack = [s]
        seen[s] = True
        comp: list[int] = []
        while stack:
            u = stack.pop()
            comp.append(u)
            for v in adj[u]:
                if not seen[v]:
                    seen[v] = True
                    stack.append(v)
        out.append(sorted(comp))
    return out


def rules_potentially_overlap(rule_a: Any, rule_b: Any) -> tuple[bool, str]:
    """Обратная совместимость: только флаг и короткая причина."""
    la = (getattr(rule_a, "title", None) or getattr(rule_a, "class_id", "") or "A").strip() or "A"
    lb = (getattr(rule_b, "title", None) or getattr(rule_b, "class_id", "") or "B").strip() or "B"
    d = analyze_rules_overlap(rule_a, rule_b, left_title=la, right_title=lb)
    return d.overlaps, d.reason_ru


def _primary_and_conditions(rule: ClassificationRule) -> list[ClassificationCondition]:
    return _primary_and_conjunction_conds(rule)


def _normalize_example_scalar(v: Any) -> Any:
    """Для примера в API: только целые или один знак после запятой (если округление сохраняет матч правил)."""
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if not math.isfinite(v):
            return v
        r = round(v, 1)
        if abs(r - int(r)) < 1e-12:
            return int(r)
        return float(r)
    return v


def _deep_normalize_example_numbers(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _deep_normalize_example_numbers(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_deep_normalize_example_numbers(x) for x in obj]
    return _normalize_example_scalar(obj)


def build_ambiguous_example_for_rule_group(
    rules: Sequence[ClassificationRule],
) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    """
    Собрать синтетический JSON для двух и более правил: склеиваем primary+«и» как в analyze_rules_overlap_group,
    затем проверяем _rule_matches для каждого правила.
    """
    rule_list = list(rules)
    if len(rule_list) < 2:
        return None, "Для примера нужно не менее двух правил."
    all_conds: list[ClassificationCondition] = []
    for r in rule_list:
        all_conds.extend(_primary_and_conditions(r))
    notes: list[str] = []
    if any(isinstance(c, (RowPairRatioCondition, RowFormulaCondition)) for c in all_conds):
        notes.append(
            f"В одном или нескольких правилах заданы «{_UI_CONDITION_RATIO}» и/или «{_UI_CONDITION_FORMULA}» — подобранные "
            f"числа в примере могут не совпасть с пропорциями и выражением; при необходимости скорректируйте значения вручную."
        )

    path_groups: dict[str, list[PathClassificationCondition]] = {}
    row_groups: dict[tuple[str, str, str], list[RowIndicatorCondition]] = {}
    for c in all_conds:
        if isinstance(c, PathClassificationCondition):
            path_groups.setdefault(str(c.path).strip(), []).append(c)
        elif isinstance(c, RowIndicatorCondition):
            row_groups.setdefault(row_indicator_group_key(c), []).append(c)

    data: Dict[str, Any] = {}
    for path, pconds in path_groups.items():
        val, ok = _feasible_value_for_path_conditions(pconds)
        if not ok:
            return None, "Не удалось автоматически подобрать значение для пути «%s»." % path
        if val is not None:
            _materialize_path_value(data, path, val)

    rows_by_array: dict[str, list[Dict[str, Any]]] = {}
    for (_ap, _nf, _ne), rconds in row_groups.items():
        ap = rconds[0].array_path
        nf = rconds[0].name_field
        ne = rconds[0].name_equals
        by_vf: dict[str, list[RowIndicatorCondition]] = {}
        for c in rconds:
            by_vf.setdefault(c.value_field, []).append(c)
        row: Dict[str, Any] = {nf: ne}
        for vf, vcs in by_vf.items():
            v, ok = _feasible_value_for_row_field(vcs)
            if not ok:
                return None, f"Не удалось подобрать значение для «{ne}» ({vf})."
            row[vf] = v
        rows_by_array.setdefault(ap, []).append(row)

    for ap, rows in rows_by_array.items():
        existing = data.get(ap)
        if isinstance(existing, list):
            data[ap] = existing + rows
        elif ap in data:
            data[ap] = list(rows)
        else:
            data[ap] = list(rows)

    oks = [_rule_matches(data, r) for r in rule_list]
    if all(oks):
        rounded = _deep_normalize_example_numbers(copy.deepcopy(data))
        if all(_rule_matches(rounded, r) for r in rule_list):
            data = rounded
        else:
            notes.append(
                "Числа в примере оставлены с дополнительными знаками после запятой: при округлении до целого "
                "или одного знака после запятой пример перестал бы одновременно удовлетворять всем правилам в группе."
            )
    if not all(oks):
        notes.append(
            f"Автоматически собранный пример не удовлетворяет одному или нескольким правилам целиком "
            f"(часто из‑за «{_UI_CONDITION_RATIO}», «{_UI_CONDITION_FORMULA}» или групп условий в правиле). "
            f"Используйте фрагмент как отправную точку и донастройте данные вручную."
        )
    note = " ".join(notes) if notes else None
    return data, note


def build_ambiguous_example_for_rules(
    rule_a: ClassificationRule,
    rule_b: ClassificationRule,
) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Обратная совместимость: пример для пары правил."""
    return build_ambiguous_example_for_rule_group([rule_a, rule_b])
