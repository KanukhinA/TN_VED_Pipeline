from __future__ import annotations

import json
import os
import random
import re
import threading
import time
import asyncio
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Optional

from app.pipeline_config import (
    CODE_DEFAULT as PIPELINE_CODE_DEFAULT,
    effective_pipeline_params,
    load_pipeline_file,
    pipeline_config_path,
    save_pipeline_file,
)
from app.prompt_generator_config import (
    CODE_DEFAULT as PROMPT_GENERATOR_CODE_DEFAULT,
    effective_prompt_generator_params,
    load_prompt_generator_file,
    prompt_generator_config_path,
)

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

ORCHESTRATOR_URL = os.getenv("ORCHESTRATOR_URL", "http://orchestrator:8003")
RULES_ENGINE_URL = os.getenv("RULES_ENGINE_URL", "http://backend:8000")
PREPROCESSING_URL = os.getenv("PREPROCESSING_URL", "http://preprocessing:8004")
LLM_HTTP_TIMEOUT = float(os.getenv("LLM_HTTP_TIMEOUT", "900"))
SEMANTIC_SEARCH_URL = os.getenv("SEMANTIC_SEARCH_URL", "http://semantic-search:8001")
LLM_GENERATOR_URL = os.getenv("LLM_GENERATOR_URL", "http://llm-naming:8002")
PRICE_VALIDATOR_URL = os.getenv("PRICE_VALIDATOR_URL", "http://price-validator:8006")
CLUSTERING_SERVICE_URL = os.getenv("CLUSTERING_SERVICE_URL", "http://clustering-service:8007")
# Большие списки: верхняя граница и размер чанка для вызовов clustering-service (тело JSON / память).
FEW_SHOT_TEXT_ABS_CAP = int(os.getenv("FEW_SHOT_TEXT_ABS_CAP", "20000"))
CLUSTERING_CHUNK_SIZE = int(os.getenv("FEW_SHOT_CLUSTERING_CHUNK_SIZE", "400"))
MODEL_OP_HISTORY_MAX = max(50, int(os.getenv("MODEL_OP_HISTORY_MAX", "400")))

app = FastAPI(title="API Gateway", version="0.1.0")
RETRY_ATTEMPTS = 3
RETRY_BASE_DELAY_SECONDS = 0.35

_model_op_lock = threading.Lock()
_model_op_history: deque[dict[str, Any]] = deque(maxlen=MODEL_OP_HISTORY_MAX)
_model_last_running: set[str] | None = None
_model_runtime_last_error: str | None = None


def _utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_model_from_request_body(raw: bytes) -> str:
    if not raw:
        return ""
    try:
        j = json.loads(raw)
        if isinstance(j, dict):
            return str(j.get("model") or "").strip()
    except Exception:
        pass
    return ""


def _detail_from_error_json(body_bytes: bytes) -> str:
    try:
        j = json.loads(body_bytes)
        if isinstance(j, dict) and "detail" in j:
            d = j["detail"]
            if isinstance(d, str):
                return d[:4000]
            return json.dumps(d, ensure_ascii=False)[:4000]
    except Exception:
        pass
    return body_bytes.decode("utf-8", errors="replace")[:4000]


def _summarize_model_op_response(kind: str, status: int, body_bytes: bytes) -> str:
    """Краткое описание для журнала: ошибка HTTP или поля успешного ответа preprocessing."""
    if not body_bytes:
        return ""
    if status >= 400:
        return _detail_from_error_json(body_bytes)
    try:
        j = json.loads(body_bytes)
    except Exception:
        return body_bytes.decode("utf-8", errors="replace")[:1200]
    if not isinstance(j, dict):
        return ""
    if kind == "deploy":
        parts: list[str] = []
        if j.get("duration_sec") is not None:
            parts.append(f"duration_sec={j['duration_sec']}")
        if j.get("pulled"):
            parts.append("pulled=true")
        wl = j.get("warm_load")
        if isinstance(wl, dict) and wl.get("error"):
            parts.append(f"warm_error={str(wl['error'])[:400]}")
        return "; ".join(parts) if parts else "ok"
    if kind in ("pause", "delete"):
        return "ok"
    return ""


def _record_model_operation(
    kind: str,
    model: str,
    *,
    ok: bool,
    http_status: int,
    detail: str = "",
) -> None:
    ev: dict[str, Any] = {
        "ts_iso": _utc_iso(),
        "kind": kind,
        "model": model or "(unknown)",
        "ok": ok,
        "http_status": http_status,
        "detail": (detail or "")[:4000],
    }
    with _model_op_lock:
        _model_op_history.append(ev)


async def _probe_and_record_model_runtime_state() -> None:
    """
    Снимок состояния рантайма моделей:
    - runtime-start: модель появилась в running_models
    - runtime-stop: модель исчезла из running_models
    - runtime-error: опрос /models/running неуспешен
    """
    global _model_last_running, _model_runtime_last_error
    now = _utc_iso()
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(f"{PREPROCESSING_URL}/api/v1/models/running")
        if resp.status_code >= 400:
            msg = f"HTTP {resp.status_code}: {resp.text[:500]}"
            with _model_op_lock:
                if _model_runtime_last_error != msg:
                    _model_op_history.append(
                        {
                            "ts_iso": now,
                            "kind": "runtime-error",
                            "model": "(runtime)",
                            "ok": False,
                            "http_status": resp.status_code,
                            "detail": msg,
                        }
                    )
                    _model_runtime_last_error = msg
            return
        body = resp.json()
        running = {
            str(x).strip()
            for x in (body.get("running_models") or [])
            if str(x).strip()
        }
    except Exception as exc:
        msg = str(exc)[:500]
        with _model_op_lock:
            if _model_runtime_last_error != msg:
                _model_op_history.append(
                    {
                        "ts_iso": now,
                        "kind": "runtime-error",
                        "model": "(runtime)",
                        "ok": False,
                        "http_status": 502,
                        "detail": msg,
                    }
                )
                _model_runtime_last_error = msg
        return

    with _model_op_lock:
        prev = set(_model_last_running or set())
        started = sorted(running - prev)
        stopped = sorted(prev - running)
        for m in started:
            _model_op_history.append(
                {
                    "ts_iso": now,
                    "kind": "runtime-start",
                    "model": m,
                    "ok": True,
                    "http_status": 200,
                    "detail": "Модель появилась в running_models",
                }
            )
        for m in stopped:
            _model_op_history.append(
                {
                    "ts_iso": now,
                    "kind": "runtime-stop",
                    "model": m,
                    "ok": False,
                    "http_status": 200,
                    "detail": "Модель исчезла из running_models (возможное падение/остановка)",
                }
            )
        _model_last_running = running
        _model_runtime_last_error = None


