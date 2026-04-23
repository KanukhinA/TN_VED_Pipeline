from __future__ import annotations

import hashlib

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Price Validator", version="0.2.0")


def _stable_hash01(s: str) -> float:
    h = hashlib.sha256(s.encode("utf-8")).hexdigest()
    x = int(h[:8], 16)
    return x / 0xFFFFFFFF


def _round2(v: float) -> float:
    return round(float(v), 2)


class PriceValidationRequest(BaseModel):
    declaration_id: str
    description: str
    class_id: str | None = None
    declared_price: float | None = None
    gross_weight_kg: float | None = None
    net_weight_kg: float | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "price-validator"}


@app.post("/api/v1/price/validate")
def validate_price(payload: PriceValidationRequest) -> dict[str, object]:
    declared = float(payload.declared_price or 0.0)
    # Для оценки используем нетто, иначе брутто, иначе fallback.
    mass_kg = (
        float(payload.net_weight_kg)
        if payload.net_weight_kg is not None and payload.net_weight_kg > 0
        else float(payload.gross_weight_kg)
        if payload.gross_weight_kg is not None and payload.gross_weight_kg > 0
        else 1000.0
    )

    seed = f"{payload.class_id or ''}|{payload.description[:120]}"
    k = _stable_hash01(seed)
    # Заглушка расценок: базовая ставка 80..320 у.е./кг.
    rate_per_kg = 80.0 + 240.0 * k
    expected_avg = mass_kg * rate_per_kg

    if expected_avg <= 0:
        dev_pct = 0.0
    else:
        dev_pct = (declared - expected_avg) / expected_avg * 100.0
    dev_abs = declared - expected_avg
    mismatch = abs(dev_pct) > 15.0
    status = "price_mismatch" if mismatch else "ok"

    if mismatch:
        verdict = "Стоимость заметно отклоняется от ориентировочной средней для данного объёма."
    else:
        verdict = "Стоимость находится в допустимом диапазоне относительно ориентировочной средней."
    status_ru = (
        f"{verdict} Средняя оценка: {_round2(expected_avg)}; "
        f"отклонение: {_round2(dev_abs)} ({_round2(dev_pct)}%)."
    )

    return {
        "declaration_id": payload.declaration_id,
        "status": status,
        "status_ru": status_ru,
        "source": "stub_rate_card",
        "class_id": payload.class_id,
        "declared_price": payload.declared_price,
        "basis_mass_kg": _round2(mass_kg),
        "rate_per_kg": _round2(rate_per_kg),
        "expected_average_price": _round2(expected_avg),
        "deviation_abs": _round2(dev_abs),
        "deviation_pct": _round2(dev_pct),
    }
