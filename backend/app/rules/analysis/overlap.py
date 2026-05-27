"""
Проверка логических пересечений между правилами определения класса в справочнике.

Модуль входит в движок правил системы классификации (валидации) таможенных деклараций.
Реализует сценарий интерфейса эксперта «проверка созданных правил на логические пересечения»:
эксперт до выкладки справочника выясняет,
может ли одна и та же декларация удовлетворить нескольким правилам определения класса из
раздела «Классы» и тем самым привести к неоднозначному назначению класса при правило-ориентированной
классификации. Вызов идёт через REST API движка правил; реальный JSON декларации с инспекторского
контура не подставляется — строится формальная оценка совместимости условий.

Связь с интерфейсом эксперта и движком правил
    application/services/classification_conflicts.py формирует ответ для экрана пересечений:
    пары и связные группы правил, пояснения на русском языке, рекомендации по правке справочника,
    при успехе — черновик признакового JSON (извлечённые числовые и текстовые характеристики),
    на котором все затронутые правила определения класса формально выполняются.

    Поля ответа (имена в API) и смысл для эксперта:
    • reason_ru — вывод: есть ли логическое пересечение, несовместимы ли числовые ограничения;
    • overlap_columns — сжатое перечисление числовых условий каждого правила;
    • range_intersections_ru, overlap_axis_summary_ru — наглядное наложение порогов и коридоров
      «от … до …» на одной числовой оси (вспомогательная иллюстрация, не заменяет полную проверку);
    • corridor_risk_ru — коридоры по «Минимум»/«Максимум» на оси
      пересекаются, но при проверке декларации каждое правило требует попадания в узкую цель
      у середины своего интервала — общего числа, подходящего всем правилам, может не существовать;
    • priority_resolution_ru — кто был бы выбран при режиме «первое подходящее»: наименьший
      «Приоритет» в разделе «Классы», при равенстве — более строгие числовые пороги и порядок
      правил в списке;
    • adjustment_recommendations_ru — что изменить в условиях или приоритетах, чтобы развести классы;
    • ambiguous_example, ambiguous_example_note_ru — синтетический пример признаков и оговорки к нему.

Критерий «одна декларация — несколько классов» (согласовано с classification.py)
    Пересечение подтверждается не только тем, что числовые отрезки на оси наложились. Проверяется
    совместимость тех же типов условий, что при валидации декларации по справочнику:

    • условие по полю структуры декларации (тип path в DSL) — в т. ч. «Полное описание декларации»,
      «Числовое сравнение», «Текст поля»;
    • условие «У поля с таким значением, диапазон числа» в таблице показателей (rowIndicator), в том
      числе случай пары чисел в ячейке как интервала измерения и коридора «Минимум»/«Максимум»;
    • «Отношение двух показателей (A : B = …)» (rowPairRatio) и «Формула по нескольким показателям»
      (rowFormula) — на явные числовые противоречия между правилами.

    Если для всех таких ограничений существуют совместные значения, overlaps=True: возможна декларация,
    по которой подошли бы несколько правил определения класса. Иначе логического пересечения по
    проверенному фрагменту нет (либо фиксируется corridor_risk_ru).

Ограничения автоматического анализа (расхождение с полной проверкой декларации)
    • Учитываются только строки подраздела «Условия» с включённым флажком «Основное условие»,
      объединённые логическим «и» внутри упрощённой модели. Группы условий с «или» между группами
      и неосновные строки отражаются в simplified_analysis_note_ru; полная семантика _rule_matches
      на реальной декларации может отличаться.
    • Для поля структуры и для ячейки показателя подбирается одно значение, удовлетворяющее
      конъюнкции всех сравниваемых правил.
    • Отрицательные текстовые проверки по полю (не равно, не соответствует регулярному выражению и т. п.)
      при объединении двух правил не моделируются.
    • Для коридоров «Минимум»/«Максимум» в таблице показателей применяется та же семантика, что
      при валидации декларации в движке классификации, а не только пересечение отрезков на оси.

Порядок вычислений (_analyze_rules_overlap_core)
    1. Отбор основных условий; предупреждение о группах и связке «или».
    2. Тексты о пересечении числовых коридоров для интерфейса эксперта.
    3. Совместимость отношений показателей и формул.
    4. Совместимость по каждому пути в структуре признаков.
    5. Совместимость по каждой строке таблицы показателей; отдельно — corridor_risk.
    6. Итог overlaps, пояснение по приоритету, рекомендации по правке справочника.

Публичные функции: analyze_rules_overlap, analyze_rules_overlap_group, overlap_connected_components,
build_ambiguous_example_for_rule_group, compact_numeric_constraints_for_rule.
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence

from ..classification.predicates import (
    _MAX_ROW_PAIR_RATIO_TOLERANCE_REL,
    _condition_group_id,
    _condition_is_primary,
    _rule_first_match_tiebreak_score,
    _rule_matches,
    row_indicator_numeric_value_satisfies,
    scalar_numeric_op_feasible_interval,
    select_rule_for_first_match,
)
from ..dsl_models import (
    ClassificationCondition,
    ClassificationRule,
    PathClassificationCondition,
    RowIndicatorCondition,
    RowPairRatioCondition,
    RowFormulaCondition,
)
from ..primitives.path_utils import parse_path

# Формулировки из подраздела «Условия» интерфейса эксперта (поле «Что проверяем») — для текстов API.
_UI_CONDITION_RATIO = "Отношение двух показателей (A : B = …)"
_UI_CONDITION_FORMULA = "Формула по нескольким показателям"
_UI_CONDITION_TABLE_NUMBER = "У поля с таким значением, диапазон числа"
_UI_CONDITION_SCALAR = "Числовое сравнение"


# ---------------------------------------------------------------------------
# Какие условия правила попадают в автоматический анализ
# ---------------------------------------------------------------------------


def _is_primary(cond: Any) -> bool:
    """Соответствует включённому флажку «Основное условие» в подразделе «Условия»."""
    return bool(getattr(cond, "primary", True))


def _primary_and_conjunction_conds(rule: ClassificationRule) -> list[ClassificationCondition]:
    """
    Подмножество условий одного правила определения класса для анализа пересечений.

    Берутся только основные условия, в упрощённой модели связанные логическим «и».
    Группы с «или» между группами (group_id, conjunction «or») в этот список не разворачиваются —
    см. rule_uses_or_or_groups и simplified_analysis_note_ru.
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
    Идентификатор одной логической строки таблицы показателей.

    Тройка: источник «… · массив из допустимых значений», поле-перечень наименований показателя,
    выбранное в «Значение поля» наименование (name_equals). Согласовано с сопоставлением при
    правило-ориентированной классификации декларации.
    """
    return (
        str(c.array_path).strip(),
        str(c.name_field).strip(),
        str(c.name_equals).strip(),
    )


def rule_uses_or_or_groups(rule: ClassificationRule) -> bool:
    """
    True, если в правиле определения класса есть группы условий или связка «или» между группами.

    Тогда автоматический анализ пересечений неповторяет полную проверку декларации — в ответе
    API заполняется simplified_analysis_note_ru.
    """
    for c in rule.conditions or []:
        if not _is_primary(c):
            continue
        if getattr(c, "conjunction", "and") == "or":
            return True
        if _condition_group_id(c):
            return True
    return False


def _numeric_interval_from_path(cond: PathClassificationCondition) -> Optional[tuple[float, float]]:
    """
    Множество допустимых скаляров на числовой оси для одного path-условия.

    Использует ту же геометрию допусков, что scalar_numeric_op_feasible_interval в classification.
    Возвращает (lo, hi) включительно; для equals — вырожденный отрезок [x, x].
    None — оператор не числовой или значение не приводится к float.
    """
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
    """
    Пересечение замкнутых отрезков на вещественной оси: [max(lo_i), min(hi_i)].

    Пустое пересечение (lo > hi) → None. Бесконечности допустимы как границы.
    """
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
    """
    Одно path-условие → (числовой отрезок, фраза для эксперта).

    Возвращает None, если условие не сводится к сравнению на оси (regex, in, exists, …).
    """
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
    """
    Одно rowIndicator → (отрезок на оси, фраза для эксперта).

    Коридор value_min/value_max даёт отрезок с расширением по tolerance_rel;
    сравнения gt (строго больше), gte (не меньше), lt (строго меньше), lte (не более), equals —
    через legacy-интервал (см. _numeric_interval_from_row_indicator_legacy).
    """
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
    """Плоский список (условие, подпись правила) для склейки текстов пересечения по оси."""
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
    Человекочитаемые строки: какие числовые требования накладывают правила и есть ли общий коридор.

    Не доказывает совместимость в рантайме для min–max (там другая семантика) — только наглядность
    «на оси отрезки пересекаются / нет». Для min–max добавляется напоминание про цель у середины.
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
    """
    Однострочное резюме числовых ограничений правила для таблицы пересечений в UI.

    Только primary + «и»; неполные или текстовые условия могут не попасть в строку.
    """
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
    """
    Практические подсказки эксперту: что поменять в DSL, исходя из исхода анализа.

    Список дедуплицируется с сохранением порядка. Не дублирует reason_ru — дополняет его действиями.
    """
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
    """Ключ группировки: одна таблица, одна пара имён компонентов (левая/правая часть отношения)."""
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
    """Ключ: таблица, поле числа, набор variables, текст формулы, оператор — для слияния equals."""
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
    """Имена показателей в строке таблицы, без которых ratio/formula не проверить на декларации."""
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


# ---------------------------------------------------------------------------
# Синтез одного значения: существует ли декларация, удовлетворяющая всем правилам сразу
# ---------------------------------------------------------------------------


def _feasible_value_for_row_field(conds: list[RowIndicatorCondition]) -> tuple[Any | None, bool]:
    """
    Подобрать число в ячейке показателя, при котором выполняются все условия «диапазон числа» группы.

    Та же семантика, что при валидации декларации: коридор «Минимум»/«Максимум», интервал измерения в ячейке
    как пара чисел, относительный допуск. Основной путь — перебор с проверкой row_indicator_numeric_value_satisfies;
    запасной — слияние отрезков на оси для смешанных ограничений.
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
    # Все conds относятся к одному path — иначе объединять бессмысленно.
    for c in conds:
        if str(c.path).strip() != path0:
            return None, False
        op = str(c.op)
        if op == "exists":
            need_exists = True
            continue
        # Отрицания при конъюнкции двух правил не моделируем: «общее значение» не строим.
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
    """
    Записать синтетическое значение в пример декларации по DSL-path.

    [*] создаёт или дополняет первый элемент массива; вложенные свойства — пустые dict/list по необходимости.
    Используется в build_ambiguous_example_for_rule_group, не в рантайме проверки реальной декларации.
    """
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
    """
    Результат проверки логического пересечения для пары или группы правил определения класса.

    overlaps — по упрощённой модели основных условий возможна одна декларация, подходящая
    под несколько правил из раздела «Классы» (риск неоднозначной классификации).
    reason_ru — основное пояснение для интерфейса эксперта.
    corridor_risk_ru — пересечение коридоров «Минимум»/«Максимум» на оси без общего числа
    при проверке декларации.
    simplified_analysis_note_ru — оговорка при группах условий и связке «или».
    priority_resolution_ru — исход при режиме «первое подходящее» и поле «Приоритет».
    range_intersections_ru, overlap_axis_summary_ru — иллюстрация числовых порогов.
    adjustment_recommendations_ru — рекомендации по правке справочника.
    """
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
    Пояснение для интерфейса эксперта при режиме «первое подходящее».

    Если оба правила определения класса подошли бы к одним признакам, указывается, какое имело бы
    преимущество: меньшее число в поле «Приоритет», при равенстве — более строгие числовые пороги,
    затем более ранняя позиция в списке правил раздела «Классы».
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