def effective_extraction_runtime(runtime: dict[str, Any] | None) -> dict[str, Any]:
    """Согласованность с фронтом: constrained decoding только через use_guidance; при нём structured_output=True."""
    r = dict(runtime or {})
    legacy = bool(r.pop("use_outlines", False)) or bool(r.pop("pydantic_outlines", False))
    ug = bool(r.get("use_guidance", False)) or legacy
    so = bool(r.get("structured_output", True))
    if ug:
        so = True
    out = {
        **r,
        "structured_output": so,
        "use_guidance": ug,
    }
    return out


class ValidationRequest(BaseModel):
    declaration_id: str
    description: str
    tnved_code: str | None = None
    gross_weight_kg: float | None = None
    net_weight_kg: float | None = None
    price: float | None = None
    extracted_features_override: dict[str, Any] | None = None


class FeatureExtractionTestRequest(BaseModel):
    model: str = ""
    prompt: str = ""
    sample_text: str = ""
    runtime: dict[str, Any] | None = None
    rules_preview: str | None = None
    raw_llm_output: str | None = None
    ollama: dict[str, Any] | None = None


class FewShotAssistRequest(BaseModel):
    """Отбор кандидатов для few-shot по метрикам из few_shot_extractor.py."""

    model: str = ""
    prompt: str = ""
    rules_preview: str | None = None
    unlabeled_texts: list[str] = Field(default_factory=list)
    labeled_texts: list[str] | None = None
    k: int = 3
    temperature: float = 0.7
    top_p: float = 0.95
    alpha: float = 0.33
    beta: float = 0.33
    gamma: float = 0.34
    num_ctx: int = 8192
    max_new_tokens: int = 3904
    repetition_penalty: float = 1.0
    max_candidates: int = 10
    enable_thinking: bool = False
    top_n: int = 15
    candidate_strategy: str = "simple"
    n_clusters: int = 100
    outlier_k: int = 20
    outlier_percentile: float | None = 95.0
    rule_id: str | None = Field(
        default=None,
        description="UUID справочника: при фоновом запуске задача привязана к каталогу (восстановление после F5).",
    )


class GenerateExtractionPromptRequest(BaseModel):
    """
    Один вызов LLM: по мета-промпту сгенерировать системный промпт извлечения признаков.

    Параметры Ollama (num_ctx, temperature, …) по умолчанию берутся из JSON config/prompt_generator.json
    (или PROMPT_GENERATOR_CONFIG_PATH) и перечитываются на каждый запрос.
    Поля ниже — необязательные переопределения из тела запроса (если ключ передан).
    """

    model: str = ""
    prompt: str = ""
    num_ctx: Optional[int] = None
    max_new_tokens: Optional[int] = None
    repetition_penalty: Optional[float] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    enable_thinking: Optional[bool] = None


async def request_with_retry(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    retries: int = RETRY_ATTEMPTS,
    retry_base_delay: float = RETRY_BASE_DELAY_SECONDS,
    **kwargs: Any,
) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            resp = await client.request(method, url, **kwargs)
            # Повторяем только временные ошибки.
            if resp.status_code >= 500 and attempt < retries - 1:
                await asyncio.sleep(retry_base_delay * (2**attempt))
                continue
            return resp
        except Exception as exc:
            last_error = exc
            if attempt < retries - 1:
                await asyncio.sleep(retry_base_delay * (2**attempt))
                continue
            break
    raise RuntimeError(f"request failed after {retries} attempts: {last_error}")


async def _clustering_select_candidates(
    client: httpx.AsyncClient,
    *,
    filtered_lines: list[str],
    n_clusters: int,
    max_candidates: int,
) -> tuple[list[str], dict[str, int], str | None]:
    """Один или несколько POST в clustering-service, если неразмеченных строк много."""
    lines = list(filtered_lines)
    if len(lines) > FEW_SHOT_TEXT_ABS_CAP:
        lines = random.sample(lines, FEW_SHOT_TEXT_ABS_CAP)

    chunk_sz = max(50, CLUSTERING_CHUNK_SIZE)
    nc_cap = max(1, min(int(n_clusters), 200))

    async def one_chunk(part: list[str]) -> tuple[list[str], dict[str, int], str | None]:
        nc = max(1, min(nc_cap, len(part)))
        mc = max(1, min(max_candidates, len(part)))
        req_body = {"texts": part, "n_clusters": nc, "max_candidates": mc}
        cluster_resp = await request_with_retry(
            client,
            "POST",
            f"{CLUSTERING_SERVICE_URL}/api/v1/clustering/select-candidates",
            json=req_body,
            timeout=120.0,
        )
        cluster_resp.raise_for_status()
        cluster_data = cluster_resp.json() if cluster_resp.content else {}
        emb = (
            str(cluster_data.get("embedding_model")).strip()
            if cluster_data.get("embedding_model") is not None
            else None
        )
        raw_c = cluster_data.get("candidates")
        cand_list = [str(x).strip() for x in (raw_c or []) if str(x).strip()]
        cmap_raw = cluster_data.get("cluster_by_text")
        cbt = {str(k): int(v) for k, v in (cmap_raw or {}).items() if str(k).strip()}
        return cand_list, cbt, emb

    if len(lines) <= chunk_sz:
        cands, cbt, emb = await one_chunk(lines)
        if not cands:
            cands = lines[:max_candidates]
        elif len(cands) > max_candidates:
            cands = cands[:max_candidates]
        return cands, cbt, emb

    seen: set[str] = set()
    merged: list[str] = []
    cluster_by_text: dict[str, int] = {}
    emb_model: str | None = None
    for i in range(0, len(lines), chunk_sz):
        part = lines[i : i + chunk_sz]
        cands, cbt, emb = await one_chunk(part)
        if emb_model is None and emb:
            emb_model = emb
        for t in cands:
            if not t or t in seen:
                continue
            seen.add(t)
            merged.append(t)
            if t in cbt:
                cluster_by_text[t] = cbt[t]
        if len(merged) >= max_candidates:
            break
    if not merged:
        merged = lines[:max_candidates]
    elif len(merged) > max_candidates:
        merged = merged[:max_candidates]
    return merged, cluster_by_text, emb_model


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "api-gateway"}


