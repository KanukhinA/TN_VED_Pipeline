from __future__ import annotations

import json
import os
import socket
import threading
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field
import numpy as np
import psycopg2
from sentence_transformers import SentenceTransformer
from sklearn.cluster import MiniBatchKMeans

app = FastAPI(title="Clustering Service", version="0.1.0")

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://rules_user:rules_pass@postgres:5432/rules")
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "5"))
WORKER_ID = os.getenv("WORKER_ID", f"cluster-worker-{socket.gethostname()}")

_stop_event = threading.Event()
_worker_thread: threading.Thread | None = None
_last_job: dict[str, Any] | None = None
_encoder_lock = threading.Lock()
_encoder: SentenceTransformer | None = None

E5_MODEL_NAME = os.getenv("CLUSTERING_EMBEDDING_MODEL", "intfloat/multilingual-e5-base")


class ClusterSelectRequest(BaseModel):
    texts: list[str] = Field(default_factory=list)
    n_clusters: int = 100
    max_candidates: int = 100


class ClusterSelectResponse(BaseModel):
    status: str
    embedding_model: str
    n_input: int
    n_clusters: int
    n_candidates: int
    candidates: list[str]
    cluster_by_text: dict[str, int]


def _get_encoder() -> SentenceTransformer:
    global _encoder
    if _encoder is not None:
        return _encoder
    with _encoder_lock:
        if _encoder is None:
            _encoder = SentenceTransformer(E5_MODEL_NAME)
    return _encoder


def _embed_texts_e5(texts: list[str]) -> np.ndarray:
    encoder = _get_encoder()
    inputs = [f"passage: {t}" for t in texts]
    emb = encoder.encode(inputs, normalize_embeddings=True, show_progress_bar=False)
    if isinstance(emb, np.ndarray):
        return emb
    return np.array(emb, dtype=np.float32)


def _select_representatives_kmeans(
    texts: list[str],
    *,
    n_clusters: int,
    max_candidates: int,
) -> tuple[list[str], dict[str, int]]:
    clean = [str(t).strip() for t in texts if str(t).strip()]
    if not clean:
        return [], {}

    n = len(clean)
    target_clusters = max(1, min(int(n_clusters), n))
    vectors = _embed_texts_e5(clean)

    if target_clusters == 1:
        return [clean[0]], {clean[0]: 0}

    kmeans = MiniBatchKMeans(
        n_clusters=target_clusters,
        random_state=42,
        n_init="auto",
        batch_size=min(2048, max(128, n)),
        max_iter=200,
    )
    labels = kmeans.fit_predict(vectors)
    centroids = kmeans.cluster_centers_

    # Для каждого кластера берём ближайший к центроиду текст.
    picked_indices: list[int] = []
    for cluster_id in range(target_clusters):
        member_idx = np.where(labels == cluster_id)[0]
        if len(member_idx) == 0:
            continue
        member_vectors = vectors[member_idx]
        centroid = centroids[cluster_id]
        dists = np.linalg.norm(member_vectors - centroid, axis=1)
        best_local = int(member_idx[int(np.argmin(dists))])
        picked_indices.append(best_local)

    # Если кластеров больше лимита, оставляем первые по ID (детерминированно).
    picked_indices = sorted(set(picked_indices))[: max(1, min(int(max_candidates), n))]
    candidates = [clean[i] for i in picked_indices]
    cluster_by_text = {clean[i]: int(labels[i]) for i in range(n)}
    return candidates, cluster_by_text


def init_jobs_schema() -> None:
    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id BIGSERIAL PRIMARY KEY,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    payload JSONB NOT NULL,
                    result JSONB,
                    error TEXT,
                    worker_id TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    started_at TIMESTAMPTZ,
                    finished_at TIMESTAMPTZ
                );
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_jobs_status_created
                ON jobs (status, created_at);
                """
            )


def poll_one_job() -> dict[str, Any] | None:
    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                WITH picked AS (
                    SELECT id
                    FROM jobs
                    WHERE status = 'queued' AND kind = 'clustering'
                    ORDER BY created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                UPDATE jobs j
                SET status = 'processing', started_at = NOW(), worker_id = %s
                FROM picked
                WHERE j.id = picked.id
                RETURNING j.id, j.payload::text;
                """,
                (WORKER_ID,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            return {"id": int(row[0]), "payload": json.loads(row[1])}


def finish_job(job_id: int, result: dict[str, Any]) -> None:
    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE jobs
                SET status = 'done', result = %s::jsonb, finished_at = NOW()
                WHERE id = %s;
                """,
                (json.dumps(result, ensure_ascii=False), job_id),
            )


def fail_job(job_id: int, error: str) -> None:
    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE jobs
                SET status = 'failed', error = %s, finished_at = NOW()
                WHERE id = %s;
                """,
                (error, job_id),
            )


def worker_loop() -> None:
    global _last_job
    while not _stop_event.is_set():
        try:
            job = poll_one_job()
            if job is None:
                _stop_event.wait(POLL_INTERVAL_SECONDS)
                continue
            payload = job["payload"]
            # Stub for heavy ML clustering processing.
            result = {
                "cluster_id": f"CLUSTER-{job['id']}",
                "items_processed": 1,
                "declaration_id": payload.get("declaration_id"),
            }
            finish_job(job["id"], result)
            _last_job = {"id": job["id"], "status": "done", "result": result}
        except Exception as exc:
            if "job" in locals() and job is not None:
                fail_job(job["id"], str(exc))
                _last_job = {"id": job["id"], "status": "failed", "error": str(exc)}
            _stop_event.wait(min(POLL_INTERVAL_SECONDS, 2.0))


@app.on_event("startup")
def startup() -> None:
    global _worker_thread
    init_jobs_schema()
    _stop_event.clear()
    _worker_thread = threading.Thread(target=worker_loop, daemon=True)
    _worker_thread.start()


@app.on_event("shutdown")
def shutdown() -> None:
    _stop_event.set()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "clustering-service"}


@app.get("/ready")
def ready() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "clustering-service",
        "worker_id": WORKER_ID,
        "poll_interval_seconds": POLL_INTERVAL_SECONDS,
        "last_job": _last_job,
    }


@app.post("/api/v1/clustering/run")
def run_cluster() -> dict[str, str]:
    return {"status": "accepted_stub", "detail": "job queued in test mode"}


@app.post("/api/v1/clustering/select-candidates", response_model=ClusterSelectResponse)
def select_candidates(req: ClusterSelectRequest) -> ClusterSelectResponse:
    texts = [str(t).strip() for t in (req.texts or []) if str(t).strip()]
    if not texts:
        return ClusterSelectResponse(
            status="ok",
            embedding_model=E5_MODEL_NAME,
            n_input=0,
            n_clusters=0,
            n_candidates=0,
            candidates=[],
            cluster_by_text={},
        )

    n_clusters = max(1, min(int(req.n_clusters), len(texts)))
    max_candidates = max(1, min(int(req.max_candidates), len(texts)))
    candidates, cluster_by_text = _select_representatives_kmeans(
        texts,
        n_clusters=n_clusters,
        max_candidates=max_candidates,
    )
    return ClusterSelectResponse(
        status="ok",
        embedding_model=E5_MODEL_NAME,
        n_input=len(texts),
        n_clusters=n_clusters,
        n_candidates=len(candidates),
        candidates=candidates,
        cluster_by_text=cluster_by_text,
    )
