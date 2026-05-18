from __future__ import annotations

import hashlib
import math
import os
import threading
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
CACHE_MAX_ITEMS = max(1, int(os.getenv("SEMANTIC_SEARCH_EMBED_CACHE_MAX_ITEMS", "12")))
EMBED_BATCH_SIZE = max(1, int(os.getenv("SEMANTIC_SEARCH_EMBED_BATCH_SIZE", "32")))
DEFAULT_S0 = float(os.getenv("SEMANTIC_SEARCH_NEIGHBOR_FLOOR_S0", "0.35"))
DEFAULT_TAU2 = float(os.getenv("SEMANTIC_SEARCH_SUPPORT_THRESHOLD_TAU2", "0.55"))
# Степень γ для веса соседа: w_i = max(0, s_i - s0)^γ (γ=1 — линейно, как раньше; γ>1 — сильнее тянет решение к более похожим эталонам).
# По смыслу близко к distance-weighted kNN (Dudani, 1976) и к ядрам K(d) на расстоянии до соседа; здесь маржа (s_i-s0) монотонна отступу по косинусу.
DEFAULT_WEIGHT_GAMMA = float(os.getenv("SEMANTIC_SEARCH_NEIGHBOR_WEIGHT_GAMMA", "2"))
EPS = float(os.getenv("SEMANTIC_SEARCH_SUPPORT_EPSILON", "1e-9"))

_encoder: SentenceTransformer | None = None
_encoder_lock = threading.Lock()
_passage_emb_cache: dict[str, np.ndarray] = {}
_passage_emb_cache_order: list[str] = []
_cache_lock = threading.Lock()


def _get_encoder() -> SentenceTransformer:
    global _encoder
    if _encoder is None:
        with _encoder_lock:
            if _encoder is None:
                _encoder = SentenceTransformer(E5_MODEL_NAME)
    return _encoder


def _encode_queries(encoder: SentenceTransformer, query: str) -> np.ndarray:
    arr = encoder.encode(
        [f"query: {query}"],
        normalize_embeddings=True,
        show_progress_bar=False,
        batch_size=EMBED_BATCH_SIZE,
    )
    if isinstance(arr, np.ndarray):
        return arr.astype(np.float32, copy=False)
    return np.array(arr, dtype=np.float32)


def _encode_passages(encoder: SentenceTransformer, passages: list[str]) -> np.ndarray:
    if not passages:
        return np.zeros((0, 0), dtype=np.float32)
    arr = encoder.encode(
        [f"passage: {p}" for p in passages],
        normalize_embeddings=True,
        show_progress_bar=False,
        batch_size=EMBED_BATCH_SIZE,
    )
    if isinstance(arr, np.ndarray):
        return arr.astype(np.float32, copy=False)
    return np.array(arr, dtype=np.float32)


def _resolve_passage_matrix(
    encoder: SentenceTransformer,
    rule_id: str | None,
    valid: list[tuple[str, str]],
    valid_emb: list[list[float] | None],
) -> tuple[np.ndarray, dict[str, Any]]:
    """
    Матрица эмбеддингов эталонов: из БД, из in-memory кэша или досчёт только отсутствующих строк.
    """
    n = len(valid)
    n_from_db = sum(1 for e in valid_emb if e is not None)
    missing_idx = [i for i, e in enumerate(valid_emb) if e is None]
    memory_cache_hit = False

    if not missing_idx:
        pv = np.array(valid_emb, dtype=np.float32)
        return pv, {
            "n_from_db": n_from_db,
            "n_encoded": 0,
            "memory_cache_hit": True,
            "service_mode": "reference_embeddings_precomputed",
        }

    if len(missing_idx) == n:
        cache_key = _make_passage_cache_key(rule_id, valid)
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached, {
                "n_from_db": 0,
                "n_encoded": 0,
                "memory_cache_hit": True,
                "service_mode": "reference_embeddings",
            }

    if missing_idx:
        passages_missing = [valid[i][0] for i in missing_idx]
        encoded = _encode_passages(encoder, passages_missing)
        for j, i in enumerate(missing_idx):
            valid_emb[i] = encoded[j].tolist()

    pv = np.array(valid_emb, dtype=np.float32)
    if len(missing_idx) == n:
        _cache_set(_make_passage_cache_key(rule_id, valid), pv)
    mode = "reference_embeddings_precomputed"
    if missing_idx and n_from_db:
        mode = "reference_embeddings_mixed"
    elif missing_idx:
        mode = "reference_embeddings"
    return pv, {
        "n_from_db": n_from_db,
        "n_encoded": len(missing_idx),
        "memory_cache_hit": memory_cache_hit,
        "service_mode": mode,
    }