@app.get("/ready")
async def ready() -> dict[str, Any]:
    deps: dict[str, str] = {}
    async with httpx.AsyncClient(timeout=3.0) as client:
        for name, base_url in {
            "orchestrator": ORCHESTRATOR_URL,
            "rules-engine": RULES_ENGINE_URL,
            "preprocessing": PREPROCESSING_URL,
            "semantic-search": SEMANTIC_SEARCH_URL,
            "llm-generator": LLM_GENERATOR_URL,
            "price-validator": PRICE_VALIDATOR_URL,
            "clustering-service": CLUSTERING_SERVICE_URL,
        }.items():
            try:
                resp = await client.get(f"{base_url}/health")
                deps[name] = "ok" if resp.status_code == 200 else "down"
            except Exception:
                deps[name] = "down"
    status = "ok" if all(v == "ok" for v in deps.values()) else "degraded"
    return {"status": status, "service": "api-gateway", "dependencies": deps}


@app.get("/api/validate/preflight")
async def validate_preflight() -> dict[str, Any]:
    """
    Проверка доступности подмодулей для сценария инспектора до запуска /api/validate.
    Если есть недоступные зависимости — фронт не должен стартовать обработку.
    """
    deps: dict[str, str] = {}
    targets = {
        "orchestrator": ORCHESTRATOR_URL,
        "rules-engine": RULES_ENGINE_URL,
        "preprocessing": PREPROCESSING_URL,
        "semantic-search": SEMANTIC_SEARCH_URL,
        "llm-generator": LLM_GENERATOR_URL,
        "price-validator": PRICE_VALIDATOR_URL,
    }
    async with httpx.AsyncClient(timeout=3.0) as client:
        for name, base_url in targets.items():
            try:
                resp = await client.get(f"{base_url}/health")
                deps[name] = "ok" if resp.status_code == 200 else "down"
            except Exception:
                deps[name] = "down"
    down = [k for k, v in deps.items() if v != "ok"]
    return {
        "status": "ok" if not down else "degraded",
        "service": "api-gateway",
        "profile": "officer-validation",
        "dependencies": deps,
        "down_dependencies": down,
    }


def _build_feature_extraction_prompt(payload: FeatureExtractionTestRequest) -> str:
    parts: list[str] = []
    rp = (payload.rules_preview or "").strip()
    if rp:
        parts.append(rp)
    pr = (payload.prompt or "").strip()
    if pr:
        parts.append(pr)
    st = (payload.sample_text or "").strip()
    if st:
        parts.append("Текст для извлечения:\n" + st)
    return "\n\n".join(parts)


def _assemble_extraction_prompt(*, rules_preview: str | None, prompt: str, sample_text: str) -> str:
    parts: list[str] = []
    rp = (rules_preview or "").strip()
    if rp:
        parts.append(rp)
    pr = (prompt or "").strip()
    if pr:
        parts.append(pr)
    st = (sample_text or "").strip()
    if st:
        parts.append("Текст для извлечения:\n" + st)
    return "\n\n".join(parts)


async def _require_model_running_for_prompt_test(model_name: str) -> None:
    """
    Тест промпта не должен сам поднимать модель (pull/load) — только вызов при уже запущенной
    через админку deploy. Проверяем список running у preprocessing; при недоступности API — пропускаем проверку.
    """
    m = (model_name or "").strip()
    if not m:
        return
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await request_with_retry(client, "GET", f"{PREPROCESSING_URL}/api/v1/models/running")
            if resp.status_code != 200:
                return
            data = resp.json()
            running = [str(x).strip() for x in (data.get("running_models") or [])]
            if m not in running:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Модель не в списке запущенных на сервере. Запустите её в разделе администрирования моделей; "
                        "тест промпта не управляет запуском и остановкой."
                    ),
                )
    except HTTPException:
        raise
    except Exception:
        return


@app.post("/api/feature-extraction/test")
async def test_feature_extraction(payload: FeatureExtractionTestRequest) -> dict[str, Any]:
    from app.json_recovery import extract_json_from_response, parse_json_from_model_response

    can_gen = bool((payload.prompt or "").strip() and (payload.sample_text or "").strip())
    can_parse = bool((payload.raw_llm_output or "").strip())
    if not can_gen and not can_parse:
        raise HTTPException(
            status_code=400,
            detail="Нужны промпт и текст для вызова модели или сырой ответ",
        )

    eff = effective_extraction_runtime(payload.runtime)
    assembled_for_ollama = _build_feature_extraction_prompt(payload)
    out: dict[str, Any] = {
        "status": "ok",
        "model": payload.model,
        # Только пользовательский промпт из тела запроса (без rules_preview и без блока «Текст для извлечения»).
        "prompt_preview": (payload.prompt or "")[:500],
        "sample_preview": (payload.sample_text or "")[:500],
        "runtime": payload.runtime or {},
        "effective_runtime": eff,
        "rules_preview_excerpt": (payload.rules_preview or "")[:500],
        # Фактическая строка, уходящая в Ollama: rules + prompt + подписанный образец (см. _build_feature_extraction_prompt).
        "assembled_prompt_preview": assembled_for_ollama[:4000],
    }

    want_generate = bool((payload.prompt or "").strip() and (payload.sample_text or "").strip())
    raw = (payload.raw_llm_output or "").strip()

    if want_generate:
        oo = payload.ollama or {}
        body = {
            "model": (payload.model or oo.get("model") or "").strip(),
            "prompt": assembled_for_ollama,
            "num_ctx": int(oo.get("num_ctx", 8192)),
            "max_new_tokens": int(oo.get("max_new_tokens", 3904)),
            "repetition_penalty": float(oo.get("repetition_penalty", 1.0)),
            "temperature": 0.0,
            "enable_thinking": bool(oo.get("enable_thinking", False)),
        }
        if not body["model"]:
            raise HTTPException(status_code=400, detail="model is required for Ollama generate")

        await _require_model_running_for_prompt_test(body["model"])

        t_extract0 = time.perf_counter()
        async with httpx.AsyncClient(timeout=LLM_HTTP_TIMEOUT) as client:
            try:
                resp = await request_with_retry(
                    client,
                    "POST",
                    f"{PREPROCESSING_URL}/api/v1/ollama/generate",
                    json=body,
                    timeout=LLM_HTTP_TIMEOUT,
                )
                resp.raise_for_status()
                gen = resp.json()
            except httpx.HTTPStatusError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"preprocessing/ollama: {exc.response.text[:800]}",
                ) from exc
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"preprocessing: {exc}") from exc

        out["extraction_request_duration_sec"] = round(time.perf_counter() - t_extract0, 3)
        td_ns = gen.get("total_duration_ns")
        if td_ns is not None:
            try:
                out["ollama_compute_duration_sec"] = round(float(td_ns) / 1e9, 4)
            except (TypeError, ValueError):
                pass

        llm_text = (gen.get("raw_response") or "").strip()
        out["mode"] = "ollama"
        out["ollama"] = {k: v for k, v in gen.items() if k != "raw_response"}
        out["llm_raw"] = llm_text[:20000]
        out["parsed_from_model"] = parse_json_from_model_response(llm_text)
        out["json_recovery"] = {
            "extracted_fragment_preview": extract_json_from_response(llm_text)[:1200],
            "parsed": out["parsed_from_model"],
            "non_empty": bool(out["parsed_from_model"]),
        }

    if raw:
        t_parse0 = time.perf_counter()
        fragment = extract_json_from_response(raw)
        parsed_raw = parse_json_from_model_response(raw)
        out["parsed_from_raw_input"] = parsed_raw
        if not want_generate:
            out["mode"] = "parse_only"
            out["parse_only_duration_sec"] = round(time.perf_counter() - t_parse0, 4)
            out["json_recovery"] = {
                "extracted_fragment_preview": fragment[:800],
                "parsed": parsed_raw,
                "non_empty": bool(parsed_raw),
            }
            number_matches = re.findall(r"\d+(?:[.,]\d+)?", raw)
            out["extracted_numbers_fallback"] = [float(v.replace(",", ".")) for v in number_matches[:20]]

    return out


