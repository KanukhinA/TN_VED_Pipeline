from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from .api.routes_rules import router as rules_router
from .api.routes_feature_extraction_settings import router as feature_extraction_settings_router
from .api.routes_officer_pipeline import router as officer_pipeline_router
from .api.routes_expert_decisions import router as expert_decisions_router
from .db.session import create_db_and_tables


class ClassifyStubRequest(BaseModel):
    """Тестовый payload для заглушки классификации."""
    description: str
    tnved_code: str | None = None
    features: dict[str, object] | None = None


def create_app() -> FastAPI:
    """Фабрика FastAPI-приложения backend rules-engine."""
    app = FastAPI(title="Pydantic Rule Builder")

    @app.on_event("startup")
    def _startup() -> None:
        # Создаём таблицы при старте сервиса (для локального/development запуска).
        create_db_and_tables()

    app.include_router(rules_router)
    app.include_router(feature_extraction_settings_router)
    app.include_router(officer_pipeline_router)
    app.include_router(expert_decisions_router)

    @app.get("/health")
    def health() -> dict[str, str]:
        """Healthcheck для оркестратора/балансировщика."""
        return {"status": "ok", "service": "rules-engine"}

    @app.post("/api/pipeline/classify-stub")
    def classify_stub(payload: ClassifyStubRequest) -> dict[str, object]:
        """Упрощённая заглушка классификации для интеграционных тестов UI/пайплайна."""
        matched = payload.tnved_code is not None and payload.tnved_code.startswith("31")
        return {
            "matched": matched,
            "class_id": "CLASS-31-RULES" if matched else None,
            "reason": "rules_match_stub" if matched else "no_deterministic_match",
            "features_echo": payload.features or {},
        }

    return app


app = create_app()

