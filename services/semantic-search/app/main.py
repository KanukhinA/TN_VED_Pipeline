from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Semantic search (stub)", version="0.1.0")


class SearchRequest(BaseModel):
    description: str
    tnved_code: str | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "semantic-search"}


@app.post("/api/v1/search")
def search_stub(payload: SearchRequest) -> dict[str, object]:
    """Stub of vector search with TN VED filter."""
    matched = payload.tnved_code is not None and payload.tnved_code.startswith("27")
    return {
        "matched": matched,
        "similarity": 0.91 if matched else 0.41,
        "class_id": "CLASS-27-STUB" if matched else None,
    }
