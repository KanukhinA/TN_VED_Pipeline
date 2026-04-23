"""
Человекочитаемые пояснения к типичным ошибкам Pydantic для интерфейса инспектора.
Исходные строки остаются в errors; сюда — параллельный список errors_ru.
"""

from __future__ import annotations

import json
import re
from typing import Any, List


_PYDANTIC_URL = re.compile(r"\s*For further information visit https?://\S+")


def _strip_pydantic_footer(msg: str) -> str:
    return _PYDANTIC_URL.sub("", msg).strip()


def _first_field_line(err: str) -> str:
    """Вторая непустая строка часто — имя поля (прочее, массовая доля, …)."""
    lines = [ln.strip() for ln in err.splitlines() if ln.strip()]
    for ln in lines[1:]:
        if ln.startswith("For further"):
            continue
        if "validation error for" in ln.lower():
            continue
        if "[" in ln and "type=" in ln:
            continue
        if len(ln) < 80 and not ln.startswith("1 "):
            return ln
    return ""


def humanize_pydantic_validation_error(err: Any) -> str:
    """
    Преобразует одну ошибку (обычно str(Exception) от Pydantic) в короткий текст по-русски.
    """
    if err is None:
        return ""
    s = str(err).strip()
    if not s:
        return ""

    s = _strip_pydantic_footer(s)
    low = s.lower()

    # Лишние поля в объекте (extra='forbid' на вложенной модели)
    if "extra_forbidden" in low or "extra inputs are not permitted" in low:
        field = _first_field_line(s)
        tail = (
            "Схема справочника задаёт точный набор полей в каждой строке. "
            "Модель извлечения могла вернуть другие имена полей (например «параметр»/«значение»), "
            "которые не совпадают с полями в редакторе структуры правила — тогда проверка останавливается, класс не назначается."
        )
        if field:
            return f"Поле «{field}»: {tail}"
        return tail

    if "missing" in low and "field required" in low:
        return (
            "Не хватает обязательного поля по схеме справочника. "
            "Проверьте, что извлечение заполняет все требуемые поля, или ослабьте требования в структуре правила."
        )

    if "none is not an allowed value" in low or "input should be" in low:
        return (
            "Значение не подходит под ожидаемый тип или ограничения схемы (число, строка, перечень и т.д.). "
            "Сверьте извлечённый JSON с полями в редакторе справочника."
        )

    if "string_too_short" in low or "at least" in low and "character" in low:
        return "Строка короче минимальной длины, заданной в схеме."

    if "string_too_long" in low:
        return "Строка длиннее максимума, заданного в схеме."

    if "greater_than_equal" in low or "less_than_equal" in low:
        return "Число выходит за допустимые границы (min/max) в схеме справочника."

    if "pattern" in low and "string" in low:
        return "Строка не соответствует шаблону (pattern), заданному в схеме."

    if "validation error" in low:
        return (
            "Ошибка проверки данных по схеме справочника. Ниже — технический текст движка; "
            "часто помогает приведение структуры извлечения к полям правила или правка схемы в редакторе."
        )

    return s


def _normalize_matched_class_ids(details: Any) -> List[str]:
    """Идентификаторы классов из ответа классификатора (в т.ч. если ключ отсутствовал или был null)."""
    if not isinstance(details, dict):
        return []
    raw = details.get("matched_class_ids")
    if raw is None:
        return []
    if not isinstance(raw, list):
        return []
    return [str(x).strip() for x in raw if str(x).strip()]


def humanize_officer_error_list(errors: List[Any]) -> List[str]:
    out: List[str] = []
    for e in errors:
        if isinstance(e, dict):
            msg = e.get("message") or e.get("msg") or e.get("detail")
            details = e.get("details")
            # Устаревшие ошибки классификации с matched_class_ids в details (текущий движок их не шлёт).
            if isinstance(details, dict) and "matched_class_ids" in details:
                class_ids = _normalize_matched_class_ids(details)
                if len(class_ids) > 1:
                    out.append(
                        "Подошло несколько классов: "
                        + ", ".join(class_ids)
                        + ". Выберите один корректный или уточните условия в справочнике."
                    )
                    continue
                if len(class_ids) == 0:
                    out.append(
                        "Ни одно правило классификации не подошло. "
                        "Уточните условия в справочнике, назначьте класс вручную или обратитесь к эксперту."
                    )
                    continue
            if isinstance(msg, str) and msg.strip():
                out.append(humanize_pydantic_validation_error(msg))
            else:
                out.append(
                    "Ошибка правила (структурировано): "
                    + json.dumps(e, ensure_ascii=False, default=str)[:2000]
                )
        else:
            out.append(humanize_pydantic_validation_error(e))
    return out


def note_class_not_assigned_ru(validation_ok: bool, assigned_class: Any) -> str | None:
    """Пояснение, почему нет класса в итоге."""
    if assigned_class:
        return None
    if not validation_ok:
        return None
    return (
        "Итоговый класс не назначен: для выбранного справочника не сработало ни одно правило классификации "
        "(или не задана классификация)."
    )
