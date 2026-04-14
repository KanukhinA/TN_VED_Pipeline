from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, List, Literal, Optional


@dataclass(frozen=True)
class PathStep:
    kind: Literal["prop", "wildcard"]
    name: Optional[str] = None


_ARRAY_TOKEN_RE = re.compile(r"^(?P<name>[^\[\]]+)?\[(?P<inside>\*?)\]$")


def parse_path(path: str) -> List[PathStep]:
    """
    Поддерживаем синтаксис:
    - `prop1.prop2`
    - `array[*].prop` или `array[].prop` (оба вида wildcard)
    - `array[*]` (конечный wildcard даёт значения из элементов массива)
    """

    if not path or not isinstance(path, str):
        raise ValueError("path must be non-empty string")

    tokens = path.split(".")
    steps: List[PathStep] = []
    for token in tokens:
        token = token.strip()
        if not token:
            raise ValueError(f"Invalid empty path segment in '{path}'")

        m = _ARRAY_TOKEN_RE.match(token)
        if m:
            name = m.group("name")
            inside = m.group("inside")
            # token вида `[*]` или `[]` без имени
            if name:
                steps.append(PathStep(kind="prop", name=name))
            if inside == "*" or inside == "":
                steps.append(PathStep(kind="wildcard"))
            continue

        steps.append(PathStep(kind="prop", name=token))

    return steps


def extract_values(data: Any, path: str) -> List[Any]:
    """
    Достает все значения по path.
    Если на каком-то шаге ключ отсутствует или тип не совпадает, просто игнорируется.
    """

    steps = parse_path(path)
    current: List[Any] = [data]

    for step in steps:
        next_values: List[Any] = []
        if step.kind == "prop":
            key = step.name
            assert key is not None
            for value in current:
                if isinstance(value, dict) and key in value:
                    next_values.append(value[key])
        elif step.kind == "wildcard":
            for value in current:
                if isinstance(value, list):
                    next_values.extend(value)
        else:
            raise RuntimeError(f"Unknown step kind: {step.kind}")

        current = next_values

    return current


def path_exists(data: Any, path: str) -> bool:
    values = extract_values(data, path)
    return len(values) > 0


def extract_first_value(data: Any, path: str) -> Any:
    values = extract_values(data, path)
    return values[0] if values else None

