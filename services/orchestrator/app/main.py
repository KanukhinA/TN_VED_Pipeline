from __future__ import annotations

import json
import os
import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
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


def _http_exception_detail(exc: HTTPException) -> str:
    d = exc.detail
    if isinstance(d, str):
        return d
    try:
        return json.dumps(d, ensure_ascii=False)
    except Exception:
        return str(d)


async def _run_validate_pipeline(
    payload: ValidationRequest,
    on_phase: Callable[[str, str, str], Awaitable[None]] | None = None,
    on_step: Callable[[dict[str, Any], str, Any], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    async def phase(code: str, title: str, detail: str) -> None:
        if on_phase is not None:
            await on_phase(code, title, detail)

    async def push_step(step: str, result: Any) -> None:
        flow["steps"].append({"step": step, "result": result})
        if on_step is not None:
            await on_step(flow, step, result)

    flow: dict[str, Any] = {"declaration_id": payload.declaration_id, "steps": []}
    class_id: str | None = None

    async with httpx.AsyncClient(timeout=900.0) as client:
        try:
            await phase("catalog", "Подбор справочника", "Запускаем officer-run и извлекаем признаки.")
            officer = await client.post(
                f"{RULES_ENGINE_URL}/api/pipeline/officer-run",
                json=payload.model_dump(),
            )
            officer.raise_for_status()
            officer_json = officer.json()
            await push_step("officer-pipeline", officer_json)

            class_id = officer_json.get("final_class_id")
            catalog_classes = officer_json.get("catalog_classification_classes") or []
            requires_expert_review = bool(officer_json.get("requires_expert_review"))

            if requires_expert_review:
                await phase("expert-routing", "Экспертная маршрутизация", "Требуется решение эксперта по классификации.")
                crev = officer_json.get("classification_expert_review") or (
                    (officer_json.get("deterministic") or {}).get("classification_expert_review")
                    if isinstance(officer_json.get("deterministic"), dict)
                    else None
                )
                kind = (crev or {}).get("kind") if isinstance(crev, dict) else None
                if kind == "none_match":
                    expl = (
                        "Ни одно правило классификации не подошло — запись попала в очередь «Решение спорных ситуаций»."
                    )
                elif kind == "ambiguous":
                    ids = (crev or {}).get("matched_class_ids") or []
                    expl = (
                        "Подошло несколько классов: "
                        + ", ".join(str(x) for x in ids)
                        + ". Нужно решение эксперта — запись в очереди «Решение спорных ситуаций»."
                    )
                else:
                    expl = (
                        "Требуется экспертное рассмотрение по классификации — см. страницу «Решение спорных ситуаций»."
                    )
                await push_step(
                    "expert-review-routing",
                    {
                        "requires_expert_review": True,
                        "reason": "classification_expert_review",
                        "classification_expert_review": crev,
                        "explanation_ru": expl,
                    },
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

                await phase("semantic-search", "Семантический fallback", "Ищем ближайший эталон по эмбеддингам.")
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

                await push_step(
                    "semantic-search",
                    {
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
                )

                if not below_or_equal and matched and ss_data.get("class_id"):
                    cand = str(ss_data.get("class_id"))
                    det = (
                        officer_json.get("deterministic")
                        if isinstance(officer_json.get("deterministic"), dict)
                        else None
                    )
                    vf = det.get("validated_features") if isinstance(det, dict) else None
                    if cand and rule_id_from_catalog and isinstance(vf, dict):
                        await phase("semantic-rule-check", "Проверка правила кандидата", "Проверяем RuleMatch2 для класса-кандидата.")
                        try:
                            chk = await client.post(
                                f"{RULES_ENGINE_URL}/api/pipeline/semantic-class-consistency",
                                json={
                                    "rule_id": rule_id_from_catalog,
                                    "class_id": cand,
                                    "validated_features": vf,
                                },
                                timeout=30.0,
                            )
                            chk.raise_for_status()
                            chk_data = chk.json()
                            await push_step("semantic-class-rule-check", chk_data)
                            if bool(chk_data.get("consistent")):
                                class_id = cand
                        except Exception as exc:
                            await push_step(
                                "semantic-class-rule-check",
                                {
                                    "consistent": True,
                                    "skipped": True,
                                    "error": str(exc),
                                },
                            )
                            class_id = cand
                    else:
                        class_id = cand

                if below_or_equal or not matched:
                    await phase("llm-naming", "LLM-именование класса", "Семантика не дала класс — генерируем новое имя класса.")
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
                    await push_step(
                        "llm-class-name-suggestion",
                        {
                            **nm_data,
                            "requires_expert_confirmation": True,
                            "explanation_ru": "Имя класса сгенерировано LLM и не применяется к декларации, пока эксперт не подтвердит его в интерфейсе.",
                        },
                    )
                    try:
                        cat = officer_json.get("catalog")
                        rid = None
                        if isinstance(cat, dict) and cat.get("rule_id") is not None:
                            rid = str(cat.get("rule_id")).strip() or None
                        sug = str(nm_data.get("suggested_class_name") or "").strip()
                        body_ed: dict[str, Any] = {
                            "category": "class_name_confirmation",
                            "declaration_id": payload.declaration_id,
                            "summary_ru": (
                                f"Подтвердите идентификатор класса для декларации {payload.declaration_id}: «{sug}»"
                            ),
                            "payload": {
                                "source": "orchestrator",
                                "step": "llm-class-name-suggestion",
                                "llm_result": nm_data,
                            },
                        }
                        if rid:
                            body_ed["rule_id"] = rid
                        pr_ed = await client.post(
                            f"{RULES_ENGINE_URL}/api/expert-decisions",
                            json=body_ed,
                            timeout=30.0,
                        )
                        pr_ed.raise_for_status()
                    except Exception:
                        pass

            await phase("price-validation", "Проверка стоимости", "Сравниваем заявленную стоимость с ориентировочной.")
            price = await client.post(
                f"{PRICE_VALIDATOR_URL}/api/v1/price/validate",
                json={
                    "declaration_id": payload.declaration_id,
                    "description": payload.description,
                    "class_id": class_id,
                    "declared_price": payload.price,
                    "gross_weight_kg": payload.gross_weight_kg,
                    "net_weight_kg": payload.net_weight_kg,
                },
            )
            price.raise_for_status()
            price_json = price.json()
            await push_step("price-validator", price_json)

            await phase("enqueue-clustering", "Фоновая кластеризация", "Ставим задачу кластеризации в очередь.")
            job_id = enqueue_cluster_job(
                {
                    "declaration_id": payload.declaration_id,
                    "description": payload.description,
                    "tnved_code": payload.tnved_code,
                    "final_class": class_id,
                }
            )
            await push_step("enqueue-clustering-job", {"job_id": job_id})
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


@app.post("/api/v1/pipeline/validate")
async def validate(payload: ValidationRequest) -> Any:
    return await _run_validate_pipeline(payload)


@app.post("/api/v1/pipeline/validate/stream")
async def validate_stream(payload: ValidationRequest) -> StreamingResponse:
    async def ndjson_bytes() -> AsyncIterator[bytes]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        await q.put(
            {
                "event": "phase",
                "code": "stream-start",
                "title": "Запуск валидации ДТ",
                "detail": "Оркестратор принял запрос и начинает выполнение этапов.",
            }
        )

        async def on_phase(code: str, title: str, detail: str) -> None:
            await q.put({"event": "phase", "code": code, "title": title, "detail": detail})

        async def on_step(flow_state: dict[str, Any], step: str, result: Any) -> None:
            await q.put(
                {
                    "event": "partial",
                    "step": step,
                    "result": {
                        "declaration_id": flow_state.get("declaration_id"),
                        "steps": list(flow_state.get("steps") or []),
                        "status": "running",
                    },
                }
            )

        async def runner() -> None:
            try:
                result = await _run_validate_pipeline(payload, on_phase=on_phase, on_step=on_step)
                await q.put({"event": "complete", "result": result})
            except HTTPException as he:
                await q.put(
                    {
                        "event": "error",
                        "status_code": int(he.status_code),
                        "message": _http_exception_detail(he),
                    }
                )
            except Exception as exc:
                await q.put({"event": "error", "status_code": 502, "message": str(exc)})

        task = asyncio.create_task(runner())
        try:
            while True:
                ev = await q.get()
                yield (json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8")
                if ev.get("event") in ("complete", "error"):
                    break
        finally:
            await task

    return StreamingResponse(ndjson_bytes(), media_type="application/x-ndjson")


@app.get("/api/v1/jobs/{job_id}")
def job_status(job_id: int) -> dict[str, Any]:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job
