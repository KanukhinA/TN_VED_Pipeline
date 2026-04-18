from __future__ import annotations

import os
import re
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.ollama_client import OLLAMA_BASE_URL, ollama_generate_simple, ollama_list_models

app = FastAPI(title="LLM naming", version="0.3.0")

OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:8b")


class ClassLabelEntry(BaseModel):
    class_id: str = ""
    title: str = ""


class SuggestRequest(BaseModel):
    """Соответствует ветке Mod6 README: описание, ТН ВЭД, перечень классов справочника."""

    description: str
    tnved_code: str | None = None
    existing_classes: list[str] = Field(default_factory=list)
    existing_class_labels: list[ClassLabelEntry] = Field(default_factory=list)


def _normalize_class_token(text: str) -> str:
    line = (text or "").strip().split("\n")[0].strip()
    line = re.sub(r"^[\"']|[\"']$", "", line)
    token = "".join(c if (c.isalnum() or c in "_-") else "_" for c in line[:48])
    token = re.sub(r"_+", "_", token).strip("_")
    return token or "CLASS"


def _format_existing_catalog(labels: list[ClassLabelEntry], raw_ids: list[str]) -> str:
    lines: list[str] = []
    if labels:
        for e in labels:
            cid = (e.class_id or "").strip()
            if not cid:
                continue
            t = (e.title or "").strip()
            lines.append(f"- {cid}" + (f" — {t}" if t else ""))
    elif raw_ids:
        for x in raw_ids:
            s = str(x).strip()
            if s:
                lines.append(f"- {s}")
    return "\n".join(lines) if lines else "(в справочнике пока нет классов — придумайте новый идентификатор)"


def _build_prompt(payload: SuggestRequest) -> str:
    desc = (payload.description or "").strip()
    tn = (payload.tnved_code or "").strip() or "—"
    catalog_block = _format_existing_catalog(payload.existing_class_labels, payload.existing_classes)
    return (
        "Ты помогаешь завести имя нового класса товара в таможенном справочнике.\n"
        "Ниже — описание товара, для которого детерминированная классификация не выбрала класс "
        "(или сработала ветка низкой семантической схожести).\n"
        "Учти код ТН ВЭД и не повторяй уже существующие идентификаторы классов.\n\n"
        f"Код ТН ВЭД (фрагмент или полный): {tn}\n\n"
        "Уже существующие классы по этому справочнику:\n"
        f"{catalog_block}\n\n"
        "Описание товара неизвестного класса:\n"
        f"{desc[:8000]}\n\n"
        "Ответ: одна строка — краткий идентификатор класса: латиница, цифры и подчёркивание, до 40 символов. "
        "Без кавычек, без пояснений и без markdown."
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "llm-naming"}


@app.post("/api/v1/suggest-class-name")
def suggest_class_name(payload: SuggestRequest) -> dict[str, Any]:
    desc = (payload.description or "").strip()
    if not desc:
        return {"suggested_class_name": "EMPTY", "mode": "empty_input", "requires_expert_confirmation": True}

    prompt = _build_prompt(payload)
    prompt_meta = {
        "description_excerpt": desc[:400],
        "tnved_code": payload.tnved_code,
        "existing_classes_count": len(payload.existing_classes or []) + len(payload.existing_class_labels or []),
    }
    attempted_models: list[str] = []
    errors: list[str] = []

    candidate_models = [OLLAMA_MODEL.strip()] if OLLAMA_MODEL.strip() else []
    try:
        for name in ollama_list_models():
            if name and name not in candidate_models:
                candidate_models.append(name)
    except Exception as exc:
        errors.append(f"model_discovery_failed: {exc}")

    for model_name in candidate_models:
        attempted_models.append(model_name)
        try:
            data = ollama_generate_simple(model_name, prompt, num_predict=160, num_ctx=4096, temperature=0.0)
            raw = (data.get("response") or "").strip()
            token = _normalize_class_token(raw)
            return {
                "suggested_class_name": token,
                "mode": "ollama",
                "model": model_name,
                "ollama_base_url": OLLAMA_BASE_URL,
                "requires_expert_confirmation": True,
                "prompt_includes": prompt_meta,
            }
        except Exception as exc:
            errors.append(f"{model_name}: {exc}")

    return {
        "suggested_class_name": "GENERATION_FAILED",
        "mode": "error",
        "error": "Unable to generate class name with available Ollama models.",
        "attempted_models": attempted_models,
        "errors": errors[:5],
        "requires_expert_confirmation": True,
        "prompt_includes": prompt_meta,
    }
