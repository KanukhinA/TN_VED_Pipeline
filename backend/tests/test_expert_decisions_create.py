from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest

from app.application.use_cases.expert_decisions import CreateExpertDecisionCommand, CreateExpertDecisionUseCase
from app.db.models import ExpertDecisionItem


class _FakeRepo:
    def __init__(self) -> None:
        self.rows: list[ExpertDecisionItem] = []
        self._pending: dict[tuple[str, str, uuid.UUID | None], ExpertDecisionItem] = {}

    def add(self, row: ExpertDecisionItem) -> None:
        self.rows.append(row)
        if row.status == "pending":
            self._pending[(row.category, row.declaration_id, row.rule_id)] = row

    def find_pending_by_category(
        self,
        *,
        category: str,
        declaration_id: str,
        rule_id: uuid.UUID | None,
    ) -> ExpertDecisionItem | None:
        return self._pending.get((category, declaration_id, rule_id))

    def get(self, _id: uuid.UUID) -> ExpertDecisionItem | None:
        for r in self.rows:
            if r.id == _id:
                return r
        return None


@pytest.fixture
def use_case() -> tuple[CreateExpertDecisionUseCase, _FakeRepo]:
    repo = _FakeRepo()
    return CreateExpertDecisionUseCase(repo), repo


def test_create_auto_review_sets_naming_lane_and_class_confirmation(use_case):
    uc, repo = use_case
    rid = uuid.uuid4()
    payload = {
        "llm_naming_ran": True,
        "llm_result": {"suggested_class_name": "сульфат_бора"},
        "auto_classification_status": "failed",
    }
    row = uc.execute(
        CreateExpertDecisionCommand(
            category="auto_classification_review",
            declaration_id="DT-1",
            summary_ru="review",
            payload=payload,
            rule_id=str(rid),
        )
    )
    assert row.payload_json.get("naming_lane") == "model"
    categories = [r.category for r in repo.rows]
    assert "auto_classification_review" in categories
    assert "class_name_confirmation" in categories


def test_merge_existing_auto_review_creates_class_confirmation(use_case):
    uc, repo = use_case
    rid = uuid.uuid4()
    existing = ExpertDecisionItem(
        category="auto_classification_review",
        rule_id=rid,
        declaration_id="DT-2",
        status="pending",
        summary_ru="old",
        payload_json={"auto_classification_status": "failed"},
    )
    repo.add(existing)

    uc.execute(
        CreateExpertDecisionCommand(
            category="auto_classification_review",
            declaration_id="DT-2",
            summary_ru="new",
            payload={
                "llm_naming_ran": True,
                "llm_result": {"suggested_class_name": "сульфат_бора"},
            },
            rule_id=str(rid),
        )
    )
    assert existing.payload_json.get("naming_lane") == "model"
    assert CreateExpertDecisionUseCase._meaningful_llm_class_name(existing.payload_json) == "сульфат_бора"
    confirm = [r for r in repo.rows if r.category == "class_name_confirmation"]
    assert len(confirm) == 1
    assert confirm[0].declaration_id == "DT-2"
