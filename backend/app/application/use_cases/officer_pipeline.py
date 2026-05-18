"""Тонкая обёртка officer-пайплайна: делегирует реализацию из routes_officer_pipeline."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Protocol

from sqlalchemy.orm import Session


class OfficerPipelineRunnerPort(Protocol):
    """Порт оркестрации officer-сценария."""

    def run(self, payload: Any, db: Session) -> Dict[str, Any]:
        ...


@dataclass
class ValidateOfficerDeclarationUseCase:
    """
    Use-case слой для сценария проверки декларации инспектора.
    Бизнес-логика инкапсулирована в runner-порту и не завязана на FastAPI роут.
    """

    runner: OfficerPipelineRunnerPort

    def execute(self, payload: Any, db: Session) -> Dict[str, Any]:
        """Запускает сценарий проверки декларации через внедрённый порт."""
        return self.runner.run(payload, db)

