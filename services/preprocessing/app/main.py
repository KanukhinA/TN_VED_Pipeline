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

from app.ollama_client import OLLAMA_BASE_URL, ollama_generate

app = FastAPI(title="Preprocessing Service", version="0.1.0")
MODEL_SETTINGS_PATH = Path(__file__).resolve().parent / "model_runtime_settings.json"
OLLAMA_CONTAINER_NAME = (os.getenv("OLLAMA_CONTAINER_NAME") or "pipeline_ollama").strip()
PREPROCESSING_CONTAINER_NAME = (os.getenv("PREPROCESSING_CONTAINER_NAME") or "pipeline_preprocessing").strip()


class ModelDeployRequest(BaseModel):
    model: str


class ModelActionRequest(BaseModel):
    model: str


class ModelRuntimeSettingsPayload(BaseModel):
    models: dict[str, dict[str, Any]] = Field(default_factory=dict)
    model_config = ConfigDict(extra="ignore")


DEFAULT_MODEL_SETTINGS: dict[str, Any] = {
    "models": {
        "qwen3:4b-q4_K_M": {
            "num_ctx": 8192,
            "max_new_tokens": 3904,
            "repetition_penalty": 1.0,
            "max_length": 4096,
            "enable_thinking": False,
            "temperature": 0.0,
        }
    },
}


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


def _pause_one_model_ram(model: str) -> dict[str, Any]:
    """Выгрузить модель из RAM Ollama (keep_alive=0), без удаления файлов."""
    url = f"{OLLAMA_BASE_URL}/api/generate"
    body = {"model": model, "prompt": "", "stream": False, "keep_alive": 0}
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(url, json=body)
        resp.raise_for_status()
        return resp.json() if resp.content else {}


def _get_installed_model_names() -> set[str]:
    """Имена образов из GET /api/tags (уже скачанные в Ollama)."""
    url = f"{OLLAMA_BASE_URL}/api/tags"
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(url)
        resp.raise_for_status()
        data = resp.json()
    tags = data.get("models") if isinstance(data, dict) else []
    out: set[str] = set()
    for x in tags if isinstance(tags, list) else []:
        if isinstance(x, dict):
            n = str(x.get("name") or "").strip()
            if n:
                out.add(n)
    return out


def _ollama_pull_stream(model: str) -> tuple[list[str], dict[str, Any], list[str]]:
    """Скачать образ (pull). Ошибки в NDJSON → HTTPException.

    Возвращает: сырой NDJSON от Ollama, последнее событие, строки «как в консоли» (дубль print для UI).
    """
    url = f"{OLLAMA_BASE_URL}/api/pull"
    log_lines: list[str] = []
    console_lines: list[str] = []
    last_event: dict[str, Any] = {}
    pull_error: str | None = None
    with httpx.Client(timeout=900.0) as client:
        with client.stream("POST", url, json={"name": model, "stream": True}) as resp:
            resp.raise_for_status()
            for raw in resp.iter_lines():
                if not raw:
                    continue
                line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
                log_lines.append(line)
                try:
                    event = json.loads(line)
                except Exception:
                    msg = f"[ollama deploy] non-json line: {line[:500]}"
                    print(msg)
                    console_lines.append(msg)
                    continue
                if isinstance(event, dict):
                    if event.get("error"):
                        pull_error = str(event["error"])
                    last_event = event
                ev = json.dumps(event, ensure_ascii=False) if isinstance(event, dict) else repr(line)
                msg = f"[ollama deploy] model={model} event={ev}"
                print(msg)
                console_lines.append(msg)
    if pull_error:
        raise HTTPException(status_code=502, detail=f"ollama pull: {pull_error}")
    return log_lines, last_event or {"status": "completed"}, console_lines


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


