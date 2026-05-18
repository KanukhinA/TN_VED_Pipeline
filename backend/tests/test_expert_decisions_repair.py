from __future__ import annotations

from app.application.use_cases.expert_decisions import CreateExpertDecisionUseCase


def test_meaningful_llm_class_name_from_payload():
    payload = {"llm_result": {"suggested_class_name": "Аммиачная селитра"}}
    assert CreateExpertDecisionUseCase._meaningful_llm_class_name(payload) == "Аммиачная селитра"


def test_meaningless_llm_class_name_ignored():
    payload = {"llm_result": {"suggested_class_name": "GENERATION_FAILED"}}
    assert CreateExpertDecisionUseCase._meaningful_llm_class_name(payload) == ""
