"""Анализ логических пересечений правил определения класса."""

from .overlap import (
    RuleOverlapDetail,
    analyze_rules_overlap,
    analyze_rules_overlap_group,
    build_ambiguous_example_for_rule_group,
    build_ambiguous_example_for_rules,
    compact_numeric_constraints_for_rule,
    overlap_connected_components,
    rules_potentially_overlap,
)

__all__ = [
    "RuleOverlapDetail",
    "analyze_rules_overlap",
    "analyze_rules_overlap_group",
    "build_ambiguous_example_for_rule_group",
    "build_ambiguous_example_for_rules",
    "compact_numeric_constraints_for_rule",
    "overlap_connected_components",
    "rules_potentially_overlap",
]
