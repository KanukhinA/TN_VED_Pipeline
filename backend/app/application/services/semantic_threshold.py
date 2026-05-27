"""
Вспомогательная калибровка порога семантической схожести по эталонам справочника.

Лексическая мера (коэффициент Жаккара по словам) без вызова sentence-transformers — для
экрана настройки порога в интерфейсе эксперта. GetSemanticThresholdUseCase.
"""

from __future__ import annotations

import re


def token_jaccard(a: str, b: str) -> float:
    """Коэффициент Жаккара по словам (русские и латинские буквы, цифры, подчёркивание)."""
    sa = set(re.findall(r"[\wа-яА-ЯёЁ]+", (a or "").lower()))
    sb = set(re.findall(r"[\wа-яА-ЯёЁ]+", (b or "").lower()))
    if not sa and not sb:
        return 1.0
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)
