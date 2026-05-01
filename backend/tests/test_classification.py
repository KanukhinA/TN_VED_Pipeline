"""Тесты детерминированного классификатора Rule DSL."""

from app.rules.classification import evaluate_classification
from app.rules.dsl_models import (
    ClassificationConfig,
    ClassificationRule,
    PathClassificationCondition,
    RowIndicatorCondition,
    RowPairRatioCondition,
    RowFormulaCondition,
)


def _row(name: str, value: float) -> dict:
    return {"наименование": name, "значение": value}


def test_first_match_priority_and_order():
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(class_id="b", priority=10, conditions=[]),
            ClassificationRule(class_id="a", priority=0, conditions=[]),
        ],
    )
    ok, cls, err = evaluate_classification({"показатели": []}, cfg)
    assert ok and cls == "a" and not err


def test_row_indicator_primary_false_skipped_for_match():
    """Условие с primary=False не участвует в срабатывании правила."""
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="only_azot",
                priority=0,
                conditions=[
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="азот",
                        value_field="значение",
                        op="gte",
                        value=15.0,
                        primary=True,
                    ),
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="фосфор",
                        value_field="значение",
                        op="gte",
                        value=99.0,
                        primary=False,
                    ),
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    data = {"показатели": [_row("азот", 20.0)]}
    ok, cls, err = evaluate_classification(data, cfg)
    assert ok and cls == "only_azot" and not err


def test_first_match_row_indicator_name_and_threshold():
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="high_n",
                priority=0,
                conditions=[
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="азот",
                        value_field="значение",
                        op="gte",
                        value=15.0,
                    )
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    data = {"показатели": [_row("фосфор", 10.0), _row("азот", 20.0)]}
    ok, cls, err = evaluate_classification(data, cfg)
    assert ok and cls == "high_n" and not err

    ok2, cls2, err2 = evaluate_classification({"показатели": [_row("азот", 5.0)]}, cfg)
    assert ok2 and cls2 == "other" and not err2


def test_row_indicator_value_min_max_one_row():
    """При min и max цель — среднее; односторонне при одной границе."""
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="band",
                priority=0,
                conditions=[
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="азот",
                        value_field="значение",
                        value_min=10.0,
                        value_max=20.0,
                    )
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    ok, cls, err = evaluate_classification({"показатели": [_row("азот", 15.0)]}, cfg)
    assert ok and cls == "band" and not err

    ok_mid, cls_mid, _ = evaluate_classification({"показатели": [_row("азот", 14.0)]}, cfg)
    assert ok_mid and cls_mid == "other"

    ok_lo, cls_lo, _ = evaluate_classification({"показатели": [_row("азот", 9.0)]}, cfg)
    assert ok_lo and cls_lo == "other"

    ok_hi, cls_hi, _ = evaluate_classification({"показатели": [_row("азот", 21.0)]}, cfg)
    assert ok_hi and cls_hi == "other"

    # Две строки «азот»: 5 и 25; ни одна не в [10,20]
    ok_two, cls_two, _ = evaluate_classification(
        {"показатели": [_row("азот", 5.0), _row("азот", 25.0)]},
        cfg,
    )
    assert ok_two and cls_two == "other"


def test_row_indicator_accepts_open_ended_numeric_cell_ranges():
    """Диапазонные значения [x, None] и [None, y] должны считаться валидными скалярами."""
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="calcium_nitrate",
                priority=0,
                conditions=[
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="массовая доля",
                        name_field="вещество",
                        name_equals="n",
                        value_field="массовая доля",
                        value_min=14.0,
                    )
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    data = {
        "массовая доля": [
            {"вещество": "n", "массовая доля": [17, None]},
            {"вещество": "nh4+", "массовая доля": [None, 0.5]},
            {"вещество": "ca", "массовая доля": [32, None]},
        ]
    }
    ok, cls, err = evaluate_classification(data, cfg)
    assert ok and cls == "calcium_nitrate" and not err


