from __future__ import annotations

import json
import asyncio
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app import main as orchestrator_main  # noqa: E402


class _FakeResponse:
    def __init__(self, status_code: int, data: Any) -> None:
        self.status_code = status_code
        self._data = data
        self.text = json.dumps(data, ensure_ascii=False)
        self.request = httpx.Request("POST", "http://test")

    def json(self) -> Any:
        return self._data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("http error", request=self.request, response=httpx.Response(self.status_code, text=self.text))


class _FakeAsyncClient:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None

    async def get(self, url: str, timeout: float | None = None) -> _FakeResponse:
        if url.endswith("/api/rules/RULE-1/reference-examples"):
            return _FakeResponse(
                200,
                {
                    "examples": [
                        {"description_text": "Эталон A", "assigned_class_id": "CLASS-A"},
                        {"description_text": "Эталон B", "assigned_class_id": "CLASS-B"},
                    ]
                },
            )
        if url.endswith("/api/rules/RULE-1/semantic-threshold"):
            return _FakeResponse(200, {"source": "reference_examples", "threshold": 0.77})
        return _FakeResponse(404, {"detail": "not found"})

    async def post(self, url: str, json: dict[str, Any] | None = None, timeout: float | None = None) -> _FakeResponse:
        if url.endswith("/api/pipeline/officer-run"):
            return _FakeResponse(
                200,
                {
                    "final_class_id": None,
                    "catalog": {"rule_id": "RULE-1"},
                    "deterministic": {"validated_features": {"mass_fraction_n": 16.4}},
                    "catalog_classification_classes": [{"class_id": "CLASS-A", "title": "Class A"}],
                    "requires_expert_review": False,
                    "summary_ru": "ok",
                },
            )
        if url.endswith("/api/v1/search"):
            return _FakeResponse(200, {"matched": True, "similarity": 0.91, "class_id": "CLASS-A"})
        if url.endswith("/api/pipeline/semantic-class-consistency"):
            return _FakeResponse(200, {"consistent": True, "message_ru": None})
        if url.endswith("/api/v1/price/validate"):
            return _FakeResponse(200, {"status": "ok", "expected_average_price": 100.0})
        if url.endswith("/api/expert-decisions"):
            return _FakeResponse(200, {"status": "ok"})
        return _FakeResponse(404, {"detail": "not found"})


def test_run_validate_pipeline_stages_and_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(orchestrator_main.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setattr(orchestrator_main, "enqueue_cluster_job", lambda payload: 777)

    phases: list[str] = []
    partial_steps: list[str] = []

    async def on_phase(code: str, title: str, detail: str) -> None:
        phases.append(code)

    async def on_step(flow_state: dict[str, Any], step: str, result: Any) -> None:
        partial_steps.append(step)
        assert isinstance(flow_state.get("steps"), list)
        assert flow_state["steps"][-1]["step"] == step

    payload = orchestrator_main.ValidationRequest(
        declaration_id="OFFICER-1",
        description="Удобрение N16.4",
        tnved_code="31",
        gross_weight_kg=250.0,
        net_weight_kg=250.0,
        price=200000.0,
    )
    out = asyncio.run(orchestrator_main._run_validate_pipeline(payload, on_phase=on_phase, on_step=on_step))

    assert out["status"] == "completed"
    assert out["final_class"] == "CLASS-A"
    assert any(s["step"] == "semantic-search" for s in out["steps"])
    assert any(s["step"] == "semantic-class-rule-check" for s in out["steps"])
    assert any(s["step"] == "price-validator" for s in out["steps"])
    assert any(s["step"] == "enqueue-clustering-job" for s in out["steps"])

    assert phases == [
        "catalog",
        "semantic-search",
        "semantic-rule-check",
        "price-validation",
        "enqueue-clustering",
    ]
    assert partial_steps == [s["step"] for s in out["steps"]]


def test_validate_stream_emits_phase_partial_complete(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_run(payload: Any, on_phase: Any = None, on_step: Any = None) -> dict[str, Any]:
        if on_phase is not None:
            await on_phase("catalog", "Подбор справочника", "Начало")
        if on_step is not None:
            await on_step({"declaration_id": "OFFICER-2", "steps": []}, "officer-pipeline", {"status": "ok"})
        return {"declaration_id": "OFFICER-2", "status": "completed", "steps": [{"step": "officer-pipeline", "result": {"status": "ok"}}]}

    monkeypatch.setattr(orchestrator_main, "init_jobs_schema", lambda: None)
    monkeypatch.setattr(orchestrator_main, "_run_validate_pipeline", fake_run)

    client = TestClient(orchestrator_main.app)
    resp = client.post(
        "/api/v1/pipeline/validate/stream",
        json={
            "declaration_id": "OFFICER-2",
            "description": "text",
            "tnved_code": "31",
            "gross_weight_kg": 1.0,
            "net_weight_kg": 1.0,
            "price": 1.0,
        },
    )
    assert resp.status_code == 200
    events = [json.loads(line) for line in resp.text.splitlines() if line.strip()]
    kinds = [e.get("event") for e in events]
    assert "phase" in kinds
    assert "partial" in kinds
    assert kinds[-1] == "complete"