def _http_exception_detail(exc: HTTPException) -> str:
    d = exc.detail
    if isinstance(d, str):
        return d
    try:
        return json.dumps(d, ensure_ascii=False)
    except Exception:
        return str(d)


FewShotProgressEmit = Optional[Callable[[dict[str, Any]], Awaitable[None]]]


async def _execute_few_shot_assist(
    payload: FewShotAssistRequest,
    *,
    emit: FewShotProgressEmit = None,
) -> dict[str, Any]:
    """
    Несколько запусков модели с sampling (temperature) на каждый текст, затем метрики
    Generation / Format / Content uncertainty и итог 𝒰 = α·𝒰_d + β·𝒰_f + γ·𝒰_c.
    emit — опционально: события прогресса для NDJSON-стрима.
    """
    from app.few_shot_uncertainty import (
        best_json_fragment_from_responses,
        calculate_content_uncertainty,
        calculate_format_uncertainty,
        calculate_generation_disagreement,
        detect_outliers_jaccard_knn,
    )

    if not (payload.prompt or "").strip():
        raise HTTPException(status_code=400, detail="Задайте промпт конфигурации")
    raw_lines = [t.strip() for t in (payload.unlabeled_texts or []) if isinstance(t, str) and t.strip()]
    if not raw_lines:
        raise HTTPException(status_code=400, detail="Добавьте хотя бы один неразмеченный текст (по строке)")

    labeled_set = set()
    if payload.labeled_texts:
        labeled_set = {t.strip() for t in payload.labeled_texts if isinstance(t, str) and t.strip()}

    filtered_lines = [t for t in raw_lines if t not in labeled_set]
    strategy = str(payload.candidate_strategy or "simple").strip().lower()

    max_candidates = max(1, min(payload.max_candidates, 500))
    cluster_by_text: dict[str, int] = {}
    clustering_embedding_model: str | None = None
    if strategy == "few_shot_extractor":
        if emit:
            await emit(
                {
                    "event": "phase",
                    "phase": "clustering",
                    "message": "Кластеризация и отбор кандидатов (embedding + k-means)…",
                }
            )
        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                candidates, cluster_by_text, clustering_embedding_model = await _clustering_select_candidates(
                    client,
                    filtered_lines=filtered_lines,
                    n_clusters=int(payload.n_clusters),
                    max_candidates=max_candidates,
                )
            except httpx.HTTPStatusError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"clustering-service: {exc.response.text[:800]}",
                ) from exc
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"clustering-service: {exc}") from exc
        if not candidates:
            candidates = filtered_lines[:max_candidates]
    else:
        candidates = filtered_lines[:max_candidates]

    if not candidates:
        raise HTTPException(
            status_code=400,
            detail="После исключения совпадений с размеченными строками не осталось текстов",
        )

    k = max(2, min(int(payload.k), 8))
    if len(candidates) * k > 600:
        raise HTTPException(
            status_code=400,
            detail="Слишком много вызовов модели: уменьшите число строк для анализа (лимит 600 вызовов: кандидаты × k)",
        )

    model = (payload.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="Укажите model (тег Ollama)")

    await _require_model_running_for_prompt_test(model)

    n_cand = len(candidates)
    total_llm = n_cand * k
    if emit:
        await emit(
            {
                "event": "phase",
                "phase": "evaluating",
                "candidates_total": n_cand,
                "llm_calls_total": total_llm,
                "k": k,
                "message": f"Опрос модели: {n_cand} кандидатов × {k} вариантов = {total_llm} вызовов к Ollama",
            }
        )

    top_n = max(1, min(int(payload.top_n), 50))
    results: list[dict[str, Any]] = []

    llm_done = 0
    cand_pos = 0
    async with httpx.AsyncClient(timeout=LLM_HTTP_TIMEOUT) as client:
        for text in candidates:
            cand_pos += 1
            responses: list[str] = []
            assembled = _assemble_extraction_prompt(
                rules_preview=payload.rules_preview,
                prompt=payload.prompt,
                sample_text=text,
            )
            for variant in range(k):
                body = {
                    "model": model,
                    "prompt": assembled,
                    "num_ctx": int(payload.num_ctx),
                    "max_new_tokens": int(payload.max_new_tokens),
                    "repetition_penalty": float(payload.repetition_penalty),
                    "temperature": float(payload.temperature),
                    "top_p": float(payload.top_p),
                    "enable_thinking": bool(payload.enable_thinking),
                }
                try:
                    resp = await request_with_retry(
                        client,
                        "POST",
                        f"{PREPROCESSING_URL}/api/v1/ollama/generate",
                        json=body,
                        timeout=LLM_HTTP_TIMEOUT,
                    )
                    resp.raise_for_status()
                    gen = resp.json()
                    responses.append(str(gen.get("raw_response") or "").strip())
                except httpx.HTTPStatusError as exc:
                    raise HTTPException(
                        status_code=502,
                        detail=f"preprocessing/ollama: {exc.response.text[:800]}",
                    ) from exc
                except Exception as exc:
                    raise HTTPException(status_code=502, detail=f"preprocessing: {exc}") from exc

                llm_done += 1
                if emit:
                    await emit(
                        {
                            "event": "progress",
                            "phase": "evaluating",
                            "candidate_index": cand_pos,
                            "candidates_total": n_cand,
                            "variant_index": variant + 1,
                            "k": k,
                            "llm_calls_done": llm_done,
                            "llm_calls_total": total_llm,
                            "message": (
                                f"Кандидат {cand_pos}/{n_cand}: вариант ответа {variant + 1}/{k} "
                                f"(всего вызовов {llm_done}/{total_llm})"
                            ),
                        }
                    )

            gen_d = calculate_generation_disagreement(responses)
            r_fail, struct_d = calculate_format_uncertainty(responses)
            format_u = (r_fail + struct_d) / 2.0
            content_u = calculate_content_uncertainty(responses)
            total = (
                float(payload.alpha) * gen_d
                + float(payload.beta) * format_u
                + float(payload.gamma) * content_u
            )
            best_json = best_json_fragment_from_responses(responses)

            results.append(
                {
                    "text": text,
                    "cluster": cluster_by_text.get(text),
                    "total_uncertainty": round(total, 6),
                    "generation_disagreement": round(gen_d, 6),
                    "format_uncertainty": round(format_u, 6),
                    "R_fail": round(r_fail, 6),
                    "structural_disagreement": round(struct_d, 6),
                    "content_uncertainty": round(content_u, 6),
                    "best_json_fragment": best_json[:12000] if best_json else "",
                    "responses_preview": [r[:2000] for r in responses],
                }
            )

    if emit:
        await emit(
            {
                "event": "phase",
                "phase": "ranking",
                "message": "Ранжирование по неопределённости и отбор top-N…",
            }
        )

    n_evaluated = len(results)
    outlier_enabled = payload.outlier_percentile is not None
    if outlier_enabled and n_evaluated >= 2:
        outlier_flags, outlier_scores = detect_outliers_jaccard_knn(
            [str(r.get("text") or "") for r in results],
            k=max(1, min(int(payload.outlier_k), 50)),
            percentile=float(payload.outlier_percentile),
        )
        for idx, row in enumerate(results):
            row["is_outlier"] = bool(outlier_flags[idx])
            row["outlier_score"] = round(float(outlier_scores[idx]), 6)
    else:
        for row in results:
            row["is_outlier"] = False
            row["outlier_score"] = 0.0

    results.sort(key=lambda x: x["total_uncertainty"], reverse=True)
    results = results[:top_n]

    return {
        "status": "ok",
        "algorithm": "dual_level_introspective_uncertainty",
        "reference": "github.com/KanukhinA/LLM_QuantityExtractor_Evaluator few_shot_extractor.py",
        "k_variants": k,
        "candidate_strategy": strategy,
        "clustering_embedding_model": clustering_embedding_model,
        "candidates_evaluated": n_evaluated,
        "weights": {"alpha": payload.alpha, "beta": payload.beta, "gamma": payload.gamma},
        "outlier_detection": {
            "enabled": outlier_enabled,
            "k": payload.outlier_k,
            "percentile": payload.outlier_percentile,
        },
        "hint": (
            "Более высокая total_uncertainty обычно означает сложный для модели пример; "
            "пару таких пар «текст → JSON» можно добавить в промпт как few-shot."
        ),
        "results": results,
    }