def test_rule_conditions_support_or_conjunction():
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="n_or_mgo",
                priority=0,
                conditions=[
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="n",
                        value_field="значение",
                        value_min=8.0,
                    ),
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="mgo",
                        value_field="значение",
                        value_min=15.0,
                        value_max=16.0,
                        conjunction="or",
                    ),
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    ok_n, cls_n, err_n = evaluate_classification({"показатели": [_row("n", 8.5)]}, cfg)
    assert ok_n and cls_n == "n_or_mgo" and not err_n

    ok_mgo, cls_mgo, err_mgo = evaluate_classification({"показатели": [_row("mgo", 15.5)]}, cfg)
    assert ok_mgo and cls_mgo == "n_or_mgo" and not err_mgo

    ok_other, cls_other, err_other = evaluate_classification({"показатели": [_row("n", 7.0), _row("mgo", 14.0)]}, cfg)
    assert ok_other and cls_other == "other" and not err_other


def test_rule_conditions_support_and_inside_group_or_between_groups():
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="compound_rule",
                priority=0,
                condition_groups=["group_1", "group_2"],
                conditions=[
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="n",
                        value_field="значение",
                        value_min=8.0,
                        group_id="group_1",
                    ),
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="mgo",
                        value_field="значение",
                        value_min=15.0,
                        value_max=16.0,
                        group_id="group_1",
                    ),
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="p2o5",
                        value_field="значение",
                        value_min=20.0,
                        value_max=22.0,
                        group_id="group_2",
                    ),
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    ok_and, cls_and, err_and = evaluate_classification({"показатели": [_row("n", 8.5), _row("mgo", 15.5)]}, cfg)
    assert ok_and and cls_and == "compound_rule" and not err_and

    ok_or, cls_or, err_or = evaluate_classification({"показатели": [_row("p2o5", 21.0)]}, cfg)
    assert ok_or and cls_or == "compound_rule" and not err_or

    ok_other, cls_other, err_other = evaluate_classification({"показатели": [_row("n", 8.5), _row("mgo", 14.0)]}, cfg)
    assert ok_other and cls_other == "other" and not err_other


def test_exactly_one_multiple_comma_join_and_zero_no_error():
    row_azot_high = RowIndicatorCondition(
        type="rowIndicator",
        array_path="показатели",
        name_field="наименование",
        name_equals="азот",
        value_field="значение",
        op="gte",
        value=10.0,
    )
    row_azot_low = RowIndicatorCondition(
        type="rowIndicator",
        array_path="показатели",
        name_field="наименование",
        name_equals="азот",
        value_field="значение",
        op="lte",
        value=20.0,
    )
    cfg = ClassificationConfig(
        strategy="exactly_one",
        rules=[
            ClassificationRule(class_id="x", priority=0, conditions=[row_azot_high]),
            ClassificationRule(class_id="y", priority=1, conditions=[row_azot_low]),
        ],
    )
    # Два правила пересекаются: азот 15 удовлетворяет и ≥10, и ≤20 — список class_id через запятую
    ok, cls, err = evaluate_classification({"показатели": [_row("азот", 15.0)]}, cfg)
    assert ok and cls == "x,y" and not err

    # Нет строки «азот»; ни одно правило не выполняется — без ошибки, класс не назначен
    ok2, cls2, err2 = evaluate_classification({"показатели": [_row("калий", 1.0)]}, cfg)
    assert ok2 and cls2 is None and not err2

    cfg_with_default = ClassificationConfig(
        strategy="exactly_one",
        default_class_id="fallback",
        rules=[
            ClassificationRule(class_id="x", priority=0, conditions=[row_azot_high]),
            ClassificationRule(class_id="y", priority=1, conditions=[row_azot_low]),
        ],
    )
    ok3, cls3, err3 = evaluate_classification({"показатели": [_row("калий", 1.0)]}, cfg_with_default)
    assert ok3 and cls3 == "fallback" and not err3


