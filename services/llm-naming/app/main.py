from __future__ import annotations

import os
import re

from fastapi import FastAPI
from pydantic import BaseModel

from app.ollama_client import OLLAMA_BASE_URL, ollama_generate_simple

app = FastAPI(title="LLM naming", version="0.2.0")

OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:8b")


class SuggestRequest(BaseModel):
    description: str


def _stub_suggest(description: str) -> str:
    prefix = description.split(" ", 1)[0].upper() if description else "ITEM"
    return f"NEW_CLASS_{prefix}"


def _normalize_class_token(text: str) -> str:
    line = (text or "").strip().split("\n")[0].strip()
    line = re.sub(r"^[\"']|[\"']$", "", line)
    token = "".join(c if (c.isalnum() or c in "_-") else "_" for c in line[:48])
    token = re.sub(r"_+", "_", token).strip("_")
    return token or "CLASS"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "llm-naming"}


@app.post("/api/v1/suggest-class-name")
def suggest_class_name(payload: SuggestRequest) -> dict[str, str]:
    desc = (payload.description or "").strip()
    if not desc:
        return {"suggested_class_name": "EMPTY", "mode": "stub"}

    prompt = (
        "Дай одно краткое имя класса товара: латиница, цифры и подчёркивание, до 40 символов. "
        "Только токен, без кавычек и пояснений.\n\n"
        f"Описание:\n{desc[:4000]}"
    )

    try:
        data = ollama_generate_simple(OLLAMA_MODEL, prompt, num_predict=160, num_ctx=4096, temperature=0.0)
        raw = (data.get("response") or "").strip()
        token = _normalize_class_token(raw)
        return {"suggested_class_name": token, "mode": "ollama", "ollama_base_url": OLLAMA_BASE_URL}
    except Exception:
        return {"suggested_class_name": _stub_suggest(desc), "mode": "stub_fallback"}