# --- Фоновые few-shot задачи (привязка к rule_id; статус после обновления страницы) ---
_FEW_SHOT_JOB_LOCK = asyncio.Lock()
_FEW_SHOT_JOBS: dict[str, dict[str, Any]] = {}
_FEW_SHOT_RULE_ACTIVE: dict[str, str] = {}
_FEW_SHOT_JOB_MAX = 500


def _utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


async def _few_shot_job_emit(job_id: str, ev: dict[str, Any]) -> None:
    async with _FEW_SHOT_JOB_LOCK:
        j = _FEW_SHOT_JOBS.get(job_id)
        if not j:
            return
        j["updated_at"] = _utc_iso()
        event = ev.get("event")
        if event == "phase":
            j["phase"] = ev.get("phase")
            if isinstance(ev.get("message"), str):
                j["message"] = ev["message"]
            if ev.get("phase") == "evaluating":
                tt = ev.get("llm_calls_total")
                if isinstance(tt, (int, float)):
                    j["llm_calls_total"] = int(tt)
        elif event == "progress":
            d = ev.get("llm_calls_done")
            t = ev.get("llm_calls_total")
            if isinstance(d, (int, float)):
                j["llm_calls_done"] = int(d)
            if isinstance(t, (int, float)):
                j["llm_calls_total"] = int(t)
            if isinstance(ev.get("message"), str):
                j["message"] = ev["message"]


async def _few_shot_background_worker(job_id: str, payload: FewShotAssistRequest) -> None:
    rule_key = (payload.rule_id or "").strip() or None

    async def emit(ev: dict[str, Any]) -> None:
        await _few_shot_job_emit(job_id, ev)

    try:
        result = await _execute_few_shot_assist(payload, emit=emit)
        async with _FEW_SHOT_JOB_LOCK:
            j = _FEW_SHOT_JOBS.get(job_id)
            if j:
                j["status"] = "completed"
                j["result"] = result
                j["phase"] = "done"
                j["message"] = "Готово"
                j["updated_at"] = _utc_iso()
            if rule_key and _FEW_SHOT_RULE_ACTIVE.get(rule_key) == job_id:
                del _FEW_SHOT_RULE_ACTIVE[rule_key]
    except HTTPException as he:
        async with _FEW_SHOT_JOB_LOCK:
            j = _FEW_SHOT_JOBS.get(job_id)
            if j:
                j["status"] = "failed"
                err = _http_exception_detail(he)
                j["error"] = err
                j["phase"] = "error"
                j["message"] = err
                j["updated_at"] = _utc_iso()
            if rule_key and _FEW_SHOT_RULE_ACTIVE.get(rule_key) == job_id:
                del _FEW_SHOT_RULE_ACTIVE[rule_key]
    except Exception as exc:
        async with _FEW_SHOT_JOB_LOCK:
            j = _FEW_SHOT_JOBS.get(job_id)
            if j:
                j["status"] = "failed"
                j["error"] = str(exc)
                j["phase"] = "error"
                j["message"] = str(exc)
                j["updated_at"] = _utc_iso()
            if rule_key and _FEW_SHOT_RULE_ACTIVE.get(rule_key) == job_id:
                del _FEW_SHOT_RULE_ACTIVE[rule_key]


def _prune_few_shot_jobs_unlocked() -> None:
    if len(_FEW_SHOT_JOBS) <= _FEW_SHOT_JOB_MAX:
        return
    done = [(k, v) for k, v in _FEW_SHOT_JOBS.items() if v.get("status") in ("completed", "failed")]
    done.sort(key=lambda kv: kv[1].get("updated_at") or "")
    for k, _ in done[: max(0, len(done) - 100)]:
        _FEW_SHOT_JOBS.pop(k, None)


