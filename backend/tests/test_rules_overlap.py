"""Тесты пересечения правил классификации (rule_overlap / routes_rules)."""

import math

from app.api.routes_rules import _rules_potentially_overlap, classification_conflict_items_for_rules
from app.rules.dsl_models import (
    ClassificationRule,
    PathClassificationCondition,
    RowFormulaCondition,
    RowIndicatorCondition,
    RowPairRatioCondition,
)
from app.rules.rule_overlap import (
    analyze_rules_overlap,
    analyze_rules_overlap_group,
    build_ambiguous_example_for_rule_group,
    build_ambiguous_example_for_rules,
    overlap_connected_components,
)


def _pair(
    left: str,
    right: str,
    rl: float,
    rr: float,
    tol: float = 0.001,
    array_path: str = "показатели",
) -> RowPairRatioCondition:
    return RowPairRatioCondition(
        type="rowPairRatio",
        array_path=array_path,
        name_field="наименование",
        value_field="значение",
        left_name=left,
        right_name=right,
        ratio_left=rl,
        ratio_right=rr,
        tolerance_rel=tol,
    )


def test_overlap_only_row_pair_ratio_incompatible_same_pair():
    """Два правила с одной парой компонентов и несовместимыми пропорциями — пересечения нет."""
    a = ClassificationRule(class_id="a", conditions=[_pair("n", "s", 2.0, 1.0, 0.01)])
    b = ClassificationRule(class_id="b", conditions=[_pair("n", "s", 1.0, 2.0, 0.01)])
    ok, reason = _rules_potentially_overlap(a, b)
    assert ok is False
    assert "Отношение двух показателей" in reason
    assert "несовместим" in reason.lower()


def test_overlap_only_row_pair_ratio_compatible_same_pair():
    """Близкие пропорции на одной паре — пересечение возможно."""
    a = ClassificationRule(class_id="a", conditions=[_pair("n", "s", 2.0, 1.0, 0.05)])
    b = ClassificationRule(class_id="b", conditions=[_pair("n", "s", 2.04, 1.0, 0.05)])
    ok, reason = _rules_potentially_overlap(a, b)
    assert ok is True
    assert "n" in reason and "s" in reason


def test_overlap_only_row_pair_ratio_different_pairs():
    """Разные пары компонентов — числового противоречения на одной паре нет."""
    a = ClassificationRule(class_id="a", conditions=[_pair("n", "s", 2.0, 1.0)])
    b = ClassificationRule(class_id="b", conditions=[_pair("калий", "фосфор", 1.0, 1.0)])
    ok, reason = _rules_potentially_overlap(a, b)
    assert ok is True
    assert "калий" in reason


def test_overlap_row_formula_incompatible_equals():
    a = ClassificationRule(
        class_id="a",
        conditions=[
            RowFormulaCondition(
                type="rowFormula",
                array_path="показатели",
                name_field="наименование",
                value_field="значение",
                variables={"x": "n", "y": "s"},
                formula="x + y",
                op="equals",
                value=10.0,
                tolerance_rel=0.001,
            )
        ],
    )
    b = ClassificationRule(
        class_id="b",
        conditions=[
            RowFormulaCondition(
                type="rowFormula",
                array_path="показатели",
                name_field="наименование",
                value_field="значение",
                variables={"x": "n", "y": "s"},
                formula="x + y",
                op="equals",
                value=100.0,
                tolerance_rel=0.001,
            )
        ],
    )
    ok, reason = _rules_potentially_overlap(a, b)
    assert ok is False
    assert "Формула по нескольким показателям" in reason


def test_corridor_minmax_visual_overlap_runtime_infeasible():
    """Два коридора min–max на оси пересекаются, но одна цель у середине — совместимости нет; флаг риска."""
    a = ClassificationRule(
        class_id="a",
        title="Правило A",
        conditions=[
            RowIndicatorCondition(
                type="rowIndicator",
                array_path="показатели",
                name_field="наименование",
                name_equals="калий",
                value_field="значение",
                value_min=10.0,
                value_max=20.0,
            )
        ],
    )
    b = ClassificationRule(
        class_id="b",
        title="Правило B",
        conditions=[
            RowIndicatorCondition(
                type="rowIndicator",
                array_path="показатели",
                name_field="наименование",
                name_equals="калий",
                value_field="значение",
                value_min=10.0,
                value_max=11.0,
            )
        ],
    )
    d = analyze_rules_overlap(a, b, left_title="A", right_title="B")
    assert d.overlaps is False
    assert d.corridor_risk_ru is not None
    assert "диапазон" in d.corridor_risk_ru.lower() or "середин" in d.corridor_risk_ru.lower()
    assert d.priority_resolution_ru is not None
    assert d.range_intersections_ru
    joined = " ".join(d.range_intersections_ru).lower()
    assert "калий" in joined
    assert "пересечение" in joined
    assert "10" in joined and "11" in joined
    assert d.adjustment_recommendations_ru


