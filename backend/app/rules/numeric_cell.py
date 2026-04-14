"""
Значение числовой ячейки в JSON: скаляр или список из двух чисел [min, max] (в любом порядке).
Для правил используется среднее арифметическое границ (согласовано с логикой min/max в условиях).
"""

from __future__ import annotations

from typing import Any, Optional


def coerce_numeric_cell_to_scalar(value: Any) -> Optional[float]:
    """
    Скаляр int/float → float.
    Список из двух чисел → (a + b) / 2.
    Список из одного числа → это число.
    Иначе None (в т.ч. bool не считаем числом ячейки).
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, list):
        if len(value) == 2:
            try:
                a = float(value[0])
                b = float(value[1])
            except (TypeError, ValueError):
                return None
            return (a + b) / 2.0
        if len(value) == 1:
            try:
                return float(value[0])
            except (TypeError, ValueError):
                return None
    return None
