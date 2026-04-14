"""Юнит-тесты для пайплайна валидации: кеш компиляции и validate_with_rule."""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from app.db.models import RuleVersion
from app.pipeline.validator import (
    CompiledRuleCache,
    CompiledRuleCacheKey,
    validate_with_rule,
)


def _minimal_dsl_json() -> dict:
    return {
        "model_id": "unit_pipe",
        "schema": {
            "type": "object",
            "additional_properties": False,
            "required": ["name"],
            "properties": [
                {"name": "name", "schema": {"type": "string"}},
            ],
        },
        "cross_rules": [],
    }


def _make_rule_version(*, rule_id: uuid.UUID, dsl_json: dict | None = None) -> RuleVersion:
    rv = RuleVersion()
    rv.id = uuid.uuid4()
    rv.rule_id = rule_id
    rv.version = 1
    rv.is_active = True
    rv.model_id = "unit_pipe"
    rv.dsl_json = dsl_json if dsl_json is not None else _minimal_dsl_json()
    return rv


def test_compiled_rule_cache_key_equality():
    rid = uuid.uuid4()
    vid = uuid.uuid4()
    a = CompiledRuleCacheKey(rule_id=rid, rule_version_id=vid, version=3)
    b = CompiledRuleCacheKey(rule_id=rid, rule_version_id=vid, version=3)
    assert a == b
    assert hash(a) == hash(b)


def test_compiled_rule_cache_reuses_compiled_instance():
    cache = CompiledRuleCache()
    rule_id = uuid.uuid4()
    rv = _make_rule_version(rule_id=rule_id)
    first = cache.get_or_compile(rv)
    second = cache.get_or_compile(rv)
    assert first is second


def test_compiled_rule_cache_different_version_recompiles():
    cache = CompiledRuleCache()
    rule_id = uuid.uuid4()
    rv1 = _make_rule_version(rule_id=rule_id)
    rv2 = _make_rule_version(rule_id=rule_id)
    rv2.version = 2
    rv2.id = uuid.uuid4()

    c1 = cache.get_or_compile(rv1)
    c2 = cache.get_or_compile(rv2)
    assert c1 is not c2


def test_validate_with_rule_no_active_version():
    db = MagicMock()
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = None
    rule_id = uuid.uuid4()
    cache = CompiledRuleCache()

    ok, errors, validated, assigned = validate_with_rule(rule_id, {"name": "x"}, db, cache=cache)

    assert ok is False
    assert errors == [{"message": "Active rule version not found"}]
    assert validated is None
    assert assigned is None


def test_validate_with_rule_success():
    rule_id = uuid.uuid4()
    rv = _make_rule_version(rule_id=rule_id)
    db = MagicMock()
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = rv
    cache = CompiledRuleCache()

    ok, errors, validated, assigned = validate_with_rule(
        rule_id, {"name": "hello"}, db, cache=cache
    )

    assert ok is True
    assert errors == []
    assert validated == {"name": "hello"}
    assert assigned is None


def test_validate_with_rule_validation_error_from_compiler():
    rule_id = uuid.uuid4()
    rv = _make_rule_version(rule_id=rule_id)
    db = MagicMock()
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = rv
    cache = CompiledRuleCache()

    ok, errors, validated, assigned = validate_with_rule(rule_id, {}, db, cache=cache)

    assert ok is False
    assert errors
    assert isinstance(errors[0], str)
    assert validated is None
    assert assigned is None