# ---------------------------------------------------------------------------
# Ядро анализа и публичный API
# ---------------------------------------------------------------------------


def _analyze_rules_overlap_core(
    rules: Sequence[ClassificationRule],
    titles: Sequence[str],
) -> RuleOverlapDetail:
    """
    Единая реализация для пары и для группы из N правил.

    Возвращает RuleOverlapDetail; не бросает исключений на «логических» отказах —
    только ValueError при некорректных входных списках.
    """
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
    # Пояснения для UI строим заранее — даже если позже overlaps=False.
    range_lines = _range_intersection_descriptions(per_conds, titles) if (paths or rows) else []
    axis_summary = _overlap_axis_headline_ru(range_lines)

    # Сначала явные противоречия в пропорциях/формулах (без path/row).
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

    # Склеиваем все path-условия всех правил с одним и тем же путём в DSL.
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

    # Строка таблицы = (array_path, name_field, name_equals); внутри — поля числа value_field.
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
            # Ложное «пересечение на оси»: отрезки [min,max] перекрываются, а цели у середины — нет.
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
    Проверка логического пересечения двух правил определения класса в одном справочнике.

    Используется на экране «проверка созданных правил на логические пересечения» интерфейса эксперта.
    Подписи left_title и right_title — наименования записей из раздела «Классы» для текстов ответа.
    """
    return _analyze_rules_overlap_core([rule_a, rule_b], [left_title, right_title])


def analyze_rules_overlap_group(
    rules: Sequence[ClassificationRule],
    titles: Sequence[str],
) -> RuleOverlapDetail:
    """Тот же сценарий пересечений для связной группы из трёх и более правил определения класса."""
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
    Сформировать черновик признакового JSON, на котором выполняются все правила группы.

    Структура соответствует машиночитаемому описанию характеристик справочника (результат
    извлечения признаков из описания товара). После сборки каждое правило определения класса
    проверяется тем же предикатом, что при валидации декларации (_rule_matches).
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
