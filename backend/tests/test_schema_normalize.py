"""Нормализация строк с enum до валидации и проход в compile_rule.validate."""

from app.rules.compiler import compile_rule
from app.rules.dsl_models import ObjectFieldSchema, RuleDSL
from app.rules.schema_normalize import lowercase_enum_constrained_strings


def _dsl_with_substance_enum() -> RuleDSL:
    return RuleDSL.model_validate(
        {
            "model_id": "test_enum",
            "schema": {
                "type": "object",
                "additional_properties": False,
                "required": ["показатели"],
                "properties": [
                    {
                        "name": "показатели",
                        "schema": {
                            "type": "array",
                            "min_items": 1,
                            "items": {
                                "type": "object",
                                "additional_properties": False,
                                "required": ["вещество", "показатели"],
                                "properties": [
                                    {
                                        "name": "вещество",
                                        "schema": {
                                            "type": "string",
                                            "constraints": {"enum": ["na", "p2o5", "k2o"]},
                                        },
                                    },
                                    {"name": "показатели", "schema": {"type": "number"}},
                                ],
                            },
                        },
                    },
                ],
            },
            "cross_rules": [],
        }
    )


def test_lowercase_enum_constrained_strings_nested():
    dsl = _dsl_with_substance_enum()
    root = dsl.schema_
    assert isinstance(root, ObjectFieldSchema)
    raw = {"показатели": [{"вещество": "NA", "показатели": 1.5}, {"вещество": "P2O5", "показатели": 2.0}]}
    out = lowercase_enum_constrained_strings(raw, root)
    assert out["показатели"][0]["вещество"] == "na"
    assert out["показатели"][1]["вещество"] == "p2o5"


def test_validate_accepts_two_element_number_interval():
    dsl = RuleDSL.model_validate(
        {
            "model_id": "test_interval",
            "schema": {
                "type": "object",
                "additional_properties": False,
                "required": ["массовая доля"],
                "properties": [
                    {
                        "name": "массовая доля",
                        "schema": {
                            "type": "array",
                            "min_items": 1,
                            "items": {
                                "type": "object",
                                "additional_properties": False,
                                "required": ["вещество", "массовая доля"],
                                "properties": [
                                    {"name": "вещество", "schema": {"type": "string"}},
                                    {"name": "массовая доля", "schema": {"type": "number"}},
                                ],
                            },
                        },
                    },
                ],
            },
            "cross_rules": [],
        }
    )
    compiled = compile_rule(dsl)
    ok, errors, validated, _ = compiled.validate(
        {
            "массовая доля": [
                {"вещество": "n", "массовая доля": [26, 27]},
                {"вещество": "s", "массовая доля": 13},
            ]
        }
    )
    assert ok is True
    assert errors == []
    assert validated is not None
    assert validated["массовая доля"][0]["массовая доля"] == [26, 27]


def test_validate_accepts_mixed_case_enum_values():
    compiled = compile_rule(_dsl_with_substance_enum())
    ok, errors, validated, _assigned = compiled.validate(
        {"показатели": [{"вещество": "P2O5", "показатели": 10.0}]}
    )
    assert ok is True
    assert errors == []
    assert validated is not None
    assert validated["показатели"][0]["вещество"] == "p2o5"


def test_validate_accepts_string_not_in_schema_enum():
    """Коды вне перечня в DSL (новые вещества) не блокируют проверку — enum в схеме не жёсткий."""
    compiled = compile_rule(_dsl_with_substance_enum())
    ok, errors, validated, _assigned = compiled.validate(
        {"показатели": [{"вещество": "SO4", "показатели": 1.0}, {"вещество": "cl", "показатели": 2.0}]}
    )
    assert ok is True
    assert errors == []
    assert validated is not None
    assert validated["показатели"][0]["вещество"] == "so4"
    assert validated["показатели"][1]["вещество"] == "cl"
