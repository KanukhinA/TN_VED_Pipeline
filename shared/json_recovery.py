"""
Извлечение и разбор структурированных данных из ответов больших языковых моделей.

Общий компонент модуля извлечения характеристик (сервис предобработки, шлюз API, оркестратор):
реализует этапы «выделение JSON-подобного фрагмента» и «парсинг с восстановлением синтаксиса»
многоэтапная процедура: маркер «Ответ:», блок ```json, нормализация кавычек и None→null,
вставка пропущенных запятых, завершение обрезанных структур, запасной разбор при ошибке json.loads.
После разбора признаки проходят семантическую валидацию по схеме справочника в Pydantic уже
в движке правил или сервисе предобработки.
"""

from __future__ import annotations

import ast
import json
import re
from typing import Any


def _extract_json_like(s: str) -> str:
    """
    Вырезает из произвольной строки фрагмент, похожий на JSON.

    Порядок: блок ```json ... ```, иначе текст от первой «{» или «[» до конца строки.
    Не проверяет корректность — только границы кандидата.
    """
    if not isinstance(s, str):
        return ""

    # Сначала ищем оформленный блок кода (частый формат ответов моделей).
    m = re.search(r"```(?:json)?\s*(.*?)\s*```", s, flags=re.IGNORECASE | re.DOTALL)
    if m:
        return m.group(1).strip()

    # Убираем маркеры списков markdown в начале и берём от первой структурной скобки.
    s_stripped = re.sub(r"^[\s\*\-#>]+", "", s.lstrip())
    idx = s_stripped.find("{")
    if idx != -1:
        return s_stripped[idx:].strip()
    idx = s_stripped.find("[")
    if idx != -1:
        return s_stripped[idx:].strip()
    return ""


def _autofix_commas(s: str) -> str:
    """Исправляет типичные синтаксические огрехи: слипшиеся объекты и хвостовые запятые."""
    s = re.sub(r"}\s*{", "}, {", s)
    s = re.sub(r"}\s*\n\s*{", "},\n{", s)
    s = re.sub(r"]\s*{", "], {", s)
    s = re.sub(r",\s*}", "}", s)
    s = re.sub(r",\s*\]", "]", s)
    return s


def _balance_and_close(s: str) -> str:
    """
    Дозакрывает незакрытые кавычки, объекты и массивы в обрезанном ответе модели.

    Обходит строку посимвольно, не считая скобки внутри строковых литералов.
    В конце дописывает недостающие «]» и «}» по накопленной глубине вложенности.
    """
    depth_obj = 0
    depth_arr = 0
    in_string = False
    escape = False

    for ch in s:
        # Внутри строки обратный слэш откладывает смену режима кавычек.
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

        # Скобки вне строки меняют счётчики вложенности.
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

    # Обрыв посреди строкового значения: закрываем кавычку и при необходимости дописываем значение.
    if in_string:
        s = s + '"'
        if re.search(r'[,{]\s*"[^"]*"$', s.rstrip()):
            s = s.rstrip() + ": null"

    s_stripped = s.rstrip()
    if s_stripped:
        last_non_ws = s_stripped[-1]
        # Обрыв на двоеточии или запятой — подставляем null или убираем висячую запятую.
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
    Разбирает строку в dict или list с поэтапной нормализацией.

    Возвращает пустой dict, если вход пустой, фрагмент не найден или разбор не удался.
    Скалярные значения (число, строка без обёртки) не возвращаются — только объект или массив.
    """
    if not isinstance(s, str) or not s.strip():
        return {}

    fragment = _extract_json_like(s)
    if not fragment:
        return {}

    s_clean = fragment
    try:
        # Иногда модель отдаёт буквальные «\\n» вместо перевода строки.
        s_clean = s_clean.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
    except Exception:
        pass
    s_clean = s_clean.replace("\r", "").strip()

    # Типографские кавычки и Python None → форма, близкая к JSON.
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

    # Запасной путь: одинарные кавычки и Python-синтаксис, если JSON строго не прошёл.
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
    Выделяет JSON-часть из полного текста ответа модели.

    Приоритет:
    1) текст после последнего «Ответ:» / «answer:» (модель часто пишет пояснение, затем JSON);
    2) последний блок ```json ... ``` во всём ответе;
    3) подстрока от первой «{» или «[».
    """
    if not response_text:
        return ""

    response_lower = response_text.lower()
    answer_markers = ("ответ:", "answer:")
    for marker in answer_markers:
        # Берём последнее вхождение маркера — там обычно финальный структурированный ответ.
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

    # Маркера «Ответ:» нет — ищем последний json-блок по всему тексту.
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
    """
    Точка входа для пайплайна: выделить фрагмент из ответа модели и разобрать его.

    Возвращает dict, list или {} при полной неудаче разбора.
    """
    fragment = extract_json_from_response(response_text)
    return parse_json_safe(fragment)


def is_valid_json_object(s: str) -> bool:
    """Проверяет, что после устойчивого разбора получился непустой объект (словарь)."""
    try:
        parsed = parse_json_safe(s)
        return isinstance(parsed, dict) and bool(parsed)
    except Exception:
        return False
