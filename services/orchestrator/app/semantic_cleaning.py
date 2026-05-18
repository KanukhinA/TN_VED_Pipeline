"""Промпт и разбор ответа LLM-чистки описания перед семантической векторизацией.

При constrained decoding схема JSON задаётся ``OLLAMA_SEMANTIC_CLEANING_JSON_FORMAT`` и передаётся в preprocessing
как ``format`` (Ollama) или встроенный ``response_format`` (vLLM).
"""

from __future__ import annotations

from typing import Any

from app.json_recovery import parse_json_from_model_response

# Полностью подставляется в конфигурацию по умолчанию; пользователь может изменить в `pipeline.json` или в интерфейсе.
DEFAULT_SEMANTIC_CLEANING_PROMPT = (
    "Ты очищаешь описание товара из графы 31 перед семантической векторизацией.\n"
    "Сформируй очищенный текст на русском языке: без комментариев и пояснений с твоей стороны.\n"
    "Удаляй шум и служебные фрагменты, оставляй только:\n"
    "- наименование товара,\n"
    "- технические характеристики (класс, марку),\n"
    "- количественный и качественный состав (процентное содержание, массовую долю).\n"
    "Если требуемого содержимого нет, очищенный текст должен быть пустым.\n"
    "Пример запроса: «УДОБРЕНИЯ МИНЕРАЛЬНЫЕ КАЛИЙ СЕРНОКИСЛЫЙ (СУЛЬФАТ КАЛИЯ) ГРАНУЛИРОВАННЫЙ, СОДЕРЖАНИЕ К2О НЕ МЕНЕЕ 50%.ВИДЕ ГРАНУЛ (2-5 ММ.), "
    "ПРИМЕНЯЕТСЯ В СЕЛЬСКОМ ХОЗЯЙСТВЕ.21 ПОДДОН.СПОСОБ РАСФАСОВКИ: 21 МЕШОК БИГ БЭГ ПО 1000 КГ.КОЛИЧЕСТВЕННЫЙ И КАЧЕСТВЕННЫЙ СОС 21 ПОДДОН. "
    "СПОСОБ РАСФАСОВКИ: 21 МЕШОК БИГ БЭГ ПО 1000 КГ. КОЛИЧЕСТВЕННЫЙ И КАЧЕСТВЕННЫЙ СОСТАВ: СОДЕРЖАНИЕ К2О НЕ МЕНЕЕ 50% ГОСТ Р 51520-99, "
    "ТУ 20.15.52-004-63727772-17 :»\n"
    'Пример ответа: {"answer": "УДОБРЕНИЯ МИНЕРАЛЬНЫЕ КАЛИЙ СЕРНОКИСЛЫЙ (СУЛЬФАТ КАЛИЯ) ГРАНУЛИРОВАННЫЙ. СОДЕРЖАНИЕ К2О НЕ МЕНЕЕ 50%. '
    'ВИДЕ ГРАНУЛ (2-5 ММ.). ПРИМЕНЯЕТСЯ В СЕЛЬСКОМ ХОЗЯЙСТВЕ. ГОСТ Р 51520-99, ТУ 20.15.52-004-63727772-17."}\n\n'
    "Исходное описание:\n{исходный_текст}"
)

SEMANTIC_CLEANING_JSON_SUFFIX = (
    "\n\n---\n"
    "Формат ответа (обязательно): верни ровно один JSON-объект в кодировке UTF-8, без текста до и после, "
    "без обёртки markdown, без пояснений. Структура:\n"
    '{"answer": "<очищенный текст>"}\n'
    "Ключ поля — латиницей «answer». Значение — строка с очищенным текстом; внутри строки "
    "экранируй кавычки и управляющие символы по правилам JSON. Если очищать нечего, верни {\"answer\":\"\"}."
)

# JSON Schema для structured outputs (Ollama ``format`` / vLLM); ключ ``answer`` — ASCII для стабильности грамматики.
OLLAMA_SEMANTIC_CLEANING_JSON_FORMAT: dict[str, Any] = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
    },
    "required": ["answer"],
}


def render_semantic_cleaning_prompt(template: str, source_text: str) -> str:
    """Подставляет исходный текст в шаблон с поддержкой плейсхолдеров."""
    tpl = str(template or "").strip()
    src = str(source_text or "")
    if "{исходный_текст}" in tpl:
        return tpl.replace("{исходный_текст}", src)
    if "{source_text}" in tpl:
        return tpl.replace("{source_text}", src)
    if "{{исходный_текст}}" in tpl:
        return tpl.replace("{{исходный_текст}}", src)
    if "{{source_text}}" in tpl:
        return tpl.replace("{{source_text}}", src)
    return f"{tpl}\n\nИсходное описание:\n{src}\n\nОчищенный текст:"


def finalize_semantic_cleaning_prompt(base_prompt: str, *, constrained_decoding: bool) -> str:
    """При структурированном режиме добавляет требование JSON-оболочки."""
    p = str(base_prompt or "").rstrip()
    if not constrained_decoding:
        return p
    return p + SEMANTIC_CLEANING_JSON_SUFFIX


def extract_semantic_cleaned_text(
    raw_response: str,
    *,
    constrained_decoding: bool,
) -> str:
    """
    Из сырого ответа модели получает строку для векторизации.

    Если ответ — JSON-оболочка с ``answer`` или «ответ», извлекаем строку **всегда**
    (и при ``constrained_decoding=False``, если модель всё равно вернула JSON по промпту).
    Иначе — весь сырой текст (свободная форма).
    """
    _ = constrained_decoding  # флаг оставлен в сигнатуре вызовов (пайплайн / тесты); логика извлечения одинакова.
    raw = str(raw_response or "").strip()
    if not raw:
        return ""
    try:
        parsed: Any = parse_json_from_model_response(raw)
    except Exception:
        return raw
    if isinstance(parsed, dict):
        val = parsed.get("answer")
        if val is None:
            val = parsed.get("ответ")
        if isinstance(val, str):
            return val.strip()
        if val is not None:
            return str(val).strip()
    return raw
