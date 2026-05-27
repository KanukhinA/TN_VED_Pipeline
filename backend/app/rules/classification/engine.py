"""
Движок правило-ориентированной классификации и публичные точки входа.

evaluate_classification, find_first_matching_classification_rule,
semantic_candidate_matches_class_rule, select_rule_for_first_match.
"""

from __future__ import annotations

from typing import Any, List, Optional, Tuple

from ..dsl_models import ClassificationConfig, ClassificationRule
from .errors import ClassificationError
from .messages_ru import _semantic_rule_mismatch_details_ru
from .predicates import (
    _narrow_first_match_by_refinements_when_multi_class,
    _rule_matches,
    select_rule_for_first_match,
)

def _ordered_rules_list(rules: List[ClassificationRule]) -> List[ClassificationRule]:
    """Стабильно сортирует правила: сначала priority, затем исходный порядок."""
    indexed = sorted(enumerate(rules), key=lambda x: (x[1].priority, x[0]))
    return [r for _, r in indexed]


class ClassificationEngine:
    """ООП-движок классификации с фасадами обратной совместимости."""

    def find_first_matching(
        self,
        data: Any,
        config: Optional[ClassificationConfig],
    ) -> Optional[ClassificationRule]:
        if config is None or not config.rules:
            return None
        if config.strategy != "first_match":
            return None
        ordered = _ordered_rules_list(config.rules)
        matches = [r for r in ordered if _rule_matches(data, r)]
        if not matches:
            return None
        narrowed = _narrow_first_match_by_refinements_when_multi_class(data, matches)
        return select_rule_for_first_match(narrowed, ordered)

    def evaluate(
        self,
        data: Any,
        config: Optional[ClassificationConfig],
    ) -> Tuple[bool, Optional[str], List[ClassificationError]]:
        if config is None or not config.rules:
            return (True, None, [])

        ordered = _ordered_rules_list(config.rules)
        if config.strategy == "first_match":
            matches = [r for r in ordered if _rule_matches(data, r)]
            if matches:
                # При нескольких классах уточняющие условия могут отсеять часть кандидатов.
                narrowed = _narrow_first_match_by_refinements_when_multi_class(data, matches)
                winner = select_rule_for_first_match(narrowed, ordered)
                return (True, winner.class_id, [])
            return (
                False,
                None,
                [
                    ClassificationError(
                        message="classification: ни одно правило не подошло",
                        details={"strategy": config.strategy},
                    )
                ],
            )

        if config.strategy == "exactly_one":
            matched_indices = [i for i, r in enumerate(ordered) if _rule_matches(data, r)]
            if len(matched_indices) == 1:
                return (True, ordered[matched_indices[0]].class_id, [])
            if len(matched_indices) == 0:
                return (True, None, [])
            # Несколько совпадений: выбираем правило с наименьшим priority (при равенстве — раньше в списке).
            bi = min(matched_indices, key=lambda i: (ordered[i].priority, i))
            return (True, ordered[bi].class_id, [])

        return (False, None, [ClassificationError(message=f"Unknown classification strategy: {config.strategy}")])

    def semantic_check(
        self,
        data: Any,
        config: Optional[ClassificationConfig],
        candidate_class_id: str,
    ) -> tuple[bool, Optional[str]]:
        rule = find_classification_rule_for_class_id(config, candidate_class_id)
        if rule is None:
            return True, None
        if _rule_matches(data, rule):
            return True, None
        rule_name = (rule.title or "").strip() or (rule.class_id or "").strip() or candidate_class_id.strip()
        mismatch = _semantic_rule_mismatch_details_ru(data, rule)
        return (
            False,
            "Извлечённые значения не удовлетворяют условиям классификации справочника для класса, "
            f"выбранного по схожести с эталонами. Не выполнено правило: «{rule_name}»"
            f". А именно: {mismatch}.",
        )


_DEFAULT_CLASSIFICATION_ENGINE = ClassificationEngine()


def find_classification_rule_for_class_id(
    config: Optional[ClassificationConfig],
    class_id: str,
) -> Optional[ClassificationRule]:
    """Правило классификации с данным class_id: точное совпадение или вхождение в перечень через запятую в поле class_id правила (legacy JSON)."""
    if not config or not config.rules or not (class_id or "").strip():
        return None
    cid = class_id.strip()
    for rule in config.rules:
        rid = (rule.class_id or "").strip()
        if not rid:
            continue
        if rid == cid:
            return rule
        if "," in rid:
            parts = [x.strip() for x in rid.split(",") if x.strip()]
            if cid in parts:
                return rule
    return None


def find_first_matching_classification_rule(
    data: Any,
    config: Optional[ClassificationConfig],
) -> Optional[ClassificationRule]:
    """Для strategy first_match — выигравшее подошедшее правило (тот же выбор, что при назначении класса)."""
    return _DEFAULT_CLASSIFICATION_ENGINE.find_first_matching(data, config)


def evaluate_classification(
    data: Any,
    config: Optional[ClassificationConfig],
) -> Tuple[bool, Optional[str], List[ClassificationError]]:
    """
    Возвращает (ok, assigned_class_id, errors).
    Для strategy exactly_one при нескольких совпадениях выбирается одно правило
    по наименьшему priority, при равенстве — по порядку в списке правил;
    при нуле совпадений — None без ошибки.
    """
    return _DEFAULT_CLASSIFICATION_ENGINE.evaluate(data, config)


def semantic_candidate_matches_class_rule(
    data: Any,
    config: Optional[ClassificationConfig],
    candidate_class_id: str,
) -> tuple[bool, Optional[str]]:
    """
    Проверка ветки README RuleMatch2: извлечённые признаки не противоречат правилу для класса-кандидата.

    Возвращает (True, None) если правила для класса нет (нечего проверять) или условия выполняются;
    (False, message_ru) если правило есть и данные ему не соответствуют.
    """
    return _DEFAULT_CLASSIFICATION_ENGINE.semantic_check(data, config, candidate_class_id)
