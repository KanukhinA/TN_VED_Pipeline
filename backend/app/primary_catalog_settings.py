"""Основной справочник на код группы ТН ВЭД (meta.tn_ved_group_code): хранение в AppSetting."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, Optional, Set

from sqlalchemy.orm import Session

from .db.models import AppSetting, Rule, RuleVersion
from .rules.dsl_models import normalize_tn_ved_eaeu_code_value

PRIMARY_CATALOG_APP_KEY = "primary_catalog_by_tn_ved_group_v1"


def group_rule_ids_by_tn_ved(db: Session) -> Dict[str, Set[uuid.UUID]]:
    """Все неархивные справочники с активной версией и заданным meta.tn_ved_group_code, сгруппированные по коду."""
    stmt = (
        db.query(Rule, RuleVersion)
        .join(RuleVersion, RuleVersion.rule_id == Rule.id)
        .filter(RuleVersion.is_active.is_(True))
        .filter(Rule.is_archived.is_(False))
    )
    rows = stmt.all()
    out: Dict[str, Set[uuid.UUID]] = {}
    for rule, rv in rows:
        g = _meta_group_from_rv(rv)
        if g is None:
            continue
        out.setdefault(g, set()).add(rule.id)
    return out


def get_effective_primary_catalog_map(db: Session) -> Dict[str, str]:
    """
    Эффективное назначение для офицера и UI: для каждой группы с справочниками всегда есть rule_id.
    Если в БД нет записи или она устарела — для группы с несколькими справочниками берётся детерминированно
    минимальный UUID (до явного сохранения экспертом).
    """
    groups = group_rule_ids_by_tn_ved(db)
    stored = load_primary_catalog_map(db)
    out: Dict[str, str] = {}
    for g, rset in groups.items():
        rlist = sorted(rset, key=lambda x: str(x))
        if len(rlist) == 1:
            out[g] = str(rlist[0])
            continue
        if g in stored:
            try:
                su = uuid.UUID(str(stored[g]).strip())
                if su in rset:
                    out[g] = str(su)
                    continue
            except ValueError:
                pass
        out[g] = str(rlist[0])
    return out


def _meta_group_from_rv(rv: RuleVersion) -> Optional[str]:
    """Извлекает и нормализует группу ТН ВЭД из `RuleVersion.dsl_json.meta`."""
    meta = rv.dsl_json.get("meta") if isinstance(rv.dsl_json, dict) else None
    if not isinstance(meta, dict):
        return None
    raw = meta.get("tn_ved_group_code")
    if raw is None:
        return None
    try:
        return normalize_tn_ved_eaeu_code_value(str(raw).strip())
    except ValueError:
        return None


def load_primary_catalog_map(db: Session) -> Dict[str, str]:
    """Читает сохранённые назначения `группа -> rule_id` из AppSetting."""
    row: AppSetting | None = (
        db.query(AppSetting).filter(AppSetting.key == PRIMARY_CATALOG_APP_KEY).one_or_none()
    )
    if row is None or not isinstance(row.value_json, dict):
        return {}
    raw = row.value_json.get("by_group_code")
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, str] = {}
    for k, v in raw.items():
        if v is None or v == "":
            continue
        ks = str(k).strip()
        if not ks:
            continue
        try:
            nk = normalize_tn_ved_eaeu_code_value(ks)
        except ValueError:
            continue
        out[nk] = str(v).strip()
    return out


def validate_and_save_primary_catalog_map(db: Session, by_group_code: Dict[str, Any]) -> Dict[str, str]:
    """
    Ключ — нормализованный код группы ТН ВЭД; значение — UUID справочника (Rule.id).
    Должна быть задана строка для **каждой** группы, в которой есть хотя бы один справочник.
    """
    groups = group_rule_ids_by_tn_ved(db)
    if not groups:
        # Если активных справочников нет, очищаем настройку и выходим без ошибки.
        row: AppSetting | None = (
            db.query(AppSetting).filter(AppSetting.key == PRIMARY_CATALOG_APP_KEY).one_or_none()
        )
        payload: Dict[str, Any] = {"by_group_code": {}}
        if row is None:
            row = AppSetting(key=PRIMARY_CATALOG_APP_KEY, value_json=payload, updated_at=datetime.utcnow())
            db.add(row)
        else:
            row.value_json = payload
            row.updated_at = datetime.utcnow()
        db.commit()
        return {}

    if not isinstance(by_group_code, dict):
        by_group_code = {}

    normalized: Dict[str, str] = {}

    for raw_key, raw_val in by_group_code.items():
        if raw_val is None or raw_val == "":
            continue
        ks = str(raw_key).strip()
        if not ks:
            continue
        try:
            gkey = normalize_tn_ved_eaeu_code_value(ks)
        except ValueError as exc:
            raise ValueError(f"Некорректный код группы ТН ВЭД: {raw_key!r}") from exc

        if gkey not in groups:
            raise ValueError(
                f"Код группы {gkey!r} не соответствует ни одному активному справочнику — удалите лишний ключ."
            )

        try:
            rid = uuid.UUID(str(raw_val).strip())
        except (ValueError, TypeError) as exc:
            raise ValueError(f"Некорректный rule_id для ключа {gkey!r}") from exc

        if rid not in groups[gkey]:
            raise ValueError(f"Справочник {rid} не относится к группе {gkey!r}")

        rule: Rule | None = db.query(Rule).filter(Rule.id == rid).one_or_none()
        if rule is None:
            raise ValueError(f"Справочник {rid} не найден")
        if rule.is_archived:
            raise ValueError(f"Справочник {rid} в архиве — нельзя назначить основным")

        rv: RuleVersion | None = (
            db.query(RuleVersion)
            .filter(RuleVersion.rule_id == rid, RuleVersion.is_active.is_(True))
            .order_by(RuleVersion.version.desc())
            .first()
        )
        if rv is None:
            raise ValueError(f"У справочника {rid} нет активной версии DSL")

        g_meta = _meta_group_from_rv(rv)
        if g_meta is None:
            raise ValueError(f"У справочника {rid} в meta нет tn_ved_group_code")
        if g_meta != gkey:
            raise ValueError(
                f"Справочник {rid} относится к группе {g_meta!r}, а не к {gkey!r} — проверьте выбор"
            )

        normalized[gkey] = str(rid)

    missing = set(groups.keys()) - set(normalized.keys())
    if missing:
        # Требуем явный выбор основного справочника по каждой доступной группе.
        raise ValueError(
            "Не задан основной справочник для групп ТН ВЭД: "
            + ", ".join(sorted(missing, key=lambda x: (len(x), x)))
        )

    row2: AppSetting | None = (
        db.query(AppSetting).filter(AppSetting.key == PRIMARY_CATALOG_APP_KEY).one_or_none()
    )
    payload2 = {"by_group_code": normalized}
    if row2 is None:
        row2 = AppSetting(key=PRIMARY_CATALOG_APP_KEY, value_json=payload2, updated_at=datetime.utcnow())
        db.add(row2)
    else:
        row2.value_json = payload2
        row2.updated_at = datetime.utcnow()
    db.commit()
    return normalized
