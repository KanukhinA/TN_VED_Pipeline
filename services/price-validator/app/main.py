from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Price Validator", version="0.1.0")


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
    status_ru = "Проверка рыночной цены не подключена; заявленная стоимость принята для информации."
    if payload.declared_price is not None:
        status_ru = (
            f"Проверка рыночной цены не подключена. "
            f"Заявленная стоимость (графа 42): {payload.declared_price} — запись без сопоставления с внешними данными."
        )
    return {
        "declaration_id": payload.declaration_id,
        "status": "accepted_info_only",
        "status_ru": status_ru,
        "source": "no_external_price_service",
        "class_id": payload.class_id,
    }
