"""
Единая сборка пользовательского промпта и текста декларации для извлечения признаков.

Используется и в officer_run (инспектор), и в тесте промпта (настройки эксперта / api-gateway),
чтобы строка в Ollama совпадала побайтово при одинаковых входных данных.
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