def test_exactly_one_ambiguous_by_priority():
    row_azot_high = RowIndicatorCondition(
        type="rowIndicator",
        array_path="показатели",
        name_field="наименование",
        name_equals="азот",
        value_field="значение",
        op="gte",
        value=10.0,
    )
    row_azot_low = RowIndicatorCondition(
        type="rowIndicator",
        array_path="показатели",
        name_field="наименование",
        name_equals="азот",
        value_field="значение",
        op="lte",
        value=20.0,
    )
    cfg = ClassificationConfig(
        strategy="exactly_one",
        ambiguous_match_resolution="by_priority",
        rules=[
            ClassificationRule(class_id="late", priority=5, conditions=[row_azot_high]),
            ClassificationRule(class_id="early", priority=0, conditions=[row_azot_low]),
        ],
    )
    ok, cls, err = evaluate_classification({"показатели": [_row("азот", 15.0)]}, cfg)
    assert ok and cls == "early" and not err


def test_exactly_one_ambiguous_comma_join():
    row_azot_high = RowIndicatorCondition(
        type="rowIndicator",
        array_path="показатели",
        name_field="наименование",
        name_equals="азот",
        value_field="значение",
        op="gte",
        value=10.0,
    )
    row_azot_low = RowIndicatorCondition(
        type="rowIndicator",
        array_path="показатели",
        name_field="наименование",
        name_equals="азот",
        value_field="значение",
        op="lte",
        value=20.0,
    )
    cfg = ClassificationConfig(
        strategy="exactly_one",
        ambiguous_match_resolution="comma_join",
        rules=[
            ClassificationRule(class_id="x", priority=0, conditions=[row_azot_high]),
            ClassificationRule(class_id="y", priority=1, conditions=[row_azot_low]),
        ],
    )
    ok, cls, err = evaluate_classification({"показатели": [_row("азот", 15.0)]}, cfg)
    assert ok and cls == "x,y" and not err


def test_exactly_one_succeeds_when_single_match():
    cfg = ClassificationConfig(
        strategy="exactly_one",
        rules=[
            ClassificationRule(
                class_id="x",
                priority=0,
                conditions=[
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="азот",
                        value_field="значение",
                        op="gte",
                        value=10.0,
                    )
                ],
            ),
            ClassificationRule(
                class_id="y",
                priority=1,
                conditions=[
                    RowIndicatorCondition(
                        type="rowIndicator",
                        array_path="показатели",
                        name_field="наименование",
                        name_equals="азот",
                        value_field="значение",
                        op="lt",
                        value=10.0,
                    )
                ],
            ),
        ],
    )
    ok, cls, err = evaluate_classification({"показатели": [_row("азот", 5.0)]}, cfg)
    assert ok and cls == "y" and not err


def test_no_rules_skips_classifier():
    cfg = ClassificationConfig(strategy="first_match", rules=[])
    ok, cls, err = evaluate_classification({}, cfg)
    assert ok and cls is None and err == []


def test_legacy_validate_declared_strategy_migrates_to_first_match():
    """Старые правила с strategy=validate_declared при разборе DSL приводятся к first_match."""
    cfg = ClassificationConfig.model_validate(
        {
            "strategy": "validate_declared",
            "declared_class_path": "класс",
            "rules": [
                {
                    "class_id": "expected",
                    "priority": 0,
                    "conditions": [{"type": "path", "path": "флаг", "op": "equals", "value": True}],
                },
            ],
        }
    )
    assert cfg.strategy == "first_match"
    data = {"флаг": True, "класс": "expected"}
    ok, cls, err = evaluate_classification(data, cfg)
    assert ok and cls == "expected" and not err


