"""
Число в ячейке таблицы показателей: скаляр или интервал измерения [min, max].

Для «У поля с таким значением, диапазон числа» — весь отрезок измерения внутри коридора
«Минимум»/«Максимум». Для формулы — среднее границ. classification, analysis.overlap.
"""

from __future__ import annotations

from typing import Any, Optional, Tuple


def numeric_interval_from_cell(value: Any) -> Optional[Tuple[float, float]]:
    """
    Интервал значения ячейки для проверки по числовому коридору правила: (низ, верх), включительно.

    Скаляр → (v, v). [x, None] / [None, y] → (x, x) или (y, y). Два числа → (min, max).
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        return (v, v)
    if isinstance(value, list):
        if len(value) == 2:
            left, right = value[0], value[1]
            if left is None and right is None:
                return None
            if left is None:
                try:
                    y = float(right)
                except (TypeError, ValueError):
                    return None
                return (y, y)
            if right is None:
                try:
                    x = float(left)
                except (TypeError, ValueError):
                    return None
                return (x, x)
            try:
                a = float(left)
                b = float(right)
            except (TypeError, ValueError):
                return None
            if a <= b:
                return (a, b)
            return (b, a)
        if len(value) == 1:
            try:
                v = float(value[0])
            except (TypeError, ValueError):
                return None
            return (v, v)
    return None


def coerce_numeric_cell_to_scalar(value: Any) -> Optional[float]:
    """
    Скаляр int/float → float.
    Список из двух чисел → (a + b) / 2.
    Список из [число, None] или [None, число] → это число.
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
            left = value[0]
            right = value[1]
            if left is None and right is None:
                return None
            if left is None:
                try:
                    return float(right)
                except (TypeError, ValueError):
                    return None
            if right is None:
                try:
                    return float(left)
                except (TypeError, ValueError):
                    return None
            try:
                a = float(left)
                b = float(right)
            except (TypeError, ValueError):
                return None
            # Для формул и скалярных сравнений диапазон [a,b] сводим к одному числу — середине отрезка.
            return (a + b) / 2.0
        if len(value) == 1:
            try:
                return float(value[0])
            except (TypeError, ValueError):
                return None
    return None
