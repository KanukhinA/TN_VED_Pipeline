"""Лексическая схожесть для калибровки порога по эталонам (без эмбеддингов)."""

from __future__ import annotations

import re


def token_jaccard(a: str, b: str) -> float:
    sa = set(re.findall(r"[\wа-яА-ЯёЁ]+", (a or "").lower()))
    sb = set(re.findall(r"[\wа-яА-ЯёЁ]+", (b or "").lower()))
    if not sa and not sb:
        return 1.0
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)