def test_path_in_with_array_matches_any_element():
    cfg = ClassificationConfig.model_validate(
        {
            "strategy": "first_match",
            "rules": [
                {
                    "class_id": "sodium_nitrate",
                    "priority": 0,
                    "conditions": [
                        {
                            "type": "path",
                            "path": "массовая доля[*].вещество",
                            "op": "in",
                            "value": ["na"],
                        }
                    ],
                },
                {"class_id": "прочее", "priority": 10, "conditions": []},
            ],
        }
    )
    data = {
        "массовая доля": [
            {"вещество": "n", "массовая доля": 21},
            {"вещество": "na", "массовая доля": 16},
        ]
    }
    ok, cls, err = evaluate_classification(data, cfg)
    assert ok and cls == "sodium_nitrate" and not err


def test_path_equals_with_array_matches_any_element():
    cfg = ClassificationConfig.model_validate(
        {
            "strategy": "first_match",
            "rules": [
                {
                    "class_id": "target_equals",
                    "priority": 0,
                    "conditions": [
                        {
                            "type": "path",
                            "path": "массовая доля[*].вещество",
                            "op": "equals",
                            "value": "na",
                        }
                    ],
                },
                {"class_id": "прочее", "priority": 10, "conditions": []},
            ],
        }
    )
    data = {
        "массовая доля": [
            {"вещество": "n", "массовая доля": 21},
            {"вещество": "na", "массовая доля": 16},
        ]
    }
    ok, cls, err = evaluate_classification(data, cfg)
    assert ok and cls == "target_equals" and not err


def test_path_not_equals_with_array_requires_all_elements_not_equal():
    cfg = ClassificationConfig.model_validate(
        {
            "strategy": "first_match",
            "rules": [
                {
                    "class_id": "no_na",
                    "priority": 0,
                    "conditions": [
                        {
                            "type": "path",
                            "path": "массовая доля[*].вещество",
                            "op": "notEquals",
                            "value": "na",
                        }
                    ],
                },
                {"class_id": "прочее", "priority": 10, "conditions": []},
            ],
        }
    )
    has_na = {
        "массовая доля": [
            {"вещество": "n", "массовая доля": 21},
            {"вещество": "na", "массовая доля": 16},
        ]
    }
    ok1, cls1, err1 = evaluate_classification(has_na, cfg)
    assert ok1 and cls1 == "прочее" and not err1

    no_na = {
        "массовая доля": [
            {"вещество": "n", "массовая доля": 21},
            {"вещество": "k", "массовая доля": 16},
        ]
    }
    ok2, cls2, err2 = evaluate_classification(no_na, cfg)
    assert ok2 and cls2 == "no_na" and not err2


