"""
Устойчивое извлечение и парсинг JSON из ответов LLM.
Логика согласована с LLM_QuantityExtractor_Evaluator (utils.py): extract_json_from_response + parse_json_safe.
"""

from __future__ import annotations

import ast
import json
import re
from typing import Any


def _extract_json_like(s: str) -> str:
    """
    Извлекает JSON-подстроку:
    1) fenced ```json ... ```
    2) иначе — от первой '{' до конца (или '[')
    """
    if not isinstance(s, str):
        return ""

    m = re.search(r"```(?:json)?\s*(.*?)\s*```", s, flags=re.IGNORECASE | re.DOTALL)
    if m:
        return m.group(1).strip()

    s_stripped = re.sub(r"^[\s\*\-#>]+", "", s.lstrip())
    idx = s_stripped.find("{")
    if idx != -1:
        return s_stripped[idx:].strip()
    idx = s_stripped.find("[")
    if idx != -1:
        return s_stripped[idx:].strip()
    return ""


def _autofix_commas(s: str) -> str:
    s = re.sub(r"}\s*{", "}, {", s)
    s = re.sub(r"}\s*\n\s*{", "},\n{", s)
    s = re.sub(r"]\s*{", "], {", s)
    s = re.sub(r",\s*}", "}", s)
    s = re.sub(r",\s*\]", "]", s)
    return s


def _balance_and_close(s: str) -> str:
    depth_obj = 0
    depth_arr = 0
    in_string = False
    escape = False

    for ch in s:
        if ch == "\\" and not escape:
            escape = True
            continue
        elif escape:
            if ch == '"':
                escape = False
                continue
            escape = False

        if ch == '"' and not escape:
            in_string = not in_string
            continue

        if not in_string:
            if ch == "{":
                depth_obj += 1
            elif ch == "}":
                if depth_obj > 0:
                    depth_obj -= 1
            elif ch == "[":
                depth_arr += 1
            elif ch == "]":
                if depth_arr > 0:
                    depth_arr -= 1

    if in_string:
        s = s + '"'
        if re.search(r'[,{]\s*"[^"]*"$', s.rstrip()):
            s = s.rstrip() + ": null"

    s_stripped = s.rstrip()
    if s_stripped:
        last_non_ws = s_stripped[-1]
        if last_non_ws == ":":
            s = s.rstrip() + " null"
        elif last_non_ws == ",":
            s = s_stripped[:-1].rstrip()

    closing = ""
    if depth_arr > 0:
        closing += "]" * depth_arr
    if depth_obj > 0:
        closing += "}" * depth_obj
    if closing:
        s = s + closing
    return s


def parse_json_safe(s: str) -> Any:
    """
    Парсер JSON с автопочинкой и дозакрытием скобок.
    Возвращает dict, list или {} при неудаче.
    """
    if not isinstance(s, str) or not s.strip():
        return {}

    fragment = _extract_json_like(s)
    if not fragment:
        return {}

    s_clean = fragment
    try:
        s_clean = s_clean.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
    except Exception:
        pass
    s_clean = s_clean.replace("\r", "").strip()

    s_clean = (
        s_clean.replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u201a", "'")
        .replace("\u2018", "'")
    )
    s_clean = re.sub(r"\bNone\b", "null", s_clean)
    s_clean = _autofix_commas(s_clean)
    s_clean = _balance_and_close(s_clean)
    s_clean = re.sub(r",\s*,+", ",", s_clean)
    s_clean = re.sub(r",\s*}", "}", s_clean)
    s_clean = re.sub(r",\s*\]", "]", s_clean)

    try:
        parsed = json.loads(s_clean)
        if isinstance(parsed, (dict, list)):
            return parsed
        return {}
    except json.JSONDecodeError:
        pass

    s_eval = re.sub(r"\bnull\b", "None", s_clean)
    try:
        data = ast.literal_eval(s_eval)
        if isinstance(data, (dict, list)):
            return data
        return {}
    except Exception:
        pass
    return {}


def extract_json_from_response(response_text: str) -> str:
    """
    Выделяет JSON-часть из ответа модели (маркеры «Ответ:» / fenced block / первая скобка).
    """
    if not response_text:
        return ""

    response_lower = response_text.lower()
    answer_markers = ("ответ:", "answer:")
    for marker in answer_markers:
        last_idx = -1
        search_pos = 0
        while True:
            idx = response_lower.find(marker, search_pos)
            if idx == -1:
                break
            last_idx = idx
            search_pos = idx + 1

        if last_idx != -1:
            json_part = response_text[last_idx + len(marker) :].strip()
            json_part = json_part.lstrip("\n\r\t ")
            json_blocks = list(
                re.finditer(r"```(?:json)?\s*(.*?)\s*```", json_part, flags=re.IGNORECASE | re.DOTALL)
            )
            if json_blocks:
                extracted = json_blocks[-1].group(1).strip()
                if extracted:
                    return extracted
            first_brace = json_part.find("{")
            first_bracket = json_part.find("[")
            start = -1
            if first_brace != -1 and first_bracket != -1:
                start = min(first_brace, first_bracket)
            elif first_brace != -1:
                start = first_brace
            elif first_bracket != -1:
                start = first_bracket
            if start != -1:
                extracted = json_part[start:].strip()
                if extracted:
                    return extracted
            if json_part.strip():
                return json_part

    json_blocks = list(
        re.finditer(r"```(?:json)?\s*(.*?)\s*```", response_text, flags=re.IGNORECASE | re.DOTALL)
    )
    if json_blocks:
        extracted = json_blocks[-1].group(1).strip()
        if extracted:
            return extracted

    first_brace = response_text.find("{")
    first_bracket = response_text.find("[")
    start = -1
    if first_brace != -1 and first_bracket != -1:
        start = min(first_brace, first_bracket)
    elif first_brace != -1:
        start = first_brace
    elif first_bracket != -1:
        start = first_bracket
    if start != -1:
        extracted = response_text[start:].strip()
        if extracted:
            return extracted
    return response_text.strip()


def parse_json_from_model_response(response_text: str) -> Any:
    """Извлечение кандидата + устойчивый парсинг (удобная точка входа для пайплайна)."""
    fragment = extract_json_from_response(response_text)
    return parse_json_safe(fragment)


def is_valid_json_object(s: str) -> bool:
    try:
        parsed = parse_json_safe(s)
        return isinstance(parsed, dict) and bool(parsed)
    except Exception:
        return False