@app.post("/api/feature-extraction/few-shot-assist/jobs")
async def few_shot_assist_create_job(payload: FewShotAssistRequest) -> dict[str, Any]:
    """Запуск few-shot в фоне; при том же rule_id возвращает уже идущую задачу."""
    rule_key = (payload.rule_id or "").strip() or None
    async with _FEW_SHOT_JOB_LOCK:
        if rule_key and rule_key in _FEW_SHOT_RULE_ACTIVE:
            jid = _FEW_SHOT_RULE_ACTIVE[rule_key]
            ex = _FEW_SHOT_JOBS.get(jid)
            if ex and ex.get("status") == "running":
                return {
                    "job_id": jid,
                    "rule_id": rule_key,
                    "resumed": True,
                    "created_at": ex["created_at"],
                    "message": "Для этого справочника уже выполняется обработка — показан её статус.",
                }
        _prune_few_shot_jobs_unlocked()
        job_id = str(uuid.uuid4())
        now = _utc_iso()
        _FEW_SHOT_JOBS[job_id] = {
            "job_id": job_id,
            "rule_id": rule_key,
            "status": "running",
            "created_at": now,
            "updated_at": now,
            "phase": None,
            "message": "Запуск…",
            "llm_calls_done": 0,
            "llm_calls_total": None,
            "result": None,
            "error": None,
        }
        if rule_key:
            _FEW_SHOT_RULE_ACTIVE[rule_key] = job_id
    asyncio.create_task(_few_shot_background_worker(job_id, payload))
    return {"job_id": job_id, "rule_id": rule_key, "resumed": False, "created_at": now}


@app.get("/api/feature-extraction/few-shot-assist/jobs/by-rule")
async def few_shot_assist_job_by_rule(rule_id: str) -> dict[str, Any]:
    """Активная задача few-shot для справочника (обновление страницы)."""
    rk = (rule_id or "").strip()
    if not rk:
        raise HTTPException(status_code=400, detail="Укажите rule_id")
    async with _FEW_SHOT_JOB_LOCK:
        jid = _FEW_SHOT_RULE_ACTIVE.get(rk)
        if not jid:
            return {"job": None}
        j = _FEW_SHOT_JOBS.get(jid)
        if not j or j.get("status") != "running":
            return {"job": None}
        return {"job": dict(j)}


@app.get("/api/feature-extraction/few-shot-assist/jobs/{job_id}")
async def few_shot_assist_get_job(job_id: str) -> dict[str, Any]:
    async with _FEW_SHOT_JOB_LOCK:
        j = _FEW_SHOT_JOBS.get(job_id)
        if not j:
            raise HTTPException(
                status_code=404,
                detail="Задача не найдена (устарела или перезапуск api-gateway).",
            )
        return dict(j)


@app.post("/api/feature-extraction/few-shot-assist")
async def few_shot_assist(payload: FewShotAssistRequest) -> dict[str, Any]:
    return await _execute_few_shot_assist(payload)


@app.post("/api/feature-extraction/few-shot-assist/stream")
async def few_shot_assist_stream(payload: FewShotAssistRequest) -> StreamingResponse:
    """Тот же расчёт, что few-shot-assist, но NDJSON: события phase/progress и финальная строка complete."""

    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

    async def emit(ev: dict[str, Any]) -> None:
        await queue.put(("ev", ev))

    async def worker() -> None:
        try:
            result = await _execute_few_shot_assist(payload, emit=emit)
            await queue.put(("done", result))
        except HTTPException as he:
            await queue.put(("http_err", he))
        except Exception as exc:
            await queue.put(("err", str(exc)))

    asyncio.create_task(worker())

    async def ndjson_bytes() -> AsyncIterator[bytes]:
        while True:
            kind, data = await queue.get()
            if kind == "ev":
                yield (json.dumps(data, ensure_ascii=False) + "\n").encode("utf-8")
            elif kind == "done":
                line = json.dumps({"event": "complete", "result": data}, ensure_ascii=False) + "\n"
                yield line.encode("utf-8")
                break
            elif kind == "http_err":
                he = data
                err_body = {
                    "event": "error",
                    "status_code": he.status_code,
                    "message": _http_exception_detail(he),
                }
                yield (json.dumps(err_body, ensure_ascii=False) + "\n").encode("utf-8")
                break
            elif kind == "err":
                yield (json.dumps({"event": "error", "message": data}, ensure_ascii=False) + "\n").encode(
                    "utf-8"
                )
                break

    return StreamingResponse(ndjson_bytes(), media_type="application/x-ndjson")


@app.post("/api/feature-extraction/generate-prompt")
async def generate_extraction_system_prompt(payload: GenerateExtractionPromptRequest) -> dict[str, Any]:
    """
    Генерация текста системного промпта для извлечения признаков: на вход — полный текст
    для LLM-«промпт-инженера» (мета-инструкция + JSON из справочника), на выходе — готовый промпт.
    """
    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Пустой текст запроса к генератору промпта")

    model = (payload.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="Укажите model (тег Ollama)")

    await _require_model_running_for_prompt_test(model)

    overrides = payload.model_dump(exclude_unset=True)
    overrides.pop("model", None)
    overrides.pop("prompt", None)
    merged = effective_prompt_generator_params(overrides)

    body: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "num_ctx": int(merged["num_ctx"]),
        "max_new_tokens": int(merged["max_new_tokens"]),
        "repetition_penalty": float(merged["repetition_penalty"]),
        "temperature": float(merged["temperature"]),
        "enable_thinking": bool(merged["enable_thinking"]),
    }
    if merged.get("top_p") is not None:
        body["top_p"] = float(merged["top_p"])

    async with httpx.AsyncClient(timeout=LLM_HTTP_TIMEOUT) as client:
        try:
            resp = await request_with_retry(
                client,
                "POST",
                f"{PREPROCESSING_URL}/api/v1/ollama/generate",
                json=body,
                timeout=LLM_HTTP_TIMEOUT,
            )
            resp.raise_for_status()
            gen = resp.json()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"preprocessing/ollama: {exc.response.text[:800]}",
            ) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"preprocessing: {exc}") from exc

    llm_text = str(gen.get("raw_response") or "").strip()
    if not llm_text:
        raise HTTPException(
            status_code=502,
            detail="Модель вернула пустой ответ. Повторите запрос или смените модель.",
        )

    out: dict[str, Any] = {
        "status": "ok",
        "generated_prompt": llm_text,
        "ollama": {k: v for k, v in gen.items() if k != "raw_response"},
        "prompt_generator_params": merged,
    }
    td_ns = gen.get("total_duration_ns")
    if td_ns is not None:
        try:
            out["ollama_compute_duration_sec"] = round(float(td_ns) / 1e9, 4)
        except (TypeError, ValueError):
            pass
    return out


class PipelineConfigBody(BaseModel):
    semantic_similarity_threshold: Optional[float] = None


