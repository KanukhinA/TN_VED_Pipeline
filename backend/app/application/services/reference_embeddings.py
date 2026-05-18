"""Сохранение и пакетный пересчёт эмбеддингов эталонных примеров."""

from __future__ import annotations

from datetime import datetime
from typing import Any, List, Optional
import uuid

from sqlalchemy.orm import Session

from ...db.models import RuleReferenceEmbedding, RuleReferenceExample
from ...infrastructure.http.semantic_search_client import HttpSemanticSearchClient

_EMBED_CHUNK = 48


def upsert_reference_embedding(
    db: Session,
    ref: RuleReferenceExample,
    *,
    client: HttpSemanticSearchClient,
) -> bool:
    """Создаёт или обновляет эмбеддинг описания эталона. Возвращает True при успехе."""
    desc = (ref.description_text or "").strip()
    if not desc:
        return False
    try:
        data = client.embed_texts([desc])
    except Exception:
        return False
    model_name = str(data.get("embedding_model") or "").strip()
    vectors = data.get("vectors")
    if not model_name or not isinstance(vectors, list) or len(vectors) == 0 or not isinstance(vectors[0], list):
        return False
    vector = vectors[0]
    if not vector:
        return False
    emb = (
        db.query(RuleReferenceEmbedding)
        .filter(RuleReferenceEmbedding.reference_example_id == ref.id)
        .one_or_none()
    )
    payload = {"vector": vector}
    now = datetime.utcnow()
    if emb is None:
        db.add(
            RuleReferenceEmbedding(
                reference_example_id=ref.id,
                embedding_model=model_name,
                embedding_json=payload,
                created_at=now,
                updated_at=now,
            )
        )
    else:
        emb.embedding_model = model_name
        emb.embedding_json = payload
        emb.updated_at = now
    return True


def backfill_missing_reference_embeddings(
    db: Session,
    examples: List[RuleReferenceExample],
    *,
    client: HttpSemanticSearchClient,
    force: bool = False,
) -> dict[str, Any]:
    """
    Пакетно считает эмбеддинги для примеров без записи в rule_reference_embeddings.
    При force=True пересчитывает все переданные примеры.
    """
    if not examples:
        return {"processed": 0, "embedded": 0, "skipped": 0}

    ids = [ex.id for ex in examples]
    existing = {
        e.reference_example_id
        for e in db.query(RuleReferenceEmbedding)
        .filter(RuleReferenceEmbedding.reference_example_id.in_(ids))
        .all()
    }
    targets: List[RuleReferenceExample] = []
    for ex in examples:
        desc = (ex.description_text or "").strip()
        if not desc:
            continue
        if force or ex.id not in existing:
            targets.append(ex)

    if not targets:
        return {"processed": len(examples), "embedded": 0, "skipped": len(examples)}

    embedded = 0
    for start in range(0, len(targets), _EMBED_CHUNK):
        chunk = targets[start : start + _EMBED_CHUNK]
        texts = [(ex.description_text or "").strip() for ex in chunk]
        try:
            data = client.embed_texts(texts)
        except Exception:
            continue
        model_name = str(data.get("embedding_model") or "").strip()
        vectors = data.get("vectors")
        if not model_name or not isinstance(vectors, list) or len(vectors) != len(chunk):
            continue
        now = datetime.utcnow()
        for ex, vec in zip(chunk, vectors):
            if not isinstance(vec, list) or not vec:
                continue
            emb = (
                db.query(RuleReferenceEmbedding)
                .filter(RuleReferenceEmbedding.reference_example_id == ex.id)
                .one_or_none()
            )
            payload = {"vector": vec}
            if emb is None:
                db.add(
                    RuleReferenceEmbedding(
                        reference_example_id=ex.id,
                        embedding_model=model_name,
                        embedding_json=payload,
                        created_at=now,
                        updated_at=now,
                    )
                )
            else:
                emb.embedding_model = model_name
                emb.embedding_json = payload
                emb.updated_at = now
            embedded += 1

    skipped = len(examples) - embedded
    return {"processed": len(examples), "embedded": embedded, "skipped": skipped}


def backfill_rule_reference_embeddings(
    db: Session,
    rule_id: uuid.UUID,
    *,
    client: HttpSemanticSearchClient,
    force: bool = False,
) -> dict[str, Any]:
    """Пересчёт эмбеддингов для всех эталонов справочника."""
    from ...db.models import Rule

    if db.query(Rule).filter(Rule.id == rule_id).one_or_none() is None:
        raise LookupError("Rule not found")
    rows = (
        db.query(RuleReferenceExample)
        .filter(RuleReferenceExample.rule_id == rule_id)
        .order_by(RuleReferenceExample.created_at.desc())
        .all()
    )
    stats = backfill_missing_reference_embeddings(db, rows, client=client, force=force)
    stats["rule_id"] = str(rule_id)
    stats["examples_total"] = len(rows)
    return stats
