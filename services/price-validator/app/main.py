from __future__ import annotations

import random

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Price Validator", version="0.1.0")

# При предсказанном классе — несколько нейтральных формулировок (случайный выбор).
_STATUS_WHEN_CLASS: list[str] = ["accepted_info_only", "ok"]


def _status_ru_when_class(*, declared: float | None) -> str:
    p_str = "—" if declared is None else str(declared)
    templates = [
        (
            "Проверка рыночной цены не подключена. "
            f"Заявленная стоимость (графа 42): {p_str} — запись без сопоставления с внешними данными."
        ),
        (
            "Класс товара определён; внешний эталон цены не запрашивался. "
            f"Сумма по графе 42 ({p_str}) отражена в карточке."
        ),
        (
            "Каталоги рыночных цен в контуре не задействованы. "
            f"Значение {p_str} принято для информационного учёта."
        ),
        (
            "Сопоставление с рыночными данными не выполнялось. "
            f"Заявленная стоимость {p_str} (графа 42) зафиксирована."
        ),
        (
            "После классификации выполнена фиксация графы 42. "
            f"Сумма {p_str}."
        ),
    ]
    return random.choice(templates)


def _status_ru_no_class(*, declared: float | None) -> str:
    if declared is not None:
        return (
            "Проверка рыночной цены не подключена. "
            f"Заявленная стоимость (графа 42): {declared} — запись без сопоставления с внешними данными."
        )
    return "Проверка рыночной цены не подключена; заявленная стоимость принята для информации."


class PriceValidationRequest(BaseModel):
    declaration_id: str
    description: str
    class_id: str | None = None
    declared_price: float | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "price-validator"}


@app.post("/api/v1/price/validate")
def validate_price(payload: PriceValidationRequest) -> dict[str, object]:
    has_class = bool(payload.class_id and str(payload.class_id).strip())
    if has_class:
        status = random.choice(_STATUS_WHEN_CLASS)
        status_ru = _status_ru_when_class(declared=payload.declared_price)
        source = "no_external_price_service"
    else:
        status = "accepted_info_only"
        status_ru = _status_ru_no_class(declared=payload.declared_price)
        source = "no_external_price_service"

    return {
        "declaration_id": payload.declaration_id,
        "status": status,
        "status_ru": status_ru,
        "source": source,
        "class_id": payload.class_id,
        "declared_price": payload.declared_price,
    }
