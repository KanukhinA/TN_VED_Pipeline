"""Построение списка конфликтов классификации (логика эндпоинта classification-conflicts)."""

from __future__ import annotations

from itertools import combinations
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ...rules.classification import _rule_matches
from ...rules.dsl_models import ClassificationRule
from ...rules.rule_overlap import (
    RuleOverlapDetail,
    analyze_rules_overlap,
    analyze_rules_overlap_group,
    build_ambiguous_example_for_rule_group,
    compact_numeric_constraints_for_rule,
    overlap_connected_components,
)
from ..dto.rules_catalog import RuleConflictItem, RuleOverlapColumnItem


def rule_overlap_columns_for_indices(
    rules_list: Sequence[ClassificationRule],
    idxs_zero_based: List[int],
) -> List[RuleOverlapColumnItem]:
    out: List[RuleOverlapColumnItem] = []
    for i0 in idxs_zero_based:
        r = rules_list[i0]
        lbl = (r.title or "").strip() or str(r.class_id or "").strip() or f"Правило {i0 + 1}"
        out.append(
            RuleOverlapColumnItem(
                rule_index=i0 + 1,
                label_ru=lbl,
                constraints_compact_ru=compact_numeric_constraints_for_rule(r),
            )
        )
    return out


def classification_conflict_items_for_rules(rules: Sequence[ClassificationRule]) -> list[RuleConflictItem]:
    rules_list = list(rules)
    n = len(rules_list)
    conflicts: list[RuleConflictItem] = []
    pair_detail: dict[Tuple[int, int], RuleOverlapDetail] = {}
    for i in range(n):
        for j in range(i + 1, n):
            left_title = (rules_list[i].title or "").strip() or str(rules_list[i].class_id or f"правило {i + 1}")
            right_title = (rules_list[j].title or "").strip() or str(rules_list[j].class_id or f"правило {j + 1}")
            pair_detail[(i, j)] = analyze_rules_overlap(
                rules_list[i], rules_list[j], left_title=left_title, right_title=right_title
            )

    overlap_edges = [(i, j) for (i, j), d in pair_detail.items() if d.overlaps]
    components = overlap_connected_components(overlap_edges, n)
    pairs_subsumed: set[Tuple[int, int]] = set()

    for comp in components:
        idxs = sorted(comp)
        if len(idxs) < 2:
            continue
        grp = [rules_list[i] for i in idxs]
        titles = [(rules_list[i].title or "").strip() or str(rules_list[i].class_id or f"правило {i + 1}") for i in idxs]
        ex: Optional[Dict[str, Any]] = None
        ex_note: Optional[str] = None
        try:
            ex, ex_note = build_ambiguous_example_for_rule_group(grp)
        except Exception:
            ex, ex_note = None, "Не удалось сформировать пример признаков автоматически."
        example_ok = ex is not None and all(_rule_matches(ex, rules_list[i]) for i in idxs)
        if not example_ok:
            continue
        detail_g = analyze_rules_overlap_group(grp, titles)
        if not detail_g.overlaps:
            continue
        one_based: List[int] = [i + 1 for i in idxs]
        conflicts.append(
            RuleConflictItem(
                left_rule_index=one_based[0],
                right_rule_index=one_based[-1],
                left_class_id=str(rules_list[idxs[0]].class_id or ""),
                right_class_id=str(rules_list[idxs[-1]].class_id or ""),
                left_title=rules_list[idxs[0]].title,
                right_title=rules_list[idxs[-1]].title,
                rule_indices=one_based,
                rule_class_ids=[str(rules_list[i].class_id or "") for i in idxs],
                rule_titles=[rules_list[i].title for i in idxs],
                reason_ru=detail_g.reason_ru,
                ambiguous_example=ex,
                ambiguous_example_note_ru=ex_note,
                corridor_risk_ru=detail_g.corridor_risk_ru,
                overlap_context_note_ru=detail_g.overlap_context_note_ru,
                simplified_analysis_note_ru=detail_g.simplified_analysis_note_ru,
                priority_resolution_ru=detail_g.priority_resolution_ru,
                range_intersections_ru=detail_g.range_intersections_ru,
                adjustment_recommendations_ru=detail_g.adjustment_recommendations_ru,
                overlap_axis_summary_ru=detail_g.overlap_axis_summary_ru,
                overlap_columns=rule_overlap_columns_for_indices(rules_list, idxs),
            )
        )
        for a, b in combinations(idxs, 2):
            pairs_subsumed.add((a, b))

    for i in range(n):
        for j in range(i + 1, n):
            if (i, j) in pairs_subsumed:
                continue
            detail = pair_detail[(i, j)]
            if not detail.overlaps and not detail.corridor_risk_ru:
                continue
            ex2: Optional[Dict[str, Any]] = None
            ex_note2: Optional[str] = None
            if detail.overlaps:
                try:
                    ex2, ex_note2 = build_ambiguous_example_for_rule_group([rules_list[i], rules_list[j]])
                except Exception:
                    ex2, ex_note2 = None, "Не удалось сформировать пример признаков автоматически."
            conflicts.append(
                RuleConflictItem(
                    left_rule_index=i + 1,
                    right_rule_index=j + 1,
                    left_class_id=str(rules_list[i].class_id or ""),
                    right_class_id=str(rules_list[j].class_id or ""),
                    left_title=(rules_list[i].title or None),
                    right_title=(rules_list[j].title or None),
                    rule_indices=[i + 1, j + 1],
                    rule_class_ids=[str(rules_list[i].class_id or ""), str(rules_list[j].class_id or "")],
                    rule_titles=[rules_list[i].title, rules_list[j].title],
                    reason_ru=detail.reason_ru,
                    ambiguous_example=ex2,
                    ambiguous_example_note_ru=ex_note2,
                    corridor_risk_ru=detail.corridor_risk_ru,
                    overlap_context_note_ru=detail.overlap_context_note_ru,
                    simplified_analysis_note_ru=detail.simplified_analysis_note_ru,
                    priority_resolution_ru=detail.priority_resolution_ru,
                    range_intersections_ru=detail.range_intersections_ru,
                    adjustment_recommendations_ru=detail.adjustment_recommendations_ru,
                    overlap_axis_summary_ru=detail.overlap_axis_summary_ru,
                    overlap_columns=rule_overlap_columns_for_indices(rules_list, [i, j]),
                )
            )
    return conflicts