def test_row_pair_ratio_two_to_one():
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="ns_2_1",
                priority=0,
                conditions=[
                    RowPairRatioCondition(
                        type="rowPairRatio",
                        array_path="массовая доля",
                        name_field="вещество",
                        value_field="массовая доля",
                        left_name="n",
                        right_name="s",
                        ratio_left=2.0,
                        ratio_right=1.0,
                        tolerance_rel=0.001,
                    )
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    ok, cls, err = evaluate_classification(
        {
            "массовая доля": [
                {"вещество": "n", "массовая доля": 20.0},
                {"вещество": "s", "массовая доля": 10.0},
            ]
        },
        cfg,
    )
    assert ok and cls == "ns_2_1" and not err

    ok_bad, cls_bad, _ = evaluate_classification(
        {
            "массовая доля": [
                {"вещество": "n", "массовая доля": 10.0},
                {"вещество": "s", "массовая доля": 10.0},
            ]
        },
        cfg,
    )
    assert ok_bad and cls_bad == "other"


def test_row_pair_ratio_interval_list_uses_average_of_bounds():
    """[25,27] по N даёт среднее 26; при S=13 отношение 2:1 выполняется."""
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="ns_2_1",
                priority=0,
                conditions=[
                    RowPairRatioCondition(
                        type="rowPairRatio",
                        array_path="массовая доля",
                        name_field="вещество",
                        value_field="массовая доля",
                        left_name="n",
                        right_name="s",
                        ratio_left=2.0,
                        ratio_right=1.0,
                        tolerance_rel=0.001,
                    )
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    ok, cls, _ = evaluate_classification(
        {
            "массовая доля": [
                {"вещество": "n", "массовая доля": [25, 27]},
                {"вещество": "s", "массовая доля": 13},
            ]
        },
        cfg,
    )
    assert ok and cls == "ns_2_1"


def test_row_pair_ratio_equal_masses_rejects_even_with_loose_dsl_tolerance():
    """При n=s пропорция 2:1 не выполняется; большой tolerance_rel в DSL не должен пропускать (кламп 10%)."""
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="ns_2_1",
                priority=0,
                conditions=[
                    RowPairRatioCondition(
                        type="rowPairRatio",
                        array_path="массовая доля",
                        name_field="вещество",
                        value_field="массовая доля",
                        left_name="n",
                        right_name="s",
                        ratio_left=2.0,
                        ratio_right=1.0,
                        tolerance_rel=1.0,
                    )
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    ok, cls, _ = evaluate_classification(
        {
            "массовая доля": [
                {"вещество": "n", "массовая доля": 26},
                {"вещество": "s", "массовая доля": 26},
            ]
        },
        cfg,
    )
    assert ok and cls == "other"


def test_row_formula_three_vars_sum_ratio():
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="blend",
                priority=0,
                conditions=[
                    RowFormulaCondition(
                        type="rowFormula",
                        array_path="массовая доля",
                        name_field="вещество",
                        value_field="массовая доля",
                        variables={"n": "n", "s": "s", "k": "k"},
                        formula="(n + s) / k",
                        op="equals",
                        value=2.0,
                        tolerance_rel=0.01,
                    )
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    # (10+14)/12 = 2
    ok, cls, err = evaluate_classification(
        {
            "массовая доля": [
                {"вещество": "n", "массовая доля": 10.0},
                {"вещество": "s", "массовая доля": 14.0},
                {"вещество": "k", "массовая доля": 12.0},
            ]
        },
        cfg,
    )
    assert ok and cls == "blend" and not err

    ok2, cls2, _ = evaluate_classification(
        {
            "массовая доля": [
                {"вещество": "n", "массовая доля": 10.0},
                {"вещество": "s", "массовая доля": 10.0},
                {"вещество": "k", "массовая доля": 12.0},
            ]
        },
        cfg,
    )
    assert ok2 and cls2 == "other"


def test_path_regex_matches():
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="hit",
                priority=0,
                conditions=[
                    PathClassificationCondition(
                        path="код",
                        op="regex",
                        value=r"^[A-Z]+-\d+$",
                    )
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    ok, cls, _ = evaluate_classification({"код": "ABC-123"}, cfg)
    assert ok and cls == "hit"
    ok2, cls2, _ = evaluate_classification({"код": "abc-123"}, cfg)
    assert ok2 and cls2 == "other"


def test_path_not_regex_on_wildcard_array_all_elements_must_fail():
    """notRegex по пути с массивом: шаблон не должен совпадать ни с одним значением."""
    cfg = ClassificationConfig(
        strategy="first_match",
        rules=[
            ClassificationRule(
                class_id="ok_row",
                priority=0,
                conditions=[
                    PathClassificationCondition(
                        path="теги[*]",
                        op="notRegex",
                        value=r"^\d+$",
                    )
                ],
            ),
            ClassificationRule(class_id="other", priority=10, conditions=[]),
        ],
    )
    ok, cls, _ = evaluate_classification({"теги": ["a", "b"]}, cfg)
    assert ok and cls == "ok_row"
    ok2, cls2, _ = evaluate_classification({"теги": ["a", "42"]}, cfg)
    assert ok2 and cls2 == "other"
