"""
Правило-ориентированная классификация товаров по данным таможенной декларации.

Пакет classification: предикаты условий, русскоязычные тексты ошибок, движок evaluate_*.
Публичный API совместим с прежним модулем app.rules.classification.
"""

from .engine import (
    ClassificationEngine,
    evaluate_classification,
    find_classification_rule_for_class_id,
    find_first_matching_classification_rule,
    semantic_candidate_matches_class_rule,
)
from .errors import ClassificationError
from .predicates import (
    ConditionEvaluator,
    RuleMatcher,
    _MAX_ROW_PAIR_RATIO_TOLERANCE_REL,
    _condition_group_id,
    _condition_holds,
    _condition_is_primary,
    _rule_first_match_tiebreak_score,
    _rule_matches,
    row_indicator_numeric_value_satisfies,
    scalar_numeric_op_feasible_interval,
    select_rule_for_first_match,
)

__all__ = [
    "ClassificationEngine",
    "ClassificationError",
    "ConditionEvaluator",
    "RuleMatcher",
    "evaluate_classification",
    "find_classification_rule_for_class_id",
    "find_first_matching_classification_rule",
    "semantic_candidate_matches_class_rule",
    "select_rule_for_first_match",
    "row_indicator_numeric_value_satisfies",
    "scalar_numeric_op_feasible_interval",
    "_MAX_ROW_PAIR_RATIO_TOLERANCE_REL",
    "_condition_group_id",
    "_condition_holds",
    "_condition_is_primary",
    "_rule_first_match_tiebreak_score",
    "_rule_matches",
]
