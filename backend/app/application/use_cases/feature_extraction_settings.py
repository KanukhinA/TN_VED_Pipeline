from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from fastapi import HTTPException

from ..ports.repositories import AppSettingsRepositoryPort


@dataclass
class GetFeatureExtractionSettingsUseCase:
    repo: AppSettingsRepositoryPort
    settings_key: str
    defaults_provider: Callable[[], dict[str, Any]]

    def execute(self) -> dict[str, Any]:
        payload = self.repo.get_json(self.settings_key)
        if not isinstance(payload, dict):
            return self.defaults_provider()
        models = payload.get("models")
        if not isinstance(models, dict) or len(models) == 0:
            return self.defaults_provider()
        return {"models": models}


@dataclass
class PutFeatureExtractionSettingsUseCase:
    repo: AppSettingsRepositoryPort
    settings_key: str

    def execute(self, payload: dict[str, Any]) -> dict[str, Any]:
        models = payload.get("models")
        if not isinstance(models, dict) or len(models) == 0:
            raise HTTPException(status_code=400, detail="Список моделей не может быть пустым.")
        normalized = {"models": models}
        self.repo.upsert_json(self.settings_key, normalized)
        return normalized
