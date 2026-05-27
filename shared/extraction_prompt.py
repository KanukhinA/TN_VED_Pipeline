"""
Сборка промпта для модуля извлечения характеристик LLM (сервис предобработки).

Объединяет текст промпта эксперта, описание товара из декларации и при необходимости
префикс правил. Одинаковая строка в officer_run (интерфейс инспектора) и при тесте
промпта на вкладке «Настройка справочников» — воспроизводимость вызова Ollama/vLLM.
"""

from __future__ import annotations


def assemble_feature_extraction_prompt(
    user_prompt: str,
    source_text: str,
    *,
    rules_preview: str | None = None,
) -> str:
    """
    rules_preview: только для вспомогательных сценариев (например few-shot с префиксом).
    Прод-путь инспектора и тест промпта передают правило по умолчанию (None).
    """
    parts: list[str] = []
    rp = (rules_preview or "").strip()
    if rp:
        parts.append(rp)
    pr = (user_prompt or "").strip()
    if pr:
        parts.append(pr)
    st = (source_text or "").strip()
    if st:
        parts.append("Текст для извлечения:\n" + st)
    return "\n\n".join(parts)
