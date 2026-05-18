from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import uuid

from ..ports.repositories import RuleCatalogRepositoryPort


@dataclass
class ValidateRuleCommand:
    rule_id: uuid.UUID
    data: Any


class ValidateRuleUseCase:
    """Сценарий валидации данных по активной версии справочника."""

    def __init__(self, repo: RuleCatalogRepositoryPort, compiler: Any) -> None:
        self._repo = repo
        self._compiler = compiler

    def execute(self, cmd: ValidateRuleCommand) -> tuple[bool, list[Any], Any, str | None]:
        rv = self._repo.get_active_rule_version(cmd.rule_id)
        if rv is None:
            raise LookupError("Active rule version not found")
        compiled = self._compiler(rv.dsl_json)
        return compiled.validate(cmd.data)


@dataclass
class GetRuleWithActiveVersionCommand:
    rule_id: uuid.UUID


class GetRuleWithActiveVersionUseCase:
    """Сценарий получения карточки справочника с активной версией."""

    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, cmd: GetRuleWithActiveVersionCommand) -> tuple[Any, Any]:
        rule = self._repo.get_rule(cmd.rule_id)
        if rule is None:
            raise LookupError("Rule not found")
        rv = self._repo.get_active_rule_version(cmd.rule_id)
        if rv is None:
            raise LookupError("Active rule version not found")
        return rule, rv
