from __future__ import annotations

import os
import re
import time
import asyncio
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

ORCHESTRATOR_URL = os.getenv("ORCHESTRATOR_URL", "http://orchestrator:8003")
RULES_ENGINE_URL = os.getenv("RULES_ENGINE_URL", "http://backend:8000")
PREPROCESSING_URL = os.getenv("PREPROCESSING_URL", "http://preprocessing:8004")
LLM_HTTP_TIMEOUT = float(os.getenv("LLM_HTTP_TIMEOUT", "900"))
SEMANTIC_SEARCH_URL = os.getenv("SEMANTIC_SEARCH_URL", "http://semantic-search:8001")
LLM_GENERATOR_URL = os.getenv("LLM_GENERATOR_URL", "http://llm-naming:8002")
PRICE_VALIDATOR_URL = os.getenv("PRICE_VALIDATOR_URL", "http://price-validator:8006")
CLUSTERING_SERVICE_URL = os.getenv("CLUSTERING_SERVICE_URL", "http://clustering-service:8007")

app = FastAPI(title="API Gateway", version="0.1.0")
RETRY_ATTEMPTS = 3
RETRY_BASE_DELAY_SECONDS = 0.35


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


class GenerateExtractionPromptRequest(BaseModel):
    """Один вызов LLM: по мета-промпту сгенерировать системный промпт извлечения признаков."""

    model: str = ""
    prompt: str = ""
    num_ctx: int = 8192
    max_new_tokens: int = 4096
    temperature: float = 0.3
    top_p: float = 0.9
    repetition_penalty: float = 1.0
    enable_thinking: bool = False


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


@app.post("/api/feature-extraction/few-shot-assist")
async def few_shot_assist(payload: FewShotAssistRequest) -> dict[str, Any]:
    """
    Несколько запусков модели с sampling (temperature) на каждый текст, затем метрики
    Generation / Format / Content uncertainty и итог 𝒰 = α·𝒰_d + β·𝒰_f + γ·𝒰_c.
    Высокая неопределённость → сложный пример, удобный для включения в few-shot.
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
        req_body = {
            "texts": filtered_lines,
            "n_clusters": max(1, min(int(payload.n_clusters), 200)),
            "max_candidates": max_candidates,
        }
        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                cluster_resp = await request_with_retry(
                    client,
                    "POST",
                    f"{CLUSTERING_SERVICE_URL}/api/v1/clustering/select-candidates",
                    json=req_body,
                    timeout=120.0,
                )
                cluster_resp.raise_for_status()
                cluster_data = cluster_resp.json() if cluster_resp.content else {}
            except httpx.HTTPStatusError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"clustering-service: {exc.response.text[:800]}",
                ) from exc
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"clustering-service: {exc}") from exc

        candidates_raw = cluster_data.get("candidates")
        cluster_map_raw = cluster_data.get("cluster_by_text")
        clustering_embedding_model = (
            str(cluster_data.get("embedding_model")).strip()
            if cluster_data.get("embedding_model") is not None
            else None
        )
        candidates = [str(x).strip() for x in (candidates_raw or []) if str(x).strip()]
        cluster_by_text = {
            str(k): int(v)
            for k, v in (cluster_map_raw or {}).items()
            if str(k).strip()
        }
        if not candidates:
            # Если сервис вернул пусто, безопасный fallback — первые строки.
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

    top_n = max(1, min(int(payload.top_n), 50))
    results: list[dict[str, Any]] = []

    async with httpx.AsyncClient(timeout=LLM_HTTP_TIMEOUT) as client:
        for text in candidates:
            responses: list[str] = []
            assembled = _assemble_extraction_prompt(
                rules_preview=payload.rules_preview,
                prompt=payload.prompt,
                sample_text=text,
            )
            for _ in range(k):
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

    body = {
        "model": model,
        "prompt": prompt,
        "num_ctx": int(payload.num_ctx),
        "max_new_tokens": int(payload.max_new_tokens),
        "repetition_penalty": float(payload.repetition_penalty),
        "temperature": float(payload.temperature),
        "top_p": float(payload.top_p),
        "enable_thinking": bool(payload.enable_thinking),
    }

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
    }
    td_ns = gen.get("total_duration_ns")
    if td_ns is not None:
        try:
            out["ollama_compute_duration_sec"] = round(float(td_ns) / 1e9, 4)
        except (TypeError, ValueError):
            pass
    return out


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


@app.post("/api/feature-extraction/deploy")
async def deploy_feature_extraction_model(request: Request) -> Any:
    body = await request.body()
    async with httpx.AsyncClient(timeout=LLM_HTTP_TIMEOUT) as client:
        try:
            resp = await request_with_retry(
                client,
                "POST",
                f"{PREPROCESSING_URL}/api/v1/models/deploy",
                content=body if body else None,
                headers={"content-type": request.headers.get("content-type", "application/json")},
            )
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"preprocessing unavailable: {exc}") from exc


@app.post("/api/feature-extraction/pause")
async def pause_feature_extraction_model(request: Request) -> Any:
    body = await request.body()
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await request_with_retry(
                client,
                "POST",
                f"{PREPROCESSING_URL}/api/v1/models/pause",
                content=body if body else None,
                headers={"content-type": request.headers.get("content-type", "application/json")},
            )
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
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
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await request_with_retry(
                client,
                "POST",
                f"{PREPROCESSING_URL}/api/v1/models/delete",
                content=body if body else None,
                headers={"content-type": request.headers.get("content-type", "application/json")},
            )
            return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))
        except Exception as exc:
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