def _knn_search_result(
    payload: SearchRequest,
    valid: list[tuple[str, str]],
    qv: np.ndarray,
    pv: np.ndarray,
    *,
    meta: dict[str, Any],
) -> dict[str, Any]:
    sims = (qv @ pv.T).flatten()
    n_all = len(valid)
    knn_k = max(1, min(int(payload.knn_k or 3), n_all))
    topk_idx = np.argsort(sims)[::-1][:knn_k]
    s0 = payload.neighbor_similarity_floor_s0 if payload.neighbor_similarity_floor_s0 is not None else DEFAULT_S0
    gamma = _effective_weight_gamma(payload)
    tau1 = payload.similarity_threshold
    tau2 = payload.support_threshold_tau2 if payload.support_threshold_tau2 is not None else DEFAULT_TAU2
    class_id, best_sim, support_p, knn_neighbors = _knn_winner_support_and_neighbors(
        topk_idx, sims, valid, s0=s0, gamma=gamma
    )
    matched = bool(
        class_id
        and best_sim > float(tau1 if tau1 is not None else -1.0)
        and support_p > float(tau2)
    )
    query = (payload.description or "").strip()
    keep_n = min(n_all, SPACE_MAX_POINTS)
    top_idx = np.argsort(sims)[::-1][:keep_n]
    feature_space_points, feature_space_projection = _build_feature_space_points(
        query_text=query,
        valid=valid,
        sims=sims,
        top_idx=top_idx,
        q_emb=qv,
        p_emb=pv,
    )
    service_mode = str(meta.get("service_mode") or "reference_embeddings")
    n_db = int(meta.get("n_from_db") or 0)
    n_enc = int(meta.get("n_encoded") or 0)
    if service_mode == "reference_embeddings_precomputed":
        note_ru = (
            "Класс по kNN на предрасчитанных эмбеддингах из БД; "
            f"V_best={best_sim:.3f}, P={support_p:.3f}."
        )
    elif service_mode == "reference_embeddings_mixed":
        note_ru = (
            f"kNN: из БД {n_db} эталон(ов), досчитано {n_enc}; "
            f"V_best={best_sim:.3f}, P={support_p:.3f}."
        )
    else:
        note_ru = (
            f"Векторный поиск по эталонам (модель {E5_MODEL_NAME}): "
            f"kNN (k={knn_k}), досчитано эталонов: {n_enc}; "
            f"V_best={best_sim:.3f}, P={support_p:.3f}."
        )
    return {
        "matched": matched,
        "similarity": best_sim,
        "class_id": class_id,
        "similarity_threshold_echo": payload.similarity_threshold,
        "threshold_tau1": tau1,
        "threshold_tau2": tau2,
        "neighbor_similarity_floor_s0": s0,
        "neighbor_weight_gamma": gamma,
        "support_p": support_p,
        "rule_id": payload.rule_id,
        "service_mode": service_mode,
        "note_ru": note_ru,
        "embedding_model": E5_MODEL_NAME,
        "n_reference_examples_total": len(payload.reference_examples or []),
        "n_reference_examples_used": len(valid),
        "n_embeddings_from_db": n_db,
        "n_embeddings_computed": n_enc,
        "best_example_index": int(topk_idx[0]) if len(topk_idx) else 0,
        "knn_k": knn_k,
        "knn_neighbors": knn_neighbors,
        "feature_space_points": feature_space_points,
        "feature_space_projection": feature_space_projection,
        "feature_space_points_total": len(feature_space_points),
        "embeddings_cache_hit": bool(meta.get("memory_cache_hit")) or n_enc == 0,
    }


