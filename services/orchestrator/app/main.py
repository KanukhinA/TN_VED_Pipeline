from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import psycopg2

PREPROCESSING_URL = os.getenv("PREPROCESSING_URL", "http://preprocessing:8004")
RULES_ENGINE_URL = os.getenv("RULES_ENGINE_URL", "http://backend:8000")
SEMANTIC_SEARCH_URL = os.getenv("SEMANTIC_SEARCH_URL", "http://semantic-search:8001")
LLM_GENERATOR_URL = os.getenv("LLM_GENERATOR_URL", "http://llm-naming:8002")
PRICE_VALIDATOR_URL = os.getenv("PRICE_VALIDATOR_URL", "http://price-validator:8006")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://rules_user:rules_pass@postgres:5432/rules")

app = FastAPI(title="Pipeline Orchestrator", version="0.1.0")


class ValidationRequest(BaseModel):
    declaration_id: str
    description: str
    tnved_code: str | None = None
    gross_weight_kg: float | None = None
    net_weight_kg: float | None = None
    price: float | None = None


def init_jobs_schema() -> None:
    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id BIGSERIAL PRIMARY KEY,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    payload JSONB NOT NULL,
                    result JSONB,
                    error TEXT,
                    worker_id TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    started_at TIMESTAMPTZ,
                    finished_at TIMESTAMPTZ
                );
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_jobs_status_created
                ON jobs (status, created_at);
                """
            )


def enqueue_cluster_job(payload: dict[str, Any]) -> int:
    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO jobs (kind, status, payload)
                VALUES (%s, 'queued', %s::jsonb)
                RETURNING id;
                """,
                ("clustering", json.dumps(payload, ensure_ascii=False)),
            )
            row = cur.fetchone()
            if row is None:
                raise RuntimeError("failed to enqueue job")
            return int(row[0])


def get_job(job_id: int) -> dict[str, Any] | None:
    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, kind, status, payload::text, result::text, error, worker_id, created_at, started_at, finished_at
                FROM jobs
                WHERE id = %s;
                """,
                (job_id,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            return {
                "id": int(row[0]),
                "kind": row[1],
                "status": row[2],
                "payload": json.loads(row[3]) if row[3] else None,
                "result": json.loads(row[4]) if row[4] else None,
                "error": row[5],
                "worker_id": row[6],
                "created_at": row[7].isoformat() if row[7] else None,
                "started_at": row[8].isoformat() if row[8] else None,
                "finished_at": row[9].isoformat() if row[9] else None,
            }


@app.on_event("startup")
def startup() -> None:
    init_jobs_schema()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "orchestrator"}


@app.post("/api/v1/pipeline/validate")
async def validate(payload: ValidationRequest) -> Any:
    flow: dict[str, Any] = {"declaration_id": payload.declaration_id, "steps": []}
    class_id: str | None = None

    async with httpx.AsyncClient(timeout=900.0) as client:
        try:
            officer = await client.post(
                f"{RULES_ENGINE_URL}/api/pipeline/officer-run",
                json=payload.model_dump(),
            )
            officer.raise_for_status()
            officer_json = officer.json()
            flow["steps"].append({"step": "officer-pipeline", "result": officer_json})

            class_id = officer_json.get("final_class_id")

            price = await client.post(
                f"{PRICE_VALIDATOR_URL}/api/v1/price/validate",
                json={
                    "declaration_id": payload.declaration_id,
                    "description": payload.description,
                    "class_id": class_id,
                    "declared_price": payload.price,
                },
            )
            price.raise_for_status()
            price_json = price.json()
            flow["steps"].append({"step": "price-validator", "result": price_json})

            job_id = enqueue_cluster_job(
                {
                    "declaration_id": payload.declaration_id,
                    "description": payload.description,
                    "tnved_code": payload.tnved_code,
                    "final_class": class_id,
                }
            )
            flow["steps"].append({"step": "enqueue-clustering-job", "result": {"job_id": job_id}})
        except httpx.HTTPStatusError as exc:
            sc = exc.response.status_code
            try:
                body = exc.response.json()
            except Exception:
                body = exc.response.text
            if isinstance(body, dict) and "detail" in body:
                detail: Any = body["detail"]
            else:
                detail = body
            if sc in (400, 404, 422, 502):
                raise HTTPException(status_code=sc, detail=detail) from exc
            raise HTTPException(status_code=502, detail=f"rules-engine error {sc}: {detail}") from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"pipeline dependency unavailable: {exc}") from exc

    flow["status"] = "completed"
    flow["summary_ru"] = flow["steps"][0]["result"].get("summary_ru") if flow["steps"] else None
    flow["final_class"] = class_id
    return flow


@app.get("/api/v1/jobs/{job_id}")
def job_status(job_id: int) -> dict[str, Any]:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job
