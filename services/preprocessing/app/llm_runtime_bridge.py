"""Ветвление HTTP к Ollama API vs vLLM OpenAI API для preprocessing."""

from __future__ import annotations

import json
from typing import Any

import httpx
from fastapi import HTTPException

from shared.llm_runtime.config import is_vllm, ollama_base_url, runtime_base_url


def pause_one_model_ram(model: str) -> dict[str, Any]:
    if is_vllm():
        return {}
    url = f"{ollama_base_url()}/api/generate"
    body = {"model": model, "prompt": "", "stream": False, "keep_alive": 0}
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(url, json=body)
        resp.raise_for_status()
        return resp.json() if resp.content else {}


def get_installed_model_names() -> set[str]:
    if is_vllm():
        url = f"{runtime_base_url()}/v1/models"
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()
        rows = data.get("data")
        out: set[str] = set()
        if isinstance(rows, list):
            for x in rows:
                if isinstance(x, dict):
                    n = str(x.get("id") or "").strip()
                    if n:
                        out.add(n)
        return out
    url = f"{ollama_base_url()}/api/tags"
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(url)
        resp.raise_for_status()
        data = resp.json()
    tags = data.get("models") if isinstance(data, dict) else []
    out2: set[str] = set()
    for x in tags if isinstance(tags, list) else []:
        if isinstance(x, dict):
            n = str(x.get("name") or "").strip()
            if n:
                out2.add(n)
    return out2


def ollama_pull_stream(model: str) -> tuple[list[str], dict[str, Any], list[str]]:
    if is_vllm():
        raise HTTPException(
            status_code=400,
            detail="pull не поддерживается при LLM_BACKEND=vllm: модель должна быть задана при запуске сервера vLLM.",
        )
    url = f"{ollama_base_url()}/api/pull"
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


def unload_other_running_ollama_models(keep_model: str) -> None:
    if is_vllm():
        return
    keep = (keep_model or "").strip()
    if not keep:
        return
    ps_url = f"{ollama_base_url()}/api/ps"
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
            pause_one_model_ram(name)
        except Exception:
            pass


def ready_probe() -> tuple[bool, str]:
    if is_vllm():
        url = f"{runtime_base_url()}/v1/models"
    else:
        url = f"{ollama_base_url()}/api/tags"
    try:
        with httpx.Client(timeout=3.0) as client:
            r = client.get(url)
            ok = r.status_code == 200
    except Exception:
        ok = False
    return ok, url


def fetch_running_models() -> dict[str, Any]:
    if is_vllm():
        url = f"{runtime_base_url()}/v1/models"
        try:
            with httpx.Client(timeout=8.0) as client:
                resp = client.get(url)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"vllm http {exc.response.status_code}: {exc.response.text[:500]}",
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"vllm unavailable ({runtime_base_url()}): {exc}",
            ) from exc
        rows = data.get("data") if isinstance(data, dict) else []
        running = [str((x or {}).get("id") or "").strip() for x in rows if isinstance(x, dict)]
        running = [x for x in running if x]
        return {"running_models": running, "ollama_ps": "vllm_models"}
    url = f"{ollama_base_url()}/api/ps"
    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(url)
            if resp.status_code == 404:
                return {"running_models": [], "ollama_ps": "unavailable"}
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"ollama unavailable ({ollama_base_url()}): {exc}",
        ) from exc
    models = data.get("models") if isinstance(data, dict) else []
    running = [str((x or {}).get("name") or "").strip() for x in models if isinstance(x, dict)]
    running = [x for x in running if x]
    return {"running_models": running}


def delete_model_request(model: str) -> dict[str, Any]:
    if is_vllm():
        raise HTTPException(
            status_code=501,
            detail="Удаление образа модели не поддерживается при LLM_BACKEND=vllm (модель задаётся при старте сервера).",
        )
    url = f"{ollama_base_url()}/api/delete"
    with httpx.Client(timeout=120.0) as client:
        resp = client.post(url, json={"name": model})
        resp.raise_for_status()
        return resp.json() if resp.content else {}
