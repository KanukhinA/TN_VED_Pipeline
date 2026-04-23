from __future__ import annotations

from typing import Any
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.llm_runtime_bridge import (
    delete_model_request,
    fetch_running_models,
    get_installed_model_names,
    ollama_pull_stream,
    pause_one_model_ram,
    ready_probe,
    unload_other_running_ollama_models,
)
from shared.llm_runtime.compat import ollama_generate
from shared.llm_runtime.config import is_vllm, runtime_base_url

app = FastAPI(title="Preprocessing Service", version="0.1.0")
_MODEL_SETTINGS_FALLBACK = Path(__file__).resolve().parent / "model_runtime_settings.json"
MODEL_SETTINGS_PATH = Path(os.getenv("MODEL_RUNTIME_SETTINGS_PATH", str(_MODEL_SETTINGS_FALLBACK)))
OLLAMA_CONTAINER_NAME = (os.getenv("OLLAMA_CONTAINER_NAME") or "pipeline_ollama").strip()
VLLM_CONTAINER_NAME = (os.getenv("VLLM_CONTAINER_NAME") or "pipeline_vllm").strip()
PREPROCESSING_CONTAINER_NAME = (os.getenv("PREPROCESSING_CONTAINER_NAME") or "pipeline_preprocessing").strip()


class ModelDeployRequest(BaseModel):
    model: str


class ModelActionRequest(BaseModel):
    model: str


class ModelRuntimeSettingsPayload(BaseModel):
    models: dict[str, dict[str, Any]] = Field(default_factory=dict)
    model_config = ConfigDict(extra="ignore")


DEFAULT_MODEL_SETTINGS: dict[str, Any] = {"models": {}}


def _load_model_settings() -> dict[str, Any]:
    if not MODEL_SETTINGS_PATH.exists():
        return dict(DEFAULT_MODEL_SETTINGS)
    try:
        data = json.loads(MODEL_SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return dict(DEFAULT_MODEL_SETTINGS)
    if not isinstance(data, dict):
        return dict(DEFAULT_MODEL_SETTINGS)
    models = data.get("models")
    if not isinstance(models, dict):
        models = {}
    return {"models": models}


def _save_model_settings(payload: dict[str, Any]) -> dict[str, Any]:
    MODEL_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    normalized = {
        "models": payload.get("models") if isinstance(payload.get("models"), dict) else {},
    }
    MODEL_SETTINGS_PATH.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")
    return normalized


def _warm_load_model_into_ram(model: str) -> dict[str, Any]:
    """
    Загрузить веса в память: короткий generate (после pull или если образ уже на диске).
    Остальные модели в RAM выгружаются — в памяти остаётся одна.
    """
    m = model.strip()
    settings = _load_model_settings()
    mcfg = (settings.get("models") or {}).get(m) or {}
    num_ctx = int(mcfg.get("num_ctx", 8192))
    num_predict = min(int(mcfg.get("max_new_tokens", 64)), 128)
    repeat_penalty = float(mcfg.get("repetition_penalty", 1.0))
    temperature = float(mcfg.get("temperature", 0.0))
    enable_thinking = bool(mcfg.get("enable_thinking", False))
    unload_other_running_ollama_models(m)
    out = ollama_generate(
        m,
        "ok",
        num_ctx=num_ctx,
        num_predict=num_predict,
        repeat_penalty=repeat_penalty,
        temperature=temperature,
        enable_thinking=enable_thinking,
        timeout=600.0,
    )
    raw = (out.get("raw_response") or "")[:400]
    slim = {k: v for k, v in out.items() if k != "raw_response"}
    if raw:
        slim["raw_response_preview"] = raw
    return slim


class PreprocessRequest(BaseModel):
    declaration_id: str
    description: str
    tnved_code: str | None = None


class ParseModelJsonRequest(BaseModel):
    """Сырой ответ LLM (в т.ч. с пояснениями и битым JSON)."""

    text: str


class OllamaGenerateRequest(BaseModel):
    model: str
    prompt: str
    num_ctx: int = Field(default=8192, ge=256)
    max_new_tokens: int = Field(default=3904, ge=32)
    repetition_penalty: float = Field(default=1.0, ge=0.5, le=2.0)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    enable_thinking: bool = False


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "preprocessing"}


