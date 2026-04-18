from __future__ import annotations

import json
import os
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import psycopg2

from app.pipeline_config import load_semantic_similarity_threshold

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
    extracted_features_override: Optional[dict[str, Any]] = None


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


async def _fetch_reference_examples_for_rule(
    client: httpx.AsyncClient, rule_id: str | None
) -> list[dict[str, str]]:
    if not rule_id:
        return []
    try:
        r = await client.get(
            f"{RULES_ENGINE_URL}/api/rules/{rule_id}/reference-examples",
            timeout=30.0,
        )
        r.raise_for_status()
        data = r.json()
        raw = data.get("examples") if isinstance(data, dict) else None
        if not isinstance(raw, list):
            return []
        out: list[dict[str, str]] = []
        for ex in raw:
            if not isinstance(ex, dict):
                continue
            out.append(
                {
                    "description_text": str(ex.get("description_text") or ""),
                    "assigned_class_id": str(ex.get("assigned_class_id") or ""),
                }
            )
        return out
    except Exception:
        return []


async def _effective_semantic_threshold(client: httpx.AsyncClient, rule_id: str | None) -> tuple[float, dict[str, Any]]:
    """Глобальный порог из pipeline; при наличии rule_id — калибровка по эталонам в БД."""
    base = load_semantic_similarity_threshold()
    if not rule_id:
        return base, {"source": "global", "rule_id": None}
    try:
        r = await client.get(
            f"{RULES_ENGINE_URL}/api/rules/{rule_id}/semantic-threshold",
            timeout=15.0,
        )
        r.raise_for_status()
        data = r.json()
        src = data.get("source")
        raw = data.get("threshold")
        if src == "reference_examples" and isinstance(raw, (int, float)):
            return float(raw), {"source": "reference_examples", "rule_id": rule_id, **data}
        return base, {"source": "global_fallback", "rule_id": rule_id, **data}
    except Exception as exc:
        return base, {"source": "global", "rule_id": rule_id, "error": str(exc)}


@app.post("/api/v1/pipeline/validate")
async def validate(payload: ValidationRequest) -> Any:
    """
    Блок 1 README: officer → при отсутствии класса — семантический поиск (Mod5) и SimCheck;
    при схожести ≤ порога — LLM-именование класса (Mod6), имя требует подтверждения эксперта.
    """
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
            catalog_classes = officer_json.get("catalog_classification_classes") or []
            requires_expert_review = bool(officer_json.get("requires_expert_review"))

            if requires_expert_review:
                flow["steps"].append(
                    {
                        "step": "expert-review-routing",
                        "result": {
                            "requires_expert_review": True,
                            "reason": "classification_exactly_one_conflict",
                            "explanation_ru": (
                                "Выявлен конфликт правил классификации в справочнике "
                                "(для exactly_one одновременно сработало несколько правил). "
                                "Декларация направлена на экспертное рассмотрение."
                            ),
                        },
                    }
                )
            elif not class_id:
                cat = officer_json.get("catalog")
                rule_id_from_catalog: str | None = None
                if isinstance(cat, dict):
                    raw_rid = cat.get("rule_id")
                    if raw_rid is not None and str(raw_rid).strip():
                        rule_id_from_catalog = str(raw_rid).strip()

                threshold, threshold_meta = await _effective_semantic_threshold(client, rule_id_from_catalog)
                flow["semantic_threshold_resolution"] = threshold_meta

                reference_examples = await _fetch_reference_examples_for_rule(client, rule_id_from_catalog)

                try:
                    ss = await client.post(
                        f"{SEMANTIC_SEARCH_URL}/api/v1/search",
                        json={
                            "description": payload.description,
                            "tnved_code": payload.tnved_code,
                            "similarity_threshold": threshold,
                            "rule_id": rule_id_from_catalog,
                            "reference_examples": reference_examples,
                        },
                    )
                    ss.raise_for_status()
                    ss_data = ss.json()
                except Exception as exc:
                    ss_data = {
                        "matched": False,
                        "similarity": 0.0,
                        "class_id": None,
                        "error": str(exc),
                        "service_mode": "error",
                    }

                sim = float(ss_data.get("similarity") or 0.0)
                matched = bool(ss_data.get("matched"))
                below_or_equal = sim <= threshold

                flow["steps"].append(
                    {
                        "step": "semantic-search",
                        "result": {
                            **ss_data,
                            "similarity_threshold": threshold,
                            "threshold_resolution": threshold_meta,
                            "reference_examples_submitted": len(reference_examples),
                            "below_threshold": below_or_equal,
                            "explanation_ru": (
                                "Схожесть выше порога и есть кандидат — класс можно взять из семантического поиска (после проверок)."
                                if not below_or_equal and matched and ss_data.get("class_id")
                                else "Схожесть не превышает порог или совпадения нет — по схеме запускается LLM-именование нового класса."
                            ),
                        },
                    }
                )

                if not below_or_equal and matched and ss_data.get("class_id"):
                    class_id = str(ss_data.get("class_id"))
                elif below_or_equal or not matched:
                    labels_payload: list[dict[str, str]] = []
                    if isinstance(catalog_classes, list):
                        for c in catalog_classes:
                            if not isinstance(c, dict):
                                continue
                            cid = str(c.get("class_id") or "").strip()
                            if not cid:
                                continue
                            labels_payload.append(
                                {"class_id": cid, "title": str(c.get("title") or "").strip()}
                            )
                    body_nm = {
                        "description": payload.description,
                        "tnved_code": payload.tnved_code,
                        "existing_classes": [x["class_id"] for x in labels_payload],
                        "existing_class_labels": labels_payload,
                    }
                    try:
                        nm = await client.post(
                            f"{LLM_GENERATOR_URL}/api/v1/suggest-class-name",
                            json=body_nm,
                        )
                        nm.raise_for_status()
                        nm_data = nm.json()
                    except Exception as exc:
                        nm_data = {
                            "suggested_class_name": "GENERATION_FAILED",
                            "mode": "error",
                            "error": str(exc),
                            "requires_expert_confirmation": True,
                        }
                    flow["steps"].append(
                        {
                            "step": "llm-class-name-suggestion",
                            "result": {
                                **nm_data,
                                "requires_expert_confirmation": True,
                                "explanation_ru": "Имя класса сгенерировано LLM и не применяется к декларации, пока эксперт не подтвердит его в интерфейсе.",
                            },
                        }
                    )

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