@app.get("/api/admin/pipeline-config")
def get_pipeline_configuration() -> dict[str, Any]:
    """Порог SimCheck (README mermaid): схожесть с классами справочника."""
    path = pipeline_config_path()
    return {
        "config_path": str(path),
        "file_exists": path.is_file(),
        "defaults": PIPELINE_CODE_DEFAULT,
        "from_file": load_pipeline_file(),
        "effective": effective_pipeline_params(None),
    }


@app.put("/api/admin/pipeline-config")
def put_pipeline_configuration(body: PipelineConfigBody) -> dict[str, Any]:
    merged = effective_pipeline_params(body.model_dump(exclude_unset=True))
    save_pipeline_file(merged)
    return {"status": "ok", "effective": merged}


class ExpertClassNameDecisionBody(BaseModel):
    declaration_id: str = ""
    rule_id: str | None = None
    suggested_class_name: str = ""
    decision: str = ""
    note: str | None = None


@app.post("/api/expert/class-name-decision")
def expert_class_name_decision(body: ExpertClassNameDecisionBody) -> dict[str, Any]:
    """Журнал решений эксперта по сгенерированному имени класса (ветка ExpertValidateGen)."""
    d = (body.decision or "").strip().lower()
    if d not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="decision must be approve or reject")
    log_path = Path(__file__).resolve().parent.parent / "config" / "class_name_decisions.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        **body.model_dump(),
        "ts_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    log_path.open("a", encoding="utf-8").write(json.dumps(record, ensure_ascii=False) + "\n")
    return {"status": "ok", "logged": True, "path": str(log_path)}


@app.get("/api/feature-extraction/prompt-generator-config")
def get_prompt_generator_configuration() -> dict[str, Any]:
    """Текущие параметры генератора промпта: код по умолчанию, содержимое JSON-файла, итог после слияния."""
    path = prompt_generator_config_path()
    return {
        "config_path": str(path),
        "file_exists": path.is_file(),
        "defaults_code": PROMPT_GENERATOR_CODE_DEFAULT,
        "from_file": load_prompt_generator_file(),
        "effective": effective_prompt_generator_params(None),
    }


@app.get("/api/feature-extraction/model-settings")
async def get_feature_extraction_model_settings() -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            resp = await request_with_retry(client, "GET", f"{RULES_ENGINE_URL}/api/feature-extraction/model-settings")
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"rules-engine unavailable: {exc}") from exc


@app.put("/api/feature-extraction/model-settings")
async def put_feature_extraction_model_settings(request: Request) -> Any:
    body = await request.body()
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            resp = await request_with_retry(
                client,
                "PUT",
                f"{RULES_ENGINE_URL}/api/feature-extraction/model-settings",
                content=body if body else None,
                headers={"content-type": request.headers.get("content-type", "application/json")},
            )
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"rules-engine unavailable: {exc}") from exc


@app.get("/api/feature-extraction/primary-catalog-settings")
async def get_primary_catalog_settings() -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            resp = await request_with_retry(
                client, "GET", f"{RULES_ENGINE_URL}/api/feature-extraction/primary-catalog-settings"
            )
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"rules-engine unavailable: {exc}") from exc


@app.put("/api/feature-extraction/primary-catalog-settings")
async def put_primary_catalog_settings(request: Request) -> Any:
    body = await request.body()
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            resp = await request_with_retry(
                client,
                "PUT",
                f"{RULES_ENGINE_URL}/api/feature-extraction/primary-catalog-settings",
                content=body if body else None,
                headers={"content-type": request.headers.get("content-type", "application/json")},
            )
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"rules-engine unavailable: {exc}") from exc


@app.post("/api/feature-extraction/few-shot-runs")
async def post_few_shot_runs(request: Request) -> Any:
    body = await request.body()
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            resp = await request_with_retry(
                client,
                "POST",
                f"{RULES_ENGINE_URL}/api/feature-extraction/few-shot-runs",
                content=body if body else None,
                headers={"content-type": request.headers.get("content-type", "application/json")},
            )
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"rules-engine unavailable: {exc}") from exc


@app.get("/api/feature-extraction/few-shot-runs")
async def get_few_shot_runs(request: Request) -> Any:
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await request_with_retry(
                client,
                "GET",
                f"{RULES_ENGINE_URL}/api/feature-extraction/few-shot-runs",
                params=request.query_params,
            )
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"rules-engine unavailable: {exc}") from exc


@app.delete("/api/feature-extraction/few-shot-runs/{run_id}")
async def delete_few_shot_run(run_id: str, request: Request) -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            resp = await request_with_retry(
                client,
                "DELETE",
                f"{RULES_ENGINE_URL}/api/feature-extraction/few-shot-runs/{run_id}",
            )
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"rules-engine unavailable: {exc}") from exc


@app.get("/api/feature-extraction/models")
async def get_feature_extraction_models() -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            tags_resp = await request_with_retry(client, "GET", f"{PREPROCESSING_URL}/api/v1/models/available")
            tags_resp.raise_for_status()
            tags_data = tags_resp.json()

            settings_resp = await request_with_retry(
                client, "GET", f"{RULES_ENGINE_URL}/api/feature-extraction/model-settings"
            )
            settings_resp.raise_for_status()
            settings_data = settings_resp.json()

            configured_models = list((settings_data.get("models") or {}).keys())
            installed_models = [str(x) for x in (tags_data.get("installed_models") or [])]

            running_models: list[str] = []
            try:
                run_resp = await request_with_retry(client, "GET", f"{PREPROCESSING_URL}/api/v1/models/running")
                if run_resp.status_code == 200:
                    run_data = run_resp.json()
                    running_models = [str(x) for x in (run_data.get("running_models") or [])]
            except Exception:
                running_models = []

            return {
                "installed_models": installed_models,
                "configured_models": configured_models,
                "running_models": running_models,
            }
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"feature-extraction models unavailable: {exc}") from exc


@app.get("/api/feature-extraction/model-operation-history")
async def get_feature_extraction_model_operation_history() -> dict[str, Any]:
    """Журнал операций и событий рантайма за время жизни процесса api-gateway (память процесса)."""
    await _probe_and_record_model_runtime_state()
    with _model_op_lock:
        events = list(_model_op_history)
    return {
        "events": events,
        "source": "api-gateway",
        "max_entries": MODEL_OP_HISTORY_MAX,
    }