@app.get("/ready")
def ready() -> dict[str, Any]:
    ok, _probe_url = ready_probe()
    rb = runtime_base_url()
    return {
        "status": "ok" if ok else "degraded",
        "ollama": "ok" if ok else "down",
        "ollama_base_url": rb,
        "llm_backend": "vllm" if is_vllm() else "ollama",
    }


@app.get("/api/v1/models/settings")
def get_model_settings() -> dict[str, Any]:
    return _load_model_settings()


@app.put("/api/v1/models/settings")
def put_model_settings(payload: ModelRuntimeSettingsPayload) -> dict[str, Any]:
    return _save_model_settings(payload.model_dump())


@app.get("/api/v1/models/available")
def get_available_models() -> dict[str, Any]:
    configured = _load_model_settings()
    configured_models = list((configured.get("models") or {}).keys())
    try:
        installed = sorted(get_installed_model_names())
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"llm runtime unavailable ({runtime_base_url()}): {exc}",
        ) from exc
    return {
        "installed_models": installed,
        "configured_models": configured_models,
    }


@app.get("/api/v1/models/running")
def get_running_models() -> dict[str, Any]:
    """Ollama: GET /api/ps. vLLM: GET /v1/models (модели, отданные сервером)."""
    return fetch_running_models()


@app.post("/api/v1/models/deploy")
def deploy_model(payload: ModelDeployRequest) -> dict[str, Any]:
    """
    Ollama: при отсутствии тега — pull, затем короткий generate.
    vLLM: pull нет; модель должна быть в /v1/models, затем короткий generate (прогрев).
    """
    model = (payload.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    t0 = time.time()
    pull_log: list[str] = []
    pull_console_lines: list[str] = []
    last_pull_event: dict[str, Any] = {}
    pulled = False
    try:
        installed = get_installed_model_names()
        if model not in installed:
            if is_vllm():
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Модель {model!r} не найдена в {runtime_base_url()}/v1/models. "
                        "Запустите vLLM с этой моделью или исправьте имя (часто HF id)."
                    ),
                )
            pulled = True
            pull_log, last_pull_event, pull_console_lines = ollama_pull_stream(model)
        warm_load = _warm_load_model_into_ram(model)
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"llm runtime unavailable ({runtime_base_url()}): {exc}") from exc
    tail = pull_log[-400:]
    tail_console = pull_console_lines[-400:]
    duration_sec = round(time.time() - t0, 2)
    return {
        "status": "ok",
        "model": model,
        "pulled": pulled,
        "ollama_pull_last_event": last_pull_event if pulled else None,
        "warm_load": warm_load,
        "pull_log": tail,
        "pull_console_lines": tail_console,
        "duration_sec": duration_sec,
    }


@app.post("/api/v1/models/pause")
def pause_model(payload: ModelActionRequest) -> dict[str, Any]:
    model = (payload.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    try:
        data = pause_one_model_ram(model)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"llm runtime unavailable ({runtime_base_url()}): {exc}") from exc
    if is_vllm() and not data:
        data = {"note": "noop: vLLM не поддерживает выгрузку отдельной модели как Ollama keep_alive=0"}
    return {"status": "ok", "model": model, "action": "pause", "ollama_response": data}


@app.post("/api/v1/models/delete")
def delete_model(payload: ModelActionRequest) -> dict[str, Any]:
    model = (payload.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    try:
        data = delete_model_request(model)
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"llm runtime unavailable ({runtime_base_url()}): {exc}") from exc
    return {"status": "ok", "model": model, "action": "delete", "ollama_response": data}


