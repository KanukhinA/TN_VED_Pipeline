"""
Контракт сквозной проверки декларации для интерфейса инспектора.

ValidateOfficerDeclarationUseCase делегирует LocalOfficerPipelineRunner (routes_officer_pipeline):
извлечение признаков, валидация по схеме справочника, правило-ориентированная и семантическая
классификация в составе оркестратора.
"""

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

