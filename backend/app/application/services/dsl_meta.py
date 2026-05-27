"""
Метаданные справочника: код группы ТН ВЭД ЕАЭС из блока meta в dsl_json.

Используется при выборе основного справочника на товарную категорию и при сортировке
списка справочников в интерфейсе эксперта.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from ...rules.dsl_models import normalize_tn_ved_eaeu_code_value


def meta_tn_ved_group_code(dsl_json: Dict[str, Any]) -> Optional[str]:
    """Безопасно извлекает и нормализует `meta.tn_ved_group_code` из DSL-JSON."""
    meta = dsl_json.get("meta")
    if not isinstance(meta, dict):
        return None
    raw = meta.get("tn_ved_group_code")
    if raw is None:
        return None
    try:
        return normalize_tn_ved_eaeu_code_value(str(raw).strip())
    except ValueError:
        return None
