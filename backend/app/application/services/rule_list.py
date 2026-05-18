"""Сортировка и фильтрация списка справочников."""

from __future__ import annotations

from typing import Optional

from ..dto.rules_catalog import RuleListItem


def rule_list_sort_key(item: RuleListItem) -> tuple[int, str]:
    c = item.tn_ved_group_code
    if c and c.isdigit():
        return (int(c), (item.name or "").lower())
    return (9999, (item.name or "").lower())


def catalog_row_matches_search(
    *,
    model_id: str,
    name: Optional[str],
    tn_ved_group_code: Optional[str],
    q_normalized: str,
) -> bool:
    """Проверка попадания справочника под поисковую строку (уже lower/strip)."""
    if not q_normalized:
        return True
    if q_normalized in model_id.lower():
        return True
    if name and q_normalized in (name or "").lower():
        return True
    if tn_ved_group_code:
        if q_normalized in tn_ved_group_code:
            return True
        if q_normalized.isdigit():
            try:
                if int(q_normalized) == int(tn_ved_group_code):
                    return True
            except ValueError:
                pass
    return False
