from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from ..db.models import ExpertDecisionItem
from ..db.session import get_db_session

router = APIRouter(prefix="/api/expert-decisions", tags=["expert-decisions"])


class ExpertDecisionCreate(BaseModel):
    category: str = Field(..., min_length=1, max_length=64)
    declaration_id: str = Field(..., min_length=1, max_length=512)
    summary_ru: str = ""
    payload: Dict[str, Any] = Field(default_factory=dict)
    rule_id: Optional[str] = None
    model_config = ConfigDict(extra="ignore")


class ExpertDecisionItemOut(BaseModel):
    id: str
    category: str
    rule_id: Optional[str] = None
    declaration_id: str
    status: str
    summary_ru: str
    payload_json: Dict[str, Any]
    resolution_json: Optional[Dict[str, Any]] = None
    created_at: str
    resolved_at: Optional[str] = None


class ExpertDecisionPatch(BaseModel):
    status: Literal["resolved", "dismissed"]
    resolution: Dict[str, Any] = Field(default_factory=dict)
    model_config = ConfigDict(extra="ignore")


def _to_out(row: ExpertDecisionItem) -> ExpertDecisionItemOut:
    return ExpertDecisionItemOut(
        id=str(row.id),
        category=row.category,
        rule_id=str(row.rule_id) if row.rule_id else None,
        declaration_id=row.declaration_id,
        status=row.status,
        summary_ru=row.summary_ru,
        payload_json=row.payload_json,
        resolution_json=row.resolution_json,
        created_at=row.created_at.isoformat() if row.created_at else "",
        resolved_at=row.resolved_at.isoformat() if row.resolved_at else None,
    )


@router.post("", response_model=ExpertDecisionItemOut)
def create_expert_decision(payload: ExpertDecisionCreate, db: Session = Depends(get_db_session)) -> ExpertDecisionItemOut:
    rid: Optional[uuid.UUID] = None
    if payload.rule_id and str(payload.rule_id).strip():
        try:
            rid = uuid.UUID(str(payload.rule_id).strip())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Некорректный rule_id") from exc
    row = ExpertDecisionItem(
        category=payload.category.strip(),
        rule_id=rid,
        declaration_id=payload.declaration_id.strip(),
        status="pending",
        summary_ru=(payload.summary_ru or "").strip(),
        payload_json=dict(payload.payload),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.get("", response_model=List[ExpertDecisionItemOut])
def list_expert_decisions(
    status: Optional[str] = Query(None, description="pending | resolved | dismissed"),
    category: Optional[str] = Query(None),
    db: Session = Depends(get_db_session),
) -> List[ExpertDecisionItemOut]:
    q = db.query(ExpertDecisionItem)
    if status and status.strip():
        q = q.filter(ExpertDecisionItem.status == status.strip())
    if category and category.strip():
        q = q.filter(ExpertDecisionItem.category == category.strip())
    rows = q.order_by(ExpertDecisionItem.created_at.desc()).limit(500).all()
    return [_to_out(r) for r in rows]


@router.patch("/{item_id}", response_model=ExpertDecisionItemOut)
def patch_expert_decision(
    item_id: str,
    body: ExpertDecisionPatch,
    db: Session = Depends(get_db_session),
) -> ExpertDecisionItemOut:
    try:
        uid = uuid.UUID(item_id.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Некорректный id") from exc
    row = db.query(ExpertDecisionItem).filter(ExpertDecisionItem.id == uid).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    row.status = body.status
    row.resolution_json = dict(body.resolution) if body.resolution else {}
    row.resolved_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return _to_out(row)
