from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional
import uuid

from sqlalchemy.orm.attributes import flag_modified

from ...db.models import ExpertDecisionItem
from ..ports.repositories import ExpertDecisionRepositoryPort


@dataclass
class CreateExpertDecisionCommand:
    """Команда создания записи экспертного решения."""

    category: str
    declaration_id: str
    summary_ru: str
    payload: Dict[str, Any]
    rule_id: Optional[str] = None


class CreateExpertDecisionUseCase:
    """Сценарий создания экспертной задачи с доменными инвариантами."""

    def __init__(self, repo: ExpertDecisionRepositoryPort) -> None:
        self._repo = repo

    @staticmethod
    def _parse_rule_id(raw: Optional[str]) -> Optional[uuid.UUID]:
        """Парсит rule_id из строки; пустое значение трактуется как None."""
        if raw and str(raw).strip():
            return uuid.UUID(str(raw).strip())
        return None

    @staticmethod
    def _merge_llm_naming_into_existing_payload(
        existing: ExpertDecisionItem,
        new_payload: Dict[str, Any],
    ) -> bool:
        """Дополняет pending-запись предложением модели, если в БД его ещё не было."""
        new_llm = new_payload.get("llm_result")
        if not isinstance(new_llm, dict):
            return False
        suggested = str(new_llm.get("suggested_class_name") or "").strip()
        if not suggested:
            return False
        payload = dict(existing.payload_json) if isinstance(existing.payload_json, dict) else {}
        llm_old = payload.get("llm_result")
        llm = dict(llm_old) if isinstance(llm_old, dict) else {}
        had_name = bool(str(llm.get("suggested_class_name") or "").strip())
        if not had_name:
            llm["suggested_class_name"] = suggested
        for key in ("prompt_includes", "mode", "requires_expert_confirmation"):
            if key in new_llm and key not in llm:
                llm[key] = new_llm[key]
        payload["llm_result"] = llm
        if new_payload.get("llm_naming_ran") is True:
            payload["llm_naming_ran"] = True
        if CreateExpertDecisionUseCase._meaningful_llm_class_name(payload):
            payload["naming_lane"] = "model"
        direct = str(new_payload.get("llm_naming_suggested_class") or "").strip()
        if direct and direct.upper() not in CreateExpertDecisionUseCase._MEANINGLESS_LLM_CLASS_NAMES:
            payload["llm_naming_suggested_class"] = direct
        elif suggested:
            payload["llm_naming_suggested_class"] = suggested
        existing.payload_json = payload
        flag_modified(existing, "payload_json")
        return not had_name or new_payload.get("llm_naming_ran") is True

    _MEANINGLESS_LLM_CLASS_NAMES = frozenset(
        {"CLASS", "GENERATION_FAILED", "-", "—", "N/A", "UNKNOWN", "EMPTY"}
    )

    @classmethod
    def _meaningful_llm_class_name(cls, payload: Dict[str, Any]) -> str:
        llm = payload.get("llm_result")
        if not isinstance(llm, dict):
            return ""
        suggested = str(llm.get("suggested_class_name") or "").strip()
        if not suggested or suggested.upper() in cls._MEANINGLESS_LLM_CLASS_NAMES:
            return ""
        return suggested

    def _ensure_class_name_confirmation_for_review(
        self,
        review_row: ExpertDecisionItem,
        payload: Dict[str, Any],
    ) -> None:
        """Парная задача: подтвердить имя класса, предложенное LLM (лента «модель» в UI)."""
        suggested = self._meaningful_llm_class_name(payload)
        if not suggested:
            return
        existing = self._repo.find_pending_by_category(
            category="class_name_confirmation",
            declaration_id=review_row.declaration_id,
            rule_id=review_row.rule_id,
        )
        if existing is not None:
            self._merge_llm_naming_into_existing_payload(existing, payload)
            return
        name_payload = dict(payload)
        name_payload.setdefault("source", "officer_validation")
        name_payload["linked_auto_classification_review_id"] = str(review_row.id)
        self._repo.add(
            ExpertDecisionItem(
                category="class_name_confirmation",
                rule_id=review_row.rule_id,
                declaration_id=review_row.declaration_id,
                status="pending",
                summary_ru=f"Подтвердить имя класса, предложенное моделью ({review_row.declaration_id})",
                payload_json=name_payload,
            )
        )

    @staticmethod
    def _is_auto_classification_failed(payload: Dict[str, Any]) -> bool:
        """Определяет, что автоклассификация не дала надёжный класс до решения инспектора."""
        status = str(payload.get("auto_classification_status") or "").strip().lower()
        if status == "failed":
            return True
        if bool(payload.get("semantic_rule_contradiction")):
            return True
        if bool(payload.get("semantic_candidate_no_class")):
            return True
        return str(payload.get("auto_class_before_decision") or "").strip() == ""

    def _ensure_auto_review_for_approved_officer_decision(self, row: ExpertDecisionItem) -> None:
        """Автосоздаёт задачу эксперту после `approved`, если авто-класс не получен."""
        payload = row.payload_json if isinstance(row.payload_json, dict) else {}
        if str(payload.get("final_decision") or "").strip().lower() != "approved":
            return
        if not self._is_auto_classification_failed(payload):
            return
        existing = self._repo.find_pending_by_category(
            category="auto_classification_review",
            declaration_id=row.declaration_id,
            rule_id=None,
        )
        if existing is not None:
            return
        reason_ru = str(payload.get("auto_classification_failure_reason_ru") or "").strip()
        if not reason_ru:
            reason_ru = "Инспектор принял декларацию, но автоклассификация не назначила класс."
        review_payload = dict(payload)
        review_payload["linked_officer_final_decision_id"] = str(row.id)
        review_payload["auto_classification_status"] = "failed"
        review_payload["auto_classification_failure_reason_ru"] = reason_ru
        self._repo.add(
            ExpertDecisionItem(
                category="auto_classification_review",
                rule_id=row.rule_id,
                declaration_id=row.declaration_id,
                status="pending",
                summary_ru=f"Требуется экспертная валидация автоклассификации ({row.declaration_id})",
                payload_json=review_payload,
            )
        )

    def execute(self, cmd: CreateExpertDecisionCommand) -> ExpertDecisionItem:
        """Создаёт pending-задачу, при необходимости переиспользуя существующую запись."""
        category = cmd.category.strip()
        declaration_id = cmd.declaration_id.strip()
        rid = self._parse_rule_id(cmd.rule_id)

        payload = dict(cmd.payload)
        if self._meaningful_llm_class_name(payload):
            payload["llm_naming_ran"] = True
            payload["naming_lane"] = "model"
            suggested = self._meaningful_llm_class_name(payload)
            payload.setdefault("llm_naming_suggested_class", suggested)

        if category in ("class_name_confirmation", "auto_classification_review"):
            existing = self._repo.find_pending_by_category(
                category=category,
                declaration_id=declaration_id,
                rule_id=rid,
            )
            if existing is not None:
                self._merge_llm_naming_into_existing_payload(existing, payload)
                if category == "auto_classification_review":
                    self._ensure_class_name_confirmation_for_review(existing, payload)
                return existing

        row = ExpertDecisionItem(
            category=category,
            rule_id=rid,
            declaration_id=declaration_id,
            status="pending",
            summary_ru=(cmd.summary_ru or "").strip(),
            payload_json=payload,
        )
        self._repo.add(row)
        if category == "auto_classification_review":
            self._ensure_class_name_confirmation_for_review(row, payload)
        if category == "officer_final_decision":
            self._ensure_auto_review_for_approved_officer_decision(row)
        return row