def _make_passage_cache_key(rule_id: str | None, valid: list[tuple[str, str]]) -> str:
    h = hashlib.sha1()
    h.update((rule_id or "").encode("utf-8", errors="ignore"))
    h.update(b"|")
    h.update(E5_MODEL_NAME.encode("utf-8", errors="ignore"))
    h.update(b"|")
    for desc, cid in valid:
        h.update(cid.encode("utf-8", errors="ignore"))
        h.update(b":")
        h.update(desc.encode("utf-8", errors="ignore"))
        h.update(b"\n")
    return h.hexdigest()


def _cache_get(key: str) -> np.ndarray | None:
    with _cache_lock:
        arr = _passage_emb_cache.get(key)
        if arr is None:
            return None
        if key in _passage_emb_cache_order:
            _passage_emb_cache_order.remove(key)
        _passage_emb_cache_order.append(key)
        return arr


def _cache_set(key: str, value: np.ndarray) -> None:
    with _cache_lock:
        _passage_emb_cache[key] = value
        if key in _passage_emb_cache_order:
            _passage_emb_cache_order.remove(key)
        _passage_emb_cache_order.append(key)
        while len(_passage_emb_cache_order) > CACHE_MAX_ITEMS:
            old = _passage_emb_cache_order.pop(0)
            _passage_emb_cache.pop(old, None)


class ReferenceExampleIn(BaseModel):
    """Один эталонный пример (текст, класс, опциональный эмбеддинг)."""

    description_text: str = ""
    assigned_class_id: str = ""
    embedding: list[float] | None = None


class SearchRequest(BaseModel):
    """Запрос семантического поиска класса по kNN среди эталонов."""

    description: str
    tnved_code: str | None = None
    similarity_threshold: float | None = None
    knn_k: int = Field(default=3, ge=1, le=25, description="k для выбора класса по kNN среди ближайших эталонов")
    neighbor_similarity_floor_s0: float | None = Field(
        default=None,
        ge=-1.0,
        le=1.0,
        description="Порог соседства s0: вклад соседей с sim<=s0 обнуляется.",
    )
    neighbor_weight_gamma: float | None = Field(
        default=None,
        ge=1.0,
        le=32.0,
        description="Показатель степени для веса: w=max(0,s-s0)^γ (γ=1 — линейный вес по отступу от s0).",
    )
    support_threshold_tau2: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Порог по P(c)=V_best(c)·V_w(c)/(ε+Σ w_j) — связка (30) и нормировки (31); см. /api/v1/search."
        ),
    )
    rule_id: str | None = None
    reference_examples: list[ReferenceExampleIn] | None = Field(
        default=None,
        description="Эталоны из БД; при непустом списке с текстами — векторный поиск.",
    )


class EmbedRequest(BaseModel):
    """Запрос пакетного построения эмбеддингов текстов."""

    texts: list[str] = Field(default_factory=list)
    use_query_prefix: bool = Field(
        default=False,
        description="True — префикс «query:», как у описания декларации в /api/v1/search; иначе «passage:» (эталоны).",
    )


def _neighbor_vote_weight(sim: float, s0: float, gamma: float) -> float:
    margin = max(0.0, float(sim) - float(s0))
    if margin <= 0.0:
        return 0.0
    g = float(gamma)
    if not math.isfinite(g) or g < 1.0:
        g = 1.0
    return float(margin**g)


def _effective_weight_gamma(payload: SearchRequest) -> float:
    raw = payload.neighbor_weight_gamma
    if raw is None:
        return DEFAULT_WEIGHT_GAMMA
    g = float(raw)
    if not math.isfinite(g):
        return DEFAULT_WEIGHT_GAMMA
    return max(1.0, min(g, 32.0))


