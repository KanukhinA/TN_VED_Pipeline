"""Безопасное вычисление коротких числовых формул (+ − × ÷, унарный ±, скобки, константы, имена)."""

from __future__ import annotations

import ast
import operator as op
from typing import Dict, Set


_BINOPS = {
    ast.Add: op.add,
    ast.Sub: op.sub,
    ast.Mult: op.mul,
    ast.Div: op.truediv,
}


def validate_formula_identifiers(formula: str, allowed_names: Set[str]) -> None:
    """Все идентификаторы в выражении должны входить в allowed_names."""
    tree = ast.parse(formula.strip(), mode="eval")
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            if node.id not in allowed_names:
                raise ValueError(f"formula: неизвестный идентификатор «{node.id}» (задайте его в переменных)")


def eval_numeric_formula(formula: str, variables: Dict[str, float]) -> float:
    """
    Вычисляет формулу; variables — значения уже подставленных строк массива.
    Division by zero → ZeroDivisionError.
    """
    tree = ast.parse(formula.strip(), mode="eval")
    validate_formula_identifiers(formula, set(variables.keys()))
    return _eval_node(tree.body, variables)


def _eval_node(node: ast.AST, env: Dict[str, float]) -> float:
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool):
            raise ValueError("formula: логические значения не поддерживаются")
        if isinstance(node.value, (int, float)):
            return float(node.value)
        raise ValueError("formula: допускаются только числовые константы")
    if isinstance(node, ast.Name):
        if node.id not in env:
            raise ValueError(f"formula: нет значения для «{node.id}»")
        return float(env[node.id])
    if isinstance(node, ast.BinOp):
        if type(node.op) not in _BINOPS:
            raise ValueError("formula: разрешены только +, −, ×, ÷")
        left = _eval_node(node.left, env)
        right = _eval_node(node.right, env)
        if isinstance(node.op, ast.Div) and right == 0.0:
            raise ZeroDivisionError("division by zero")
        fn = _BINOPS[type(node.op)]
        return float(fn(left, right))
    if isinstance(node, ast.UnaryOp):
        if isinstance(node.op, ast.USub):
            return -_eval_node(node.operand, env)
        if isinstance(node.op, ast.UAdd):
            return _eval_node(node.operand, env)
    raise ValueError(f"formula: неподдерживаемый фрагмент ({type(node).__name__})")