def test_range_intersection_path_field():
    a = ClassificationRule(
        class_id="a",
        conditions=[PathClassificationCondition(path="масса.brutto", op="gte", value=10.0)],
    )
    b = ClassificationRule(
        class_id="b",
        conditions=[PathClassificationCondition(path="масса.brutto", op="lte", value=50.0)],
    )
    d = analyze_rules_overlap(a, b, left_title="A", right_title="B")
    assert d.overlaps is True
    assert any("масса" in x for x in d.range_intersections_ru)
    assert any("10" in x and "50" in x for x in d.range_intersections_ru)


def test_overlap_row_formula_compatible_equals():
    a = ClassificationRule(
        class_id="a",
        conditions=[
            RowFormulaCondition(
                type="rowFormula",
                array_path="показатели",
                name_field="наименование",
                value_field="значение",
                variables={"x": "n"},
                formula="x",
                op="equals",
                value=10.0,
                tolerance_rel=0.05,
            )
        ],
    )
    b = ClassificationRule(
        class_id="b",
        conditions=[
            RowFormulaCondition(
                type="rowFormula",
                array_path="показатели",
                name_field="наименование",
                value_field="значение",
                variables={"x": "n"},
                formula="x",
                op="equals",
                value=10.2,
                tolerance_rel=0.05,
            )
        ],
    )
    ok, _reason = _rules_potentially_overlap(a, b)
    assert ok is True


def _assert_ambiguous_example_display_numbers(data: object) -> None:
    """Целые или не более одного знака после запятой (как в ответе API для примера)."""

    def walk(x: object) -> None:
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for it in x:
                walk(it)
        elif isinstance(x, float):
            assert math.isfinite(x)
            ok_int = abs(x - round(x)) < 1e-9
            ok_dec1 = abs(x * 10 - round(x * 10)) < 1e-9
            assert ok_int or ok_dec1, x

    walk(data)


def test_overlap_connected_components_chain():
    assert overlap_connected_components([(0, 1), (1, 2)], 3) == [[0, 1, 2]]
    assert overlap_connected_components([(0, 1), (2, 3)], 4) == [[0, 1], [2, 3]]


def test_classification_conflicts_merge_triple_when_one_example_fits_all():
    def _row(name_eq: str, vmin: float) -> RowIndicatorCondition:
        return RowIndicatorCondition(
            type="rowIndicator",
            array_path="indicators",
            name_field="name",
            name_equals=name_eq,
            value_field="value",
            value_min=vmin,
            value_max=None,
        )

    r1 = ClassificationRule(class_id="c1", conditions=[_row("n", 1.0)])
    r2 = ClassificationRule(class_id="c2", conditions=[_row("s", 1.0)])
    r3 = ClassificationRule(class_id="c3", conditions=[_row("p", 1.0)])
    items = classification_conflict_items_for_rules([r1, r2, r3])
    assert len(items) == 1
    assert items[0].rule_indices == [1, 2, 3]
    assert len(items[0].overlap_columns) == 3
    assert all(c.constraints_compact_ru and c.label_ru for c in items[0].overlap_columns)
    d = analyze_rules_overlap_group([r1, r2, r3], ["t1", "t2", "t3"])
    assert d.overlaps is True
    ex, _n = build_ambiguous_example_for_rule_group([r1, r2, r3])
    assert ex is not None


def test_ambiguous_example_numbers_are_integer_or_one_decimal():
    # Только value_min (без пары min+max): иначе подбор по лог-сетке может не попасть в узкую цель «середина коридора».
    a = ClassificationRule(
        class_id="a",
        conditions=[
            RowIndicatorCondition(
                type="rowIndicator",
                array_path="indicators",
                name_field="name",
                name_equals="n",
                value_field="value",
                value_min=10.0,
                value_max=None,
            )
        ],
    )
    b = ClassificationRule(
        class_id="b",
        conditions=[
            RowIndicatorCondition(
                type="rowIndicator",
                array_path="indicators",
                name_field="name",
                name_equals="s",
                value_field="value",
                value_min=5.0,
                value_max=None,
            )
        ],
    )
    ex, _note = build_ambiguous_example_for_rules(a, b)
    assert ex is not None
    _assert_ambiguous_example_display_numbers(ex)