def _knn_winner_support_and_neighbors(
    topk_idx: np.ndarray,
    sims: np.ndarray,
    valid: list[tuple[str, str]],
    *,
    s0: float,
    gamma: float,
) -> tuple[str | None, float, float, list[dict[str, Any]]]:
    """
    kNN по эталонам (согласовано с обозначениями в тексте диплома):

    - V_w(c) = Σ_{i∈N_k} 1[c_i=c]·w_i — суммарная взвешенная поддержка класса c;
    - V_best(c) = max_{i∈N_k, c_i=c} s_i — лучшая косинусная близость среди соседей класса c;
    - P_0(c) = V_w(c) / (ε + Σ_{j∈N_k} w_j) — нормированная весовая поддержка (как в (31));
    - P(c) = V_best(c) · P_0(c). Тогда P(c) ≤ V_best(c), так как P_0(c) ≤ 1.

    Вес соседа w_i = max(0, s_i − s_0)^γ. Класс c^ выбирают по наибольшему V_w(c) среди классов
    (при равенстве — по числу соседей и V_best). В API поле «similarity» = V_best(c^), «support_p» = P(c^).
    """
    votes: dict[str, dict[str, float]] = {}
    total_weight = 0.0
    knn_neighbors: list[dict[str, Any]] = []
    for idx in topk_idx:
        i = int(idx)
        cid = valid[i][1]
        sim = float(sims[i])
        w = _neighbor_vote_weight(sim, s0, gamma)
        total_weight += w
        bucket = votes.setdefault(cid, {"vw": 0.0, "count": 0.0, "best": -1.0})
        bucket["vw"] += w
        bucket["count"] += 1.0
        if sim > bucket["best"]:
            bucket["best"] = sim
        knn_neighbors.append(
            {
                "index": i,
                "class_id": cid,
                "similarity": sim,
                "weight": float(w),
                "description_text": valid[i][0],
            }
        )
    if not votes:
        return None, 0.0, 0.0, knn_neighbors
    class_id = sorted(
        votes.keys(),
        key=lambda c: (
            -(votes[c]["vw"] / (total_weight + EPS)),
            -votes[c]["count"],
            -votes[c]["best"],
            c,
        ),
    )[0]
    best_sim = float(votes[class_id]["best"])
    vw = float(votes[class_id]["vw"])
    support_p = float(best_sim * vw / (total_weight + EPS))
    return class_id, best_sim, support_p, knn_neighbors


