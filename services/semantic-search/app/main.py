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
DEFAULT_S0 = float(os.getenv("SEMANTIC_SEARCH_NEIGHBOR_FLOOR_S0", "0.35"))
DEFAULT_TAU2 = float(os.getenv("SEMANTIC_SEARCH_SUPPORT_THRESHOLD_TAU2", "0.55"))
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
    description_text: str = ""
    assigned_class_id: str = ""
    embedding: list[float] | None = None


class SearchRequest(BaseModel):
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
    support_threshold_tau2: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Порог нормированной поддержки P(c^) для принятия класса.",
    )
    rule_id: str | None = None
    reference_examples: list[ReferenceExampleIn] | None = Field(
        default=None,
        description="Эталоны из БД; при непустом списке с текстами — векторный поиск.",
    )


class EmbedRequest(BaseModel):
    texts: list[str]


def _stub_response(payload: SearchRequest, *, service_mode: str, note_ru: str) -> dict[str, Any]:
    matched = payload.tnved_code is not None and str(payload.tnved_code).startswith("27")
    similarity = 0.91 if matched else 0.41
    thr = payload.similarity_threshold
    tau1 = payload.similarity_threshold
    tau2 = payload.support_threshold_tau2 if payload.support_threshold_tau2 is not None else DEFAULT_TAU2
    s0 = payload.neighbor_similarity_floor_s0 if payload.neighbor_similarity_floor_s0 is not None else DEFAULT_S0
    return {
        "matched": matched,
        "similarity": similarity,
        "class_id": "CLASS-27-STUB" if matched else None,
        "similarity_threshold_echo": thr,
        "threshold_tau1": tau1,
        "threshold_tau2": tau2,
        "neighbor_similarity_floor_s0": s0,
        "support_p": 1.0 if matched else 0.0,
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


def _embedding_search(payload: SearchRequest, valid: list[tuple[str, str]]) -> dict[str, Any]:
    """
    valid: list of (description_text, assigned_class_id)
    """
    encoder = _get_encoder()
    query = (payload.description or "").strip()
    passages = [t for t, _ in valid]
    q_emb = encoder.encode([f"query: {query}"], normalize_embeddings=True, show_progress_bar=False)
    cache_key = _make_passage_cache_key(payload.rule_id, valid)
    p_emb = _cache_get(cache_key)
    cache_hit = p_emb is not None
    if p_emb is None:
        p_emb = encoder.encode([f"passage: {p}" for p in passages], normalize_embeddings=True, show_progress_bar=False)
    if isinstance(q_emb, np.ndarray):
        qv = q_emb.astype(np.float32, copy=False)
    else:
        qv = np.array(q_emb, dtype=np.float32)
    if isinstance(p_emb, np.ndarray):
        pv = p_emb.astype(np.float32, copy=False)
    else:
        pv = np.array(p_emb, dtype=np.float32)
    if not cache_hit:
        _cache_set(cache_key, pv)
    sims = (qv @ pv.T).flatten()
    n_all = len(valid)
    knn_k = max(1, min(int(payload.knn_k or 3), n_all))
    topk_idx = np.argsort(sims)[::-1][:knn_k]

    # Взвешивание соседей: w_i = max(0, s_i - s0)
    s0 = payload.neighbor_similarity_floor_s0 if payload.neighbor_similarity_floor_s0 is not None else DEFAULT_S0
    tau1 = payload.similarity_threshold
    tau2 = payload.support_threshold_tau2 if payload.support_threshold_tau2 is not None else DEFAULT_TAU2
    votes: dict[str, dict[str, float]] = {}
    total_weight = 0.0
    for idx in topk_idx:
        cid = valid[int(idx)][1]
        sim = float(sims[int(idx)])
        w = max(0.0, sim - s0)
        total_weight += w
        bucket = votes.setdefault(cid, {"vw": 0.0, "count": 0.0, "best": -1.0})
        bucket["vw"] += w
        bucket["count"] += 1.0
        if sim > bucket["best"]:
            bucket["best"] = sim
    class_id = sorted(
        votes.keys(),
        key=lambda cid: (
            -(votes[cid]["vw"] / (total_weight + EPS)),
            -votes[cid]["count"],
            -votes[cid]["best"],
            cid,
        ),
    )[0]
    best_sim = float(votes[class_id]["best"])
    support_p = float(votes[class_id]["vw"] / (total_weight + EPS))
    matched = bool(best_sim > float(tau1 if tau1 is not None else -1.0) and support_p > float(tau2))
    # Для визуализации пространства: ограничиваем число точек самыми похожими к запросу.
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
    thr = payload.similarity_threshold
    return {
        "matched": matched,
        "similarity": best_sim,
        "class_id": class_id,
        "similarity_threshold_echo": thr,
        "threshold_tau1": tau1,
        "threshold_tau2": tau2,
        "neighbor_similarity_floor_s0": s0,
        "support_p": support_p,
        "rule_id": payload.rule_id,
        "service_mode": "reference_embeddings",
        "note_ru": (
            f"Векторный поиск по эталонам справочника (модель {E5_MODEL_NAME}): "
            f"класс выбран по kNN (k={knn_k}) с отсечением слабых соседей (s0={s0:.3f}), "
            f"нормированной поддержкой P(c)={support_p:.3f} и двойным критерием (τ1={float(tau1 if tau1 is not None else -1.0):.3f}, τ2={tau2:.3f})."
        ),
        "embedding_model": E5_MODEL_NAME,
        "n_reference_examples_total": len(payload.reference_examples or []),
        "n_reference_examples_used": len(valid),
        "best_example_index": int(topk_idx[0]),
        "knn_k": knn_k,
        "knn_neighbors": [
            {
                "index": int(idx),
                "class_id": valid[int(idx)][1],
                "similarity": float(sims[int(idx)]),
                "weight": float(max(0.0, float(sims[int(idx)]) - s0)),
                "description_text": valid[int(idx)][0],
            }
            for idx in topk_idx
        ],
        "feature_space_points": feature_space_points,
        "feature_space_projection": feature_space_projection,
        "feature_space_points_total": n_all + 1,  # + запрос инспектора
        "embeddings_cache_hit": cache_hit,
    }


@app.post("/api/v1/embed")
def embed(payload: EmbedRequest) -> dict[str, Any]:
    texts = [str(t or "").strip() for t in (payload.texts or []) if str(t or "").strip()]
    if not texts:
        return {"embedding_model": E5_MODEL_NAME, "vectors": []}
    if FORCE_STUB:
        return {"embedding_model": E5_MODEL_NAME, "vectors": [[0.0] * 8 for _ in texts]}
    encoder = _get_encoder()
    arr = encoder.encode([f"passage: {t}" for t in texts], normalize_embeddings=True, show_progress_bar=False)
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
            # Прогрев первого инференса, чтобы не платить cold-start в запросе инспектора.
            encoder.encode(["query: warmup"], normalize_embeddings=True, show_progress_bar=False)
        except Exception:
            # Не роняем сервис, fallback обработается в runtime.
            pass

    # Важно: прогрев не должен блокировать startup/health.
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
        if valid and all(e is not None for e in valid_emb):
            encoder = _get_encoder()
            q_emb = encoder.encode([f"query: {(payload.description or '').strip()}"], normalize_embeddings=True, show_progress_bar=False)
            qv = q_emb.astype(np.float32, copy=False) if isinstance(q_emb, np.ndarray) else np.array(q_emb, dtype=np.float32)
            pv = np.array(valid_emb, dtype=np.float32)
            sims = (qv @ pv.T).flatten()
            # reuse existing logic with temporary payload by delegating through core path when similarity matrix computed
            # For consistency, run the standard path when precomputed embeddings have invalid shapes.
            if pv.ndim == 2 and pv.shape[0] == len(valid):
                # emulate cache hit by short-circuiting vector encode for passages
                # local copy of _embedding_search core
                classes = [c for _, c in valid]
                n_all = len(valid)
                knn_k = max(1, min(int(payload.knn_k or 3), n_all))
                topk_idx = np.argsort(sims)[::-1][:knn_k]
                s0 = payload.neighbor_similarity_floor_s0 if payload.neighbor_similarity_floor_s0 is not None else DEFAULT_S0
                tau1 = payload.similarity_threshold
                tau2 = payload.support_threshold_tau2 if payload.support_threshold_tau2 is not None else DEFAULT_TAU2
                votes: dict[str, dict[str, float]] = {}
                total_weight = 0.0
                for i in topk_idx:
                    cls = classes[int(i)]
                    sim = float(sims[int(i)])
                    w = max(0.0, sim - s0)
                    total_weight += w
                    v = votes.get(cls) or {"vw": 0.0, "count": 0.0, "best": -1e9}
                    v["vw"] += w
                    v["count"] += 1.0
                    v["best"] = max(v["best"], sim)
                    votes[cls] = v
                winner = None
                for cls, v in votes.items():
                    p = float(v["vw"]) / (total_weight + EPS)
                    cand = (cls, p, v["count"], v["best"], v["vw"])
                    if winner is None:
                        winner = cand
                    else:
                        if cand[1] > winner[1] or (
                            cand[1] == winner[1] and (cand[2] > winner[2] or (cand[2] == winner[2] and cand[3] > winner[3]))
                        ):
                            winner = cand
                class_id = winner[0] if winner else None
                best_sim = float(winner[3]) if winner else 0.0
                support_p = float(winner[4]) / (total_weight + EPS) if winner else 0.0
                matched = bool(class_id) and (
                    (tau1 is None or best_sim > float(tau1))
                    and support_p > float(tau2)
                )
                # Для визуализации используем тот же подход, что и в основной ветке:
                # ограничиваем карту наиболее похожими точками, чтобы не искажать масштаб шумом.
                keep_n = min(n_all, SPACE_MAX_POINTS)
                top_idx = np.argsort(sims)[::-1][:keep_n]
                feature_space_points, feature_space_projection = _build_feature_space_points(
                    query_text=(payload.description or "").strip(),
                    valid=valid,
                    sims=sims,
                    top_idx=top_idx,
                    q_emb=qv,
                    p_emb=pv,
                )
                return {
                    "matched": matched,
                    "similarity": best_sim,
                    "class_id": class_id,
                    "similarity_threshold_echo": payload.similarity_threshold,
                    "threshold_tau1": payload.similarity_threshold,
                    "threshold_tau2": tau2,
                    "neighbor_similarity_floor_s0": s0,
                    "support_p": support_p,
                    "rule_id": payload.rule_id,
                    "service_mode": "reference_embeddings_precomputed",
                    "note_ru": "класс выбран по kNN на предрасчитанных эмбеддингах эталонов",
                    "embedding_model": E5_MODEL_NAME,
                    "n_reference_examples_total": len(payload.reference_examples or []),
                    "n_reference_examples_used": len(valid),
                    "knn_k": knn_k,
                    "knn_neighbors": [
                        {
                            "description_text": valid[int(i)][0],
                            "class_id": valid[int(i)][1],
                            "similarity": float(sims[int(i)]),
                            "weight": max(0.0, float(sims[int(i)]) - s0),
                        }
                        for i in topk_idx
                    ],
                    "feature_space_points": feature_space_points,
                    "feature_space_projection": feature_space_projection,
                    "feature_space_points_total": len(feature_space_points),
                    "embeddings_cache_hit": True,
                }
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