@app.post("/api/feature-extraction/deploy")
async def deploy_feature_extraction_model(request: Request) -> Any:
    body = await request.body()
    model = _parse_model_from_request_body(body)
    async with httpx.AsyncClient(timeout=LLM_HTTP_TIMEOUT) as client:
        try:
            resp = await request_with_retry(
                client,
                "POST",
                f"{PREPROCESSING_URL}/api/v1/models/deploy",
                content=body if body else None,
                headers={"content-type": request.headers.get("content-type", "application/json")},
            )
            content = resp.content
            st = resp.status_code
            summ = _summarize_model_op_response("deploy", st, content)
            _record_model_operation(
                "deploy",
                model,
                ok=st < 400,
                http_status=st,
                detail=summ,
            )
            return Response(content=content, status_code=st, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            _record_model_operation(
                "deploy",
                model,
                ok=False,
                http_status=502,
                detail=str(exc)[:4000],
            )
            raise HTTPException(status_code=502, detail=f"preprocessing unavailable: {exc}") from exc


@app.post("/api/feature-extraction/pause")
async def pause_feature_extraction_model(request: Request) -> Any:
    body = await request.body()
    model = _parse_model_from_request_body(body)
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await request_with_retry(
                client,
                "POST",
                f"{PREPROCESSING_URL}/api/v1/models/pause",
                content=body if body else None,
                headers={"content-type": request.headers.get("content-type", "application/json")},
            )
            content = resp.content
            st = resp.status_code
            summ = _summarize_model_op_response("pause", st, content)
            _record_model_operation(
                "pause",
                model,
                ok=st < 400,
                http_status=st,
                detail=summ,
            )
            return Response(content=content, status_code=st, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            _record_model_operation(
                "pause",
                model,
                ok=False,
                http_status=502,
                detail=str(exc)[:4000],
            )
            raise HTTPException(status_code=502, detail=f"preprocessing unavailable: {exc}") from exc


@app.get("/api/feature-extraction/ollama-container-logs")
async def ollama_container_logs_proxy(tail: int = 200) -> Any:
    """Прокси к preprocessing: хвост логов контейнера Ollama (`docker logs`)."""
    t = max(20, min(tail, 5000))
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.get(
                f"{PREPROCESSING_URL}/api/v1/diagnostics/ollama-container-logs",
                params={"tail": t},
            )
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                media_type=resp.headers.get("content-type", "application/json"),
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"preprocessing: {exc}") from exc


@app.post("/api/feature-extraction/delete")
async def delete_feature_extraction_model(request: Request) -> Any:
    body = await request.body()
    model = _parse_model_from_request_body(body)
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await request_with_retry(
                client,
                "POST",
                f"{PREPROCESSING_URL}/api/v1/models/delete",
                content=body if body else None,
                headers={"content-type": request.headers.get("content-type", "application/json")},
            )
            content = resp.content
            st = resp.status_code
            summ = _summarize_model_op_response("delete", st, content)
            _record_model_operation(
                "delete",
                model,
                ok=st < 400,
                http_status=st,
                detail=summ,
            )
            return Response(content=content, status_code=st, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            _record_model_operation(
                "delete",
                model,
                ok=False,
                http_status=502,
                detail=str(exc)[:4000],
            )
            raise HTTPException(status_code=502, detail=f"preprocessing unavailable: {exc}") from exc


@app.post("/api/validate")
async def validate(payload: ValidationRequest) -> Any:
    async with httpx.AsyncClient(timeout=920.0) as client:
        try:
            resp = await request_with_retry(
                client,
                "POST",
                f"{ORCHESTRATOR_URL}/api/v1/pipeline/validate",
                json=payload.model_dump(),
            )
            if resp.status_code >= 400:
                try:
                    body = resp.json()
                except Exception:
                    body = resp.text
                if isinstance(body, dict) and "detail" in body:
                    det: Any = body["detail"]
                else:
                    det = body
                raise HTTPException(status_code=resp.status_code, detail=det)
            return resp.json()
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"orchestrator unavailable: {exc}") from exc


@app.post("/api/validate/stream")
async def validate_stream(payload: ValidationRequest) -> StreamingResponse:
    async def ndjson_bytes() -> AsyncIterator[bytes]:
        yield (
            json.dumps(
                {
                    "event": "phase",
                    "code": "gateway-connect",
                    "title": "Подключение к оркестратору",
                    "detail": "Шлюз открыл поток и ожидает первый этап от оркестратора.",
                },
                ensure_ascii=False,
            )
            + "\n"
        ).encode("utf-8")
        async with httpx.AsyncClient(timeout=930.0) as client:
            try:
                async with client.stream(
                    "POST",
                    f"{ORCHESTRATOR_URL}/api/v1/pipeline/validate/stream",
                    json=payload.model_dump(),
                ) as resp:
                    if resp.status_code >= 400:
                        text = await resp.aread()
                        msg = text.decode("utf-8", errors="replace")[:2000]
                        yield (
                            json.dumps(
                                {
                                    "event": "error",
                                    "status_code": resp.status_code,
                                    "message": msg or f"orchestrator http {resp.status_code}",
                                },
                                ensure_ascii=False,
                            )
                            + "\n"
                        ).encode("utf-8")
                        return
                    async for line in resp.aiter_lines():
                        s = (line or "").strip()
                        if not s:
                            continue
                        yield (s + "\n").encode("utf-8")
            except Exception as exc:
                yield (
                    json.dumps(
                        {"event": "error", "status_code": 502, "message": f"orchestrator unavailable: {exc}"},
                        ensure_ascii=False,
                    )
                    + "\n"
                ).encode("utf-8")

    return StreamingResponse(ndjson_bytes(), media_type="application/x-ndjson")


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: int) -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            resp = await request_with_retry(client, "GET", f"{ORCHESTRATOR_URL}/api/v1/jobs/{job_id}")
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"orchestrator unavailable: {exc}") from exc


@app.api_route("/api/rules", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
@app.api_route("/api/rules/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy_rules(request: Request, path: str = "") -> Any:
    # Passthrough for existing frontend rule APIs.
    body = await request.body()
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await request_with_retry(
            client,
            request.method,
            f"{RULES_ENGINE_URL}/api/rules/{path}" if path else f"{RULES_ENGINE_URL}/api/rules",
            params=request.query_params,
            content=body if body else None,
            headers={"content-type": request.headers.get("content-type", "application/json")},
        )
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))


@app.api_route("/api/expert-decisions", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
@app.api_route("/api/expert-decisions/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy_expert_decisions(request: Request, path: str = "") -> Any:
    body = await request.body()
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await request_with_retry(
            client,
            request.method,
            f"{RULES_ENGINE_URL}/api/expert-decisions/{path}" if path else f"{RULES_ENGINE_URL}/api/expert-decisions",
            params=request.query_params,
            content=body if body else None,
            headers={"content-type": request.headers.get("content-type", "application/json")},
        )
        return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
