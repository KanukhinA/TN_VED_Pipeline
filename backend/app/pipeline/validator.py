"""
Семантическая валидация признаков декларации по активной версии справочника (Pydantic).

Загрузка dsl_json из PostgreSQL, компиляция в rules.compiler, кэш версий на время запроса.
Контур интерфейса инспектора после извлечения характеристик LLM: схема структуры и межполевые
правила до правило-ориентированной классификации.
"""

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
    """Ключ кеша compiled-правила: rule + конкретная активная версия."""

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
        """Возвращает compiled-правило из кеша или компилирует и кеширует."""
        key = CompiledRuleCacheKey(rule_id=rv.rule_id, rule_version_id=rv.id, version=rv.version)
        compiled = self._cache.get(key)
        if compiled is not None:
            return compiled

        dsl = RuleDSL.model_validate(rv.dsl_json)
        compiled = compile_rule(dsl)
        self._cache[key] = compiled
        return compiled


_DEFAULT_CACHE = CompiledRuleCache()


class RuleValidationService:
    """ООП-сервис валидации данных по активной версии правила."""

    def __init__(self, cache: Optional[CompiledRuleCache] = None) -> None:
        self._cache = cache or CompiledRuleCache()

    def validate_with_rule(
        self,
        rule_id: uuid.UUID,
        data: Any,
        db: Session,
    ) -> Tuple[bool, list[Any], Optional[dict[str, Any]], Optional[str]]:
        rv: RuleVersion | None = (
            db.query(RuleVersion)
            .filter(RuleVersion.rule_id == rule_id, RuleVersion.is_active.is_(True))
            .order_by(RuleVersion.version.desc())
            .first()
        )
        if rv is None:
            return (False, [{"message": "Active rule version not found"}], None, None)
        compiled = self._cache.get_or_compile(rv)
        # validate() внутри: pydantic → межполевые правила → назначение class_id.
        ok, errors, validated_data, assigned_class = compiled.validate(data)
        return (ok, errors, validated_data, assigned_class)


_DEFAULT_VALIDATION_SERVICE = RuleValidationService(_DEFAULT_CACHE)


def validate_with_rule(
    rule_id: uuid.UUID, data: Any, db: Session, *, cache: CompiledRuleCache = _DEFAULT_CACHE
) -> Tuple[bool, list[Any], Optional[dict[str, Any]], Optional[str]]:
    """Валидирует данные по активной версии правила с использованием кеша компиляции."""
    if cache is _DEFAULT_CACHE:
        return _DEFAULT_VALIDATION_SERVICE.validate_with_rule(rule_id, data, db)
    return RuleValidationService(cache).validate_with_rule(rule_id, data, db)

