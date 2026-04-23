from __future__ import annotations

import os
from typing import Any

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

app = FastAPI(title="Semantic search", version="0.2.0")

E5_MODEL_NAME = os.getenv("SEMANTIC_SEARCH_EMBEDDING_MODEL", "intfloat/multilingual-e5-base")
# Для тестов: всегда вести себя как старая заглушка (игнор эталонов).
FORCE_STUB = os.getenv("SEMANTIC_SEARCH_FORCE_STUB", "").strip().lower() in ("1", "true", "yes")
SPACE_MAX_POINTS = max(20, int(os.getenv("SEMANTIC_SEARCH_SPACE_MAX_POINTS", "250")))

_encoder: SentenceTransformer | None = None


def _get_encoder() -> SentenceTransformer:
    global _encoder
    if _encoder is None:
        _encoder = SentenceTransformer(E5_MODEL_NAME)
    return _encoder


class ReferenceExampleIn(BaseModel):
    description_text: str = ""
    assigned_class_id: str = ""


class SearchRequest(BaseModel):
    description: str
    tnved_code: str | None = None
    similarity_threshold: float | None = None
    rule_id: str | None = None
    reference_examples: list[ReferenceExampleIn] | None = Field(
        default=None,
        description="Эталоны из БД; при непустом списке с текстами — векторный поиск.",
    )


def _stub_response(payload: SearchRequest, *, service_mode: str, note_ru: str) -> dict[str, Any]:
    matched = payload.tnved_code is not None and str(payload.tnved_code).startswith("27")
    similarity = 0.91 if matched else 0.41
    thr = payload.similarity_threshold
    return {
        "matched": matched,
        "similarity": similarity,
        "class_id": "CLASS-27-STUB" if matched else None,
        "similarity_threshold_echo": thr,
        "rule_id": payload.rule_id,
        "service_mode": service_mode,
        "note_ru": note_ru,
        "embedding_model": None,
        "n_reference_examples_total": 0,
        "n_reference_examples_used": 0,
        "feature_space_points": [],
    }


def _project_to_2d(emb: np.ndarray) -> np.ndarray:
    """PCA до 2D через SVD; на выходе shape (n,2)."""
    if emb.ndim != 2 or emb.shape[0] == 0:
        return np.zeros((0, 2), dtype=np.float32)
    x = emb.astype(np.float32, copy=False)
    x = x - np.mean(x, axis=0, keepdims=True)
    if x.shape[0] == 1:
        return np.array([[0.0, 0.0]], dtype=np.float32)
    u, s, _vt = np.linalg.svd(x, full_matrices=False)
    k = min(2, u.shape[1])
    out = np.zeros((x.shape[0], 2), dtype=np.float32)
    out[:, :k] = u[:, :k] * s[:k]
    return out


def _embedding_search(payload: SearchRequest, valid: list[tuple[str, str]]) -> dict[str, Any]:
    """
    valid: list of (description_text, assigned_class_id)
    """
    encoder = _get_encoder()
    query = (payload.description or "").strip()
    passages = [t for t, _ in valid]
    q_emb = encoder.encode([f"query: {query}"], normalize_embeddings=True, show_progress_bar=False)
    p_emb = encoder.encode([f"passage: {p}" for p in passages], normalize_embeddings=True, show_progress_bar=False)
    if isinstance(q_emb, np.ndarray):
        qv = q_emb.astype(np.float32, copy=False)
    else:
        qv = np.array(q_emb, dtype=np.float32)
    if isinstance(p_emb, np.ndarray):
        pv = p_emb.astype(np.float32, copy=False)
    else:
        pv = np.array(p_emb, dtype=np.float32)
    sims = (qv @ pv.T).flatten()
    best_i = int(np.argmax(sims))
    best_sim = float(sims[best_i])
    class_id = valid[best_i][1]
    # Для визуализации пространства: ограничиваем число точек самыми похожими к запросу.
    n_all = len(valid)
    keep_n = min(n_all, SPACE_MAX_POINTS)
    top_idx = np.argsort(sims)[::-1][:keep_n]
    kept_emb = pv[top_idx]
    proj_input = np.vstack([qv[0:1], kept_emb])
    xy = _project_to_2d(proj_input)
    feature_space_points: list[dict[str, Any]] = [
        {
            "kind": "query",
            "x": float(xy[0, 0]),
            "y": float(xy[0, 1]),
            "text": query,
            "class_id": None,
            "similarity": 1.0,
        }
    ]
    for k, idx in enumerate(top_idx, start=1):
        feature_space_points.append(
            {
                "kind": "reference",
                "x": float(xy[k, 0]),
                "y": float(xy[k, 1]),
                "text": valid[int(idx)][0],
                "class_id": valid[int(idx)][1],
                "similarity": float(sims[int(idx)]),
            }
        )
    thr = payload.similarity_threshold
    return {
        "matched": True,
        "similarity": best_sim,
        "class_id": class_id,
        "similarity_threshold_echo": thr,
        "rule_id": payload.rule_id,
        "service_mode": "reference_embeddings",
        "note_ru": (
            f"Векторный поиск по эталонам справочника (модель {E5_MODEL_NAME}): "
            f"взята ближайшая по косинусной схожести запись эталона и её класс."
        ),
        "embedding_model": E5_MODEL_NAME,
        "n_reference_examples_total": len(payload.reference_examples or []),
        "n_reference_examples_used": len(valid),
        "best_example_index": best_i,
        "feature_space_points": feature_space_points,
        "feature_space_points_total": n_all + 1,  # + запрос инспектора
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "semantic-search"}


@app.post("/api/v1/search")
def search(payload: SearchRequest) -> dict[str, object]:
    if FORCE_STUB:
        return _stub_response(
            payload,
            service_mode="stub_forced",
            note_ru="Режим принудительной заглушки (SEMANTIC_SEARCH_FORCE_STUB): для тестов без эмбеддингов.",
        )

    raw_list = payload.reference_examples or []
    valid: list[tuple[str, str]] = []
    for ex in raw_list:
        desc = (ex.description_text or "").strip()
        cid = (ex.assigned_class_id or "").strip()
        if desc and cid:
            valid.append((desc, cid))

    if not valid:
        return _stub_response(
            payload,
            service_mode="stub_no_reference_data",
            note_ru=(
                "Нет эталонов с текстом описания в БД для этого справочника — используется тестовая заглушка "
                "(схожесть и класс не из реальных эмбеддингов). Добавьте эталоны в датасет справочника."
            ),
        )

    try:
        return _embedding_search(payload, valid)
    except Exception as exc:
        return _stub_response(
            payload,
            service_mode="stub_embedding_error",
            note_ru=(
                f"Ошибка расчёта эмбеддингов ({exc!s}); для прохождения пайплайна подставлены значения заглушки. "
                "Проверьте логи semantic-search и доступность модели."
            ),
        )
