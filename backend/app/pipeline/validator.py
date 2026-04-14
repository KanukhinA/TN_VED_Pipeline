from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

from sqlalchemy.orm import Session

from ..db.models import RuleVersion
from ..rules.compiler import compile_rule
from ..rules.dsl_models import RuleDSL


@dataclass(frozen=True)
class CompiledRuleCacheKey:
    rule_id: uuid.UUID
    rule_version_id: uuid.UUID
    version: int


class CompiledRuleCache:
    """
    Простой in-memory кеш для быстрого использования правил в пайплайне.
    """

    def __init__(self) -> None:
        self._cache: Dict[CompiledRuleCacheKey, Any] = {}

    def get_or_compile(self, rv: RuleVersion) -> Any:
        key = CompiledRuleCacheKey(rule_id=rv.rule_id, rule_version_id=rv.id, version=rv.version)
        compiled = self._cache.get(key)
        if compiled is not None:
            return compiled

        dsl = RuleDSL.model_validate(rv.dsl_json)
        compiled = compile_rule(dsl)
        self._cache[key] = compiled
        return compiled


_DEFAULT_CACHE = CompiledRuleCache()


def validate_with_rule(
    rule_id: uuid.UUID, data: Any, db: Session, *, cache: CompiledRuleCache = _DEFAULT_CACHE
) -> Tuple[bool, list[Any], Optional[dict[str, Any]], Optional[str]]:
    rv: RuleVersion | None = (
        db.query(RuleVersion)
        .filter(RuleVersion.rule_id == rule_id, RuleVersion.is_active.is_(True))
        .order_by(RuleVersion.version.desc())
        .first()
    )
    if rv is None:
        return (False, [{"message": "Active rule version not found"}], None, None)

    compiled = cache.get_or_compile(rv)
    ok, errors, validated_data, assigned_class = compiled.validate(data)
    return (ok, errors, validated_data, assigned_class)