@app.post("/api/v1/parse-model-json")
def parse_model_json(payload: ParseModelJsonRequest) -> dict[str, Any]:
    from app.json_recovery import extract_json_from_response, parse_json_from_model_response

    raw = (payload.text or "").strip()
    if not raw:
        return {"parsed": {}, "extracted_fragment_preview": ""}
    fragment = extract_json_from_response(raw)
    return {
        "parsed": parse_json_from_model_response(raw),
        "extracted_fragment_preview": fragment[:1200],
    }


@app.post("/api/v1/ollama/generate")
def ollama_generate_endpoint(body: OllamaGenerateRequest) -> dict[str, Any]:
    if not (body.model or "").strip():
        raise HTTPException(status_code=400, detail="model is required")
    if not (body.prompt or "").strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    unload_other_running_ollama_models(body.model.strip())
    try:
        return ollama_generate(
            body.model.strip(),
            body.prompt,
            num_ctx=body.num_ctx,
            num_predict=body.max_new_tokens,
            repeat_penalty=body.repetition_penalty,
            temperature=body.temperature,
            top_p=body.top_p,
            enable_thinking=body.enable_thinking,
        )
    except httpx.HTTPStatusError as e:
        tag = "vllm" if is_vllm() else "ollama"
        raise HTTPException(
            status_code=502,
            detail=f"{tag} http {e.response.status_code}: {e.response.text[:500]}",
        ) from e
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=502,
            detail=f"llm unreachable ({runtime_base_url()}): {e}",
        ) from e


@app.post("/api/v1/preprocess")
def preprocess(payload: PreprocessRequest) -> dict[str, object]:
    return {
        "declaration_id": payload.declaration_id,
        "features": {
            "length": len(payload.description),
            "contains_digits": any(ch.isdigit() for ch in payload.description),
            "tnved_hint": payload.tnved_code,
        },
    }


@app.get("/api/v1/diagnostics/ollama-container-logs")
def ollama_container_logs(tail: int = 200) -> dict[str, Any]:
    """
    Хвост stdout/stderr контейнера LLM через `docker logs` (Ollama или vLLM).
    Нужны: docker CLI в образе и доступ к сокету Docker (см. docker-compose: volume docker.sock).
    """
    t = max(20, min(int(tail), 5000))
    name = VLLM_CONTAINER_NAME if is_vllm() else OLLAMA_CONTAINER_NAME
    env_hint = "VLLM_CONTAINER_NAME" if is_vllm() else "OLLAMA_CONTAINER_NAME"
    if not name:
        return {
            "available": False,
            "reason": f"{env_hint} пуст",
            "hint": "Укажите имя контейнера LLM (Ollama или vLLM).",
            "lines": "",
        }
    docker = shutil.which("docker")
    if not docker:
        return {
            "available": False,
            "reason": "docker CLI не найден в образе preprocessing",
            "hint": "На хосте: docker logs pipeline_ollama --tail 200",
            "lines": "",
        }
    try:
        proc = subprocess.run(
            [docker, "logs", "--tail", str(t), name],
            capture_output=True,
            text=True,
            timeout=25,
        )
        combined = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0 and not combined.strip():
            return {
                "available": False,
                "reason": f"docker logs завершился с кодом {proc.returncode}",
                "hint": "Убедитесь, что у сервиса preprocessing смонтирован /var/run/docker.sock и имя контейнера верно.",
                "lines": proc.stderr or "",
                "container": name,
            }
        return {
            "available": True,
            "container": name,
            "tail": t,
            "lines": combined.strip() if combined.strip() else "(пусто)",
        }
    except subprocess.TimeoutExpired:
        return {"available": False, "reason": "timeout", "lines": "", "hint": f"docker logs {name}"}
    except Exception as exc:
        return {
            "available": False,
            "reason": str(exc),
            "lines": "",
            "hint": f"docker logs {name} --tail {t}",
        }