def _stub_response(payload: SearchRequest, *, service_mode: str, note_ru: str) -> dict[str, Any]:
    matched = payload.tnved_code is not None and str(payload.tnved_code).startswith("27")
    similarity = 0.91 if matched else 0.41
    thr = payload.similarity_threshold
    tau1 = payload.similarity_threshold
    tau2 = payload.support_threshold_tau2 if payload.support_threshold_tau2 is not None else DEFAULT_TAU2
    s0 = payload.neighbor_similarity_floor_s0 if payload.neighbor_similarity_floor_s0 is not None else DEFAULT_S0
    gamma = _effective_weight_gamma(payload)
    w_stub = _neighbor_vote_weight(similarity, s0, gamma)
    support_p_stub = float(similarity * w_stub / (w_stub + EPS)) if w_stub > 0.0 else 0.0
    return {
        "matched": matched,
        "similarity": similarity,
        "class_id": "CLASS-27-STUB" if matched else None,
        "similarity_threshold_echo": thr,
        "threshold_tau1": tau1,
        "threshold_tau2": tau2,
        "neighbor_similarity_floor_s0": s0,
        "neighbor_weight_gamma": gamma,
        "support_p": support_p_stub if matched else 0.0,
        "rule_id": payload.rule_id,
        "service_mode": service_mode,
        "note_ru": note_ru,
        "embedding_model": None,
        "n_reference_examples_total": 0,
        "n_reference_examples_used": 0,
        "feature_space_points": [],
        "knn_k": int(payload.knn_k or 3),
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


def _classical_mds_pcoa(D2: np.ndarray, n_components: int = 2) -> np.ndarray | None:
    """
    Классическое (метрическое) MDS / PCoA по матрице квадратов расстояний.
    Для L2-нормированных эмбеддингов D2_ij = 2(1 - cos_ij) согласовано с косинусной метрикой.
    Возвращает (n, n_components) или None при вырожденности.
    """
    n = int(D2.shape[0])
    if n <= 0:
        return np.zeros((0, n_components), dtype=np.float32)
    if n == 1:
        return np.zeros((1, n_components), dtype=np.float32)
    D2 = np.asarray(D2, dtype=np.float64)
    J = np.eye(n, dtype=np.float64) - np.ones((n, n), dtype=np.float64) / n
    B = -0.5 * (J @ D2 @ J)
    w, V = np.linalg.eigh(B)
    coords = np.zeros((n, n_components), dtype=np.float64)
    taken = 0
    for j in range(n - 1, -1, -1):
        lam = float(w[j])
        if lam <= 1e-11:
            continue
        coords[:, taken] = V[:, j] * math.sqrt(max(lam, 0.0))
        taken += 1
        if taken >= n_components:
            break
    if taken == 0:
        return None
    return coords.astype(np.float32)


def _layout_embeddings_2d(stack: np.ndarray) -> tuple[np.ndarray, str]:
    """
    stack: (m, d), строка 0 — эмбеддинг запроса; все строки L2-нормированы.
    Возвращает координаты (m, 2) с запросом в начале координат и именем метода.
    """
    stack = np.asarray(stack, dtype=np.float64)
    if stack.ndim != 2 or stack.shape[0] == 0:
        return np.zeros((0, 2), dtype=np.float32), "empty"
    n = stack.shape[0]
    G = stack @ stack.T
    G = np.clip(G, -1.0, 1.0)
    D2 = np.maximum(2.0 * (1.0 - G), 0.0)
    mds = _classical_mds_pcoa(D2, 2)
    if mds is not None and np.all(np.isfinite(mds)):
        coords = mds.astype(np.float64)
        coords -= coords[0:1]
        method = "classical_mds_cosine"
    else:
        coords = _project_to_2d(stack.astype(np.float32)).astype(np.float64)
        coords -= coords[0:1]
        method = "pca_mean_centered_query_origin"
    if n > 1:
        tail = coords[1:]
        norms = np.linalg.norm(tail, axis=1)
        rmax = float(np.max(norms)) if norms.size else 0.0
        if rmax > 1e-9:
            coords = coords / rmax
    return coords.astype(np.float32), method


def _build_feature_space_points(
    *,
    query_text: str,
    valid: list[tuple[str, str]],
    sims: np.ndarray,
    top_idx: np.ndarray,
    q_emb: np.ndarray,
    p_emb: np.ndarray,
) -> tuple[list[dict[str, Any]], str]:
    """
    2D-карта по реальным эмбеддингам: классическое MDS по косинусной метрике
    (как PCoA для Gram-матрицы), без искусственного «круга по углам».
    """
    points: list[dict[str, Any]] = []
    n = int(len(top_idx))
    if n == 0:
        return (
            [
                {
                    "kind": "query",
                    "x": 0.0,
                    "y": 0.0,
                    "text": query_text,
                    "class_id": None,
                    "similarity": 1.0,
                }
            ],
            "trivial_query_only",
        )

    qv = np.asarray(q_emb, dtype=np.float32)
    if qv.ndim == 1:
        qv = qv.reshape(1, -1)
    pv = np.asarray(p_emb, dtype=np.float32)
    subset = pv[np.asarray(top_idx, dtype=np.intp)]
    stack = np.vstack([qv, subset])
    coords, method = _layout_embeddings_2d(stack)
    # Коррекция радиуса в 2D:
    # сохраняем направление из MDS, но расстояние от запроса задаём по реальной
    # косинусной дистанции d = sqrt(2 * (1 - sim)). Это убирает ситуации, когда
    # визуально "дальний" сосед выглядит ближе к запросу, чем "ближний".
    if coords.shape[0] > 1:
        qvec = qv[0]
        dots = np.clip((subset @ qvec).astype(np.float64, copy=False), -1.0, 1.0)
        target_r = np.sqrt(np.maximum(2.0 * (1.0 - dots), 0.0))
        rmax = float(np.max(target_r)) if target_r.size else 0.0
        if rmax > 1e-9:
            target_r_norm = target_r / rmax
            tail = coords[1:].astype(np.float64, copy=False)
            cur_norm = np.linalg.norm(tail, axis=1)
            for j in range(tail.shape[0]):
                if cur_norm[j] > 1e-9:
                    ux = tail[j, 0] / cur_norm[j]
                    uy = tail[j, 1] / cur_norm[j]
                else:
                    # Детерминированное направление для вырожденных случаев.
                    ang = 2.0 * math.pi * (j / max(1, tail.shape[0]))
                    ux, uy = math.cos(ang), math.sin(ang)
                tail[j, 0] = ux * target_r_norm[j]
                tail[j, 1] = uy * target_r_norm[j]
            coords[1:] = tail.astype(np.float32, copy=False)
            method = f"{method}+query_radius_cosine"

    points.append(
        {
            "kind": "query",
            "x": float(coords[0, 0]),
            "y": float(coords[0, 1]),
            "text": query_text,
            "class_id": None,
            "similarity": 1.0,
        }
    )
    for row, idx in enumerate(top_idx):
        i = int(idx)
        sim = float(sims[i])
        r = row + 1
        points.append(
            {
                "kind": "reference",
                "x": float(coords[r, 0]),
                "y": float(coords[r, 1]),
                "text": valid[i][0],
                "class_id": valid[i][1],
                "similarity": sim,
            }
        )
    return points, method


def _embedding_search(
    payload: SearchRequest,
    valid: list[tuple[str, str]],
    valid_emb: list[list[float] | None],
) -> dict[str, Any]:
    encoder = _get_encoder()
    query = (payload.description or "").strip()
    qv = _encode_queries(encoder, query)
    if qv.ndim == 2 and qv.shape[0] == 1:
        qv = qv[0]
    pv, meta = _resolve_passage_matrix(encoder, payload.rule_id, valid, valid_emb)
    return _knn_search_result(payload, valid, qv, pv, meta=meta)


@app.post("/api/v1/embed")
def embed(payload: EmbedRequest) -> dict[str, Any]:
    texts = [str(t or "").strip() for t in (payload.texts or []) if str(t or "").strip()]
    if not texts:
        return {"embedding_model": E5_MODEL_NAME, "vectors": []}
    if FORCE_STUB:
        return {"embedding_model": E5_MODEL_NAME, "vectors": [[0.0] * 8 for _ in texts]}
    encoder = _get_encoder()
    prefix = "query: " if payload.use_query_prefix else "passage: "
    arr = encoder.encode(
        [f"{prefix}{t}" for t in texts],
        normalize_embeddings=True,
        show_progress_bar=False,
        batch_size=EMBED_BATCH_SIZE,
    )
    if isinstance(arr, np.ndarray):
        out = arr.astype(np.float32, copy=False).tolist()
    else:
        out = np.array(arr, dtype=np.float32).tolist()
    return {"embedding_model": E5_MODEL_NAME, "vectors": out}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "semantic-search"}