def unload_other_running_ollama_models(keep_model: str) -> None:
    """В RAM остаётся одна модель: перед инференсом выгружаем остальные (не таймер — явный вызов из пайплайна)."""
    keep = (keep_model or "").strip()
    if not keep:
        return
    ps_url = f"{OLLAMA_BASE_URL}/api/ps"
    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(ps_url)
            if resp.status_code == 404:
                return
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        return
    models = data.get("models") if isinstance(data, dict) else []
    running = [str((x or {}).get("name") or "").strip() for x in models if isinstance(x, dict)]
    for name in running:
        if not name or name == keep:
            continue
        try:
            _pause_one_model_ram(name)
        except Exception:
            pass


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
    url = f"{OLLAMA_BASE_URL}/api/tags"
    try:
        with httpx.Client(timeout=3.0) as client:
            r = client.get(url)
            ok = r.status_code == 200
    except Exception:
        ok = False
    return {"status": "ok" if ok else "degraded", "ollama": "ok" if ok else "down", "ollama_base_url": OLLAMA_BASE_URL}


@app.get("/api/v1/models/settings")
def get_model_settings() -> dict[str, Any]:
    return _load_model_settings()


@app.put("/api/v1/models/settings")
def put_model_settings(payload: ModelRuntimeSettingsPayload) -> dict[str, Any]:
    return _save_model_settings(payload.model_dump())


@app.get("/api/v1/models/available")
def get_available_models() -> dict[str, Any]:
    url = f"{OLLAMA_BASE_URL}/api/tags"
    configured = _load_model_settings()
    configured_models = list((configured.get("models") or {}).keys())
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()
        tags = data.get("models") if isinstance(data, dict) else []
        installed = [str((x or {}).get("name") or "").strip() for x in tags if isinstance(x, dict)]
        installed = [x for x in installed if x]
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ollama unavailable ({OLLAMA_BASE_URL}): {exc}") from exc
    return {
        "installed_models": installed,
        "configured_models": configured_models,
    }


@app.get("/api/v1/models/running")
def get_running_models() -> dict[str, Any]:
    """Список моделей, загруженных в память Ollama (GET /api/ps)."""
    url = f"{OLLAMA_BASE_URL}/api/ps"
    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(url)
            if resp.status_code == 404:
                return {"running_models": [], "ollama_ps": "unavailable"}
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ollama unavailable ({OLLAMA_BASE_URL}): {exc}") from exc
    models = data.get("models") if isinstance(data, dict) else []
    running = [str((x or {}).get("name") or "").strip() for x in models if isinstance(x, dict)]
    running = [x for x in running if x]
    return {"running_models": running}


@app.post("/api/v1/models/deploy")
def deploy_model(payload: ModelDeployRequest) -> dict[str, Any]:
    """
    Запуск модели в памяти Ollama:
    - если образа ещё нет в /api/tags — ollama pull;
    - затем короткий generate, чтобы веса оказались в RAM (и остальные модели выгружаются).
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
        installed = _get_installed_model_names()
        if model not in installed:
            pulled = True
            pull_log, last_pull_event, pull_console_lines = _ollama_pull_stream(model)
        warm_load = _warm_load_model_into_ram(model)
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ollama unavailable ({OLLAMA_BASE_URL}): {exc}") from exc
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
        data = _pause_one_model_ram(model)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ollama unavailable ({OLLAMA_BASE_URL}): {exc}") from exc
    return {"status": "ok", "model": model, "action": "pause", "ollama_response": data}


@app.post("/api/v1/models/delete")
def delete_model(payload: ModelActionRequest) -> dict[str, Any]:
    model = (payload.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    url = f"{OLLAMA_BASE_URL}/api/delete"
    try:
        with httpx.Client(timeout=120.0) as client:
            resp = client.post(url, json={"name": model})
            resp.raise_for_status()
            data = resp.json() if resp.content else {}
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ollama unavailable ({OLLAMA_BASE_URL}): {exc}") from exc
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
        raise HTTPException(status_code=502, detail=f"ollama http {e.response.status_code}: {e.response.text[:500]}") from e
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"ollama unreachable ({OLLAMA_BASE_URL}): {e}") from e


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
    Хвост stdout/stderr контейнера Ollama через `docker logs`.
    Нужны: docker CLI в образе и доступ к сокету Docker (см. docker-compose: volume docker.sock).
    """
    t = max(20, min(int(tail), 5000))
    name = OLLAMA_CONTAINER_NAME
    if not name:
        return {
            "available": False,
            "reason": "OLLAMA_CONTAINER_NAME пуст",
            "hint": "Укажите имя контейнера Ollama.",
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
