"""Разовое восстановление очереди подтверждения имён классов для legacy-записей."""

from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ...db.models import ExpertDecisionItem
from ..ports.repositories import ExpertDecisionRepositoryPort
from .expert_decisions import CreateExpertDecisionUseCase


class RepairLlmNamingExpertQueueUseCase:
    """Восстанавливает парные задачи подтверждения имени LLM для старых записей очереди."""

    _REVIEW_CATEGORIES = ("auto_classification_review", "classification_unresolved")

    def __init__(self, db: Session, repo: ExpertDecisionRepositoryPort) -> None:
        self._db = db
        self._repo = repo
        self._create = CreateExpertDecisionUseCase(repo)

    @staticmethod
    def _payload_dict(row: ExpertDecisionItem) -> Dict[str, Any]:
        return dict(row.payload_json) if isinstance(row.payload_json, dict) else {}

    def _officer_llm_from_linked(self, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        linked_raw = payload.get("linked_officer_final_decision_id")
        if not linked_raw:
            return None
        try:
            linked_id = uuid.UUID(str(linked_raw).strip())
        except ValueError:
            return None
        officer = self._repo.get(linked_id)
        if officer is None or officer.category != "officer_final_decision":
            return None
        officer_payload = self._payload_dict(officer)
        llm = officer_payload.get("llm_result")
        return llm if isinstance(llm, dict) else None

    def _officer_llm_by_declaration(self, declaration_id: str) -> Optional[Dict[str, Any]]:
        officer = (
            self._db.query(ExpertDecisionItem)
            .filter(
                ExpertDecisionItem.category == "officer_final_decision",
                ExpertDecisionItem.declaration_id == declaration_id,
            )
            .order_by(ExpertDecisionItem.created_at.desc())
            .first()
        )
        if officer is None:
            return None
        officer_payload = self._payload_dict(officer)
        llm = officer_payload.get("llm_result")
        return llm if isinstance(llm, dict) else None

    def _merge_llm_into_review_payload(self, row: ExpertDecisionItem, llm: Dict[str, Any]) -> bool:
        payload = self._payload_dict(row)
        if CreateExpertDecisionUseCase._meaningful_llm_class_name(payload):
            return False
        if not CreateExpertDecisionUseCase._meaningful_llm_class_name({"llm_result": llm}):
            return False
        payload["llm_result"] = dict(llm)
        suggested = str(llm.get("suggested_class_name") or "").strip()
        if suggested:
            payload["llm_naming_ran"] = True
            payload["llm_naming_suggested_class"] = suggested
        row.payload_json = payload
        flag_modified(row, "payload_json")
        return True

    def execute(self) -> Dict[str, int]:
        stats = {
            "review_rows_scanned": 0,
            "review_payload_enriched": 0,
            "class_name_confirmation_created": 0,
            "class_name_confirmation_already_pending": 0,
        }
        rows = (
            self._db.query(ExpertDecisionItem)
            .filter(
                ExpertDecisionItem.status == "pending",
                ExpertDecisionItem.category.in_(self._REVIEW_CATEGORIES),
            )
            .all()
        )
        for row in rows:
            stats["review_rows_scanned"] += 1
            payload = self._payload_dict(row)
            if not CreateExpertDecisionUseCase._meaningful_llm_class_name(payload):
                llm = self._officer_llm_from_linked(payload) or self._officer_llm_by_declaration(row.declaration_id)
                if llm and self._merge_llm_into_review_payload(row, llm):
                    stats["review_payload_enriched"] += 1
                    payload = self._payload_dict(row)

            suggested = CreateExpertDecisionUseCase._meaningful_llm_class_name(payload)
            if not suggested:
                continue

            before = self._repo.find_pending_by_category(
                category="class_name_confirmation",
                declaration_id=row.declaration_id,
                rule_id=row.rule_id,
            )
            self._create._ensure_class_name_confirmation_for_review(row, payload)
            after = self._repo.find_pending_by_category(
                category="class_name_confirmation",
                declaration_id=row.declaration_id,
                rule_id=row.rule_id,
            )
            if before is None and after is not None:
                stats["class_name_confirmation_created"] += 1
            elif before is not None or after is not None:
                stats["class_name_confirmation_already_pending"] += 1

        self._db.commit()
        return stats