@app.on_event("startup")
def _warmup_encoder() -> None:
    if FORCE_STUB:
        return
    def _bg_warmup() -> None:
        try:
            encoder = _get_encoder()
            # Прогреваем первый инференс заранее, чтобы избежать холодного старта в запросе инспектора.
            encoder.encode(["query: warmup"], normalize_embeddings=True, show_progress_bar=False)
        except Exception:
            # Не останавливаем сервис: резервная логика сработает во время обработки запроса.
            pass

    # Важно: прогрев не должен блокировать запуск и проверку доступности сервиса.
    threading.Thread(target=_bg_warmup, daemon=True).start()


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
    valid_emb: list[list[float] | None] = []
    for ex in raw_list:
        desc = (ex.description_text or "").strip()
        cid = (ex.assigned_class_id or "").strip()
        if desc and cid:
            valid.append((desc, cid))
            emb = ex.embedding if isinstance(ex.embedding, list) and len(ex.embedding) > 0 else None
            valid_emb.append(emb)

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
        return _embedding_search(payload, valid, valid_emb)
    except Exception as exc:
        return _stub_response(
            payload,
            service_mode="stub_embedding_error",
            note_ru=(
                f"Ошибка расчёта эмбеддингов ({exc!s}); для прохождения пайплайна подставлены значения заглушки. "
                "Проверьте логи semantic-search и доступность модели."
            ),
        )
