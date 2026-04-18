from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db.models import Rule, RuleVersion
from ..db.session import get_db_session
from ..rules.classification import find_first_matching_classification_rule
from ..rules.compiler import compile_rule
from ..primary_catalog_settings import get_effective_primary_catalog_map
from ..rules.dsl_models import ObjectFieldSchema, RuleDSL, normalize_tn_ved_eaeu_code_value
from ..rules.officer_validation_errors_ru import humanize_officer_error_list, note_class_not_assigned_ru

router = APIRouter(tags=["officer-pipeline"])

PREPROCESSING_URL = os.getenv("PREPROCESSING_URL", "http://preprocessing:8004").rstrip("/")
OFFICER_HTTP_TIMEOUT = float(os.getenv("OFFICER_PIPELINE_HTTP_TIMEOUT", "900"))


def _root_property_names(root: ObjectFieldSchema) -> set[str]:
    return {p.name for p in root.properties}


def _normalize_decl_tnved(raw: str | None) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    digits = "".join(c for c in s if c.isdigit())
    if len(digits) not in (2, 4, 6, 8, 10):
        return None
    try:
        return normalize_tn_ved_eaeu_code_value(digits)
    except ValueError:
        return None


def _find_best_rule_for_tnved(
    db: Session,
    declaration_tnved: str | None,
) -> Optional[Tuple[Rule, RuleVersion]]:
    decl = _normalize_decl_tnved(declaration_tnved)
    if not decl:
        return None

    primary_by_group = get_effective_primary_catalog_map(db)

    stmt = (
        db.query(Rule, RuleVersion)
        .join(RuleVersion, RuleVersion.rule_id == Rule.id)
        .filter(RuleVersion.is_active.is_(True))
        .filter(Rule.is_archived.is_(False))
    )
    rows = stmt.order_by(RuleVersion.created_at.desc()).all()

    candidates: list[tuple[int, Rule, RuleVersion, str]] = []
    for rule, rv in rows:
        meta = rv.dsl_json.get("meta") if isinstance(rv.dsl_json, dict) else None
        if not isinstance(meta, dict):
            continue
        raw_grp = meta.get("tn_ved_group_code")
        if raw_grp is None:
            continue
        try:
            grp = normalize_tn_ved_eaeu_code_value(str(raw_grp).strip())
        except ValueError:
            continue
        if decl.startswith(grp):
            candidates.append((len(grp), rule, rv, grp))

    if not candidates:
        return None

    max_len = max(c[0] for c in candidates)
    tier = [c for c in candidates if c[0] == max_len]
    if len(tier) == 1:
        return tier[0][1], tier[0][2]

    grp_key = tier[0][3]
    prim_id = primary_by_group.get(grp_key)
    if prim_id:
        for _ln, rule, rv, _g in tier:
            if str(rule.id) == prim_id:
                return (rule, rv)

    tier.sort(key=lambda x: x[2].created_at, reverse=True)
    return tier[0][1], tier[0][2]


def _fmt_scalar_display(v: Any) -> str:
    if v is None:
        return "—"
    if isinstance(v, bool):
        return "да" if v else "нет"
    if isinstance(v, str):
        t = v.strip()
        if (t.startswith("'") and t.endswith("'")) or (t.startswith('"') and t.endswith('"')):
            t = t[1:-1].strip()
        return t
    if isinstance(v, float):
        if v == int(v):
            return str(int(v))
        return f"{v:g}"
    if isinstance(v, int):
        return str(v)
    return str(v)


def _format_prochee_row(row: dict) -> Optional[str]:
    param = row.get("параметр")
    if param is None:
        return None
    p = _fmt_scalar_display(param)
    if row.get("значение") is not None:
        return f"{p} — {_fmt_scalar_display(row.get('значение'))}"
    if row.get("масса") is not None:
        unit = row.get("единица")
        unit_s = f" {unit}" if unit else ""
        return f"{p} — {_fmt_scalar_display(row.get('масса'))}{unit_s}"
    if row.get("количество") is not None:
        unit = row.get("единица")
        unit_s = f" {unit}" if unit else ""
        return f"{p} — {_fmt_scalar_display(row.get('количество'))}{unit_s}"
    return p


def _format_mass_fraction_row(row: dict) -> Optional[str]:
    sub = row.get("вещество")
    mass = row.get("массовая доля")
    if sub is None and mass is None:
        return None
    sub_s = _fmt_scalar_display(sub) if sub is not None else "?"
    mass_s = _fmt_scalar_display(mass) if mass is not None else "?"
    return f"массовая доля · {sub_s} — {mass_s}"


def format_extracted_document_compact(parsed: Dict[str, Any]) -> str:
    """
    Компактный читаемый текст по извлечённому JSON: нумерованные строки, без «дерева».
    """
    if not parsed:
        return "(нет данных)"

    lines: List[str] = []
    n = 0

    def _mass_block(rows: List[Any]) -> None:
        nonlocal n
        for row in rows:
            if not isinstance(row, dict):
                continue
            line = _format_mass_fraction_row(row)
            if line:
                n += 1
                lines.append(f"{n}) {line}")

    def _prochee_block(rows: List[Any]) -> None:
        nonlocal n
        for row in rows:
            if not isinstance(row, dict):
                continue
            line = _format_prochee_row(row)
            if line:
                n += 1
                lines.append(f"{n}) {line}")

    if "массовая доля" in parsed and isinstance(parsed["массовая доля"], list):
        _mass_block(parsed["массовая доля"])

    if "прочее" in parsed and isinstance(parsed["прочее"], list):
        _prochee_block(parsed["прочее"])

    for key, val in parsed.items():
        if key in ("массовая доля", "прочее"):
            continue
        if isinstance(val, list):
            for item in val:
                if isinstance(item, dict):
                    n += 1
                    parts = [f"{k}: {_fmt_scalar_display(v)}" for k, v in item.items()]
                    lines.append(f"{n}) {key}: " + " · ".join(parts))
                else:
                    n += 1
                    lines.append(f"{n}) {key}: {_fmt_scalar_display(item)}")
        elif isinstance(val, dict):
            n += 1
            parts = [f"{k}: {_fmt_scalar_display(v)}" for k, v in val.items()]
            lines.append(f"{n}) {key}: " + " · ".join(parts))
        else:
            n += 1
            lines.append(f"{n}) {key}: {_fmt_scalar_display(val)}")

    return "\n".join(lines) if lines else "(нет данных)"


def _merge_officer_into_prochee(
    data: Dict[str, Any],
    *,
    gross: Optional[float],
    net: Optional[float],
    price: Optional[float],
    root_names: set[str],
) -> Dict[str, Any]:
    out = dict(data)
    extras: List[Dict[str, Any]] = []
    if gross is not None:
        extras.append({"параметр": "вес брутто (графа 35)", "масса": float(gross), "единица": "кг"})
    if net is not None:
        extras.append({"параметр": "вес нетто (графа 38)", "масса": float(net), "единица": "кг"})
    if price is not None:
        extras.append({"параметр": "стоимость (графа 42)", "значение": str(price)})
    if not extras:
        return out
    if "прочее" not in root_names:
        return out
    cur = out.get("прочее")
    base: List[Any] = list(cur) if isinstance(cur, list) else []
    out["прочее"] = base + extras
    return out


def _pick_active_feature_config(dsl: RuleDSL) -> Optional[Dict[str, Any]]:
    meta = dsl.meta
    if meta is None:
        return None
    cfgs = meta.feature_extraction_configs
    if not cfgs or not isinstance(cfgs, list):
        return None
    primary: list[Dict[str, Any]] = []
    for c in cfgs:
        if not isinstance(c, dict):
            continue
        v = c.get("feature_extraction_primary")
        if v is True or v == "true":
            primary.append(c)
    if len(primary) == 1:
        return primary[0]
    active_id = (meta.feature_extraction_active_config_id or "").strip()
    if active_id:
        for c in cfgs:
            if isinstance(c, dict) and str(c.get("id") or "").strip() == active_id:
                return c
    first = cfgs[0]
    return first if isinstance(first, dict) else None


def _assemble_llm_prompt(cfg: Dict[str, Any], description: str) -> str:
    parts: List[str] = []
    rp = str(cfg.get("extraction_rules_preview") or "").strip()
    if rp:
        parts.append(rp)
    pr = str(cfg.get("prompt") or "").strip()
    if pr:
        parts.append(pr)
    parts.append("Текст для извлечения:\n" + description.strip())
    return "\n\n".join(parts)


def _catalog_classification_entries(dsl: RuleDSL) -> List[Dict[str, str]]:
    clf = dsl.classification
    if not clf or not clf.rules:
        return []
    out: List[Dict[str, str]] = []
    for r in clf.rules:
        cid = (r.class_id or "").strip()
        if not cid:
            continue
        out.append({"class_id": cid, "title": (r.title or "").strip()})
    return out


def _extract_exactly_one_conflict(errors: List[Any]) -> Optional[Dict[str, Any]]:
    for e in errors:
        if not isinstance(e, dict):
            continue
        msg = str(e.get("message") or "")
        if "exactly_one" not in msg:
            continue
        details = e.get("details")
        if not isinstance(details, dict):
            continue
        matched = details.get("matched_class_ids")
        if not isinstance(matched, list):
            continue
        class_ids = [str(x).strip() for x in matched if str(x).strip()]
        if len(class_ids) <= 1:
            continue
        return {
            "matched_count": len(class_ids),
            "matched_class_ids": class_ids,
            "error_ru": (
                "Ошибка в справочнике: для стратегии exactly_one сработало несколько правил одновременно. "
                "Декларация требует экспертного рассмотрения."
            ),
        }
    return None


class OfficerRunRequest(BaseModel):
    declaration_id: str
    description: str
    tnved_code: str | None = None
    gross_weight_kg: float | None = None
    net_weight_kg: float | None = None
    price: float | None = None
    extracted_features_override: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Если задан — используется вместо результата LLM-извлечения (корректировка инспектором).",
    )


@router.post("/api/pipeline/officer-run")
def officer_run(
    payload: OfficerRunRequest,
    db: Session = Depends(get_db_session),
) -> Dict[str, Any]:
    """
    Полный цикл для UI инспектора: справочник по ТН ВЭД → LLM-извлечение → правила → классификация.
    """
    found = _find_best_rule_for_tnved(db, payload.tnved_code)
    if not found:
        raise HTTPException(
            status_code=404,
            detail=(
                "Не найден активный справочник для указанного кода ТН ВЭД. "
                "Создайте справочник с подходящим meta.tn_ved_group_code либо проверьте формат кода (2–10 цифр)."
            ),
        )

    rule, rv = found
    try:
        dsl = RuleDSL.model_validate(rv.dsl_json)
        compiled = compile_rule(dsl)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка компиляции справочника: {e}") from e

    meta = dsl.meta
    catalog_name = (meta.name if meta else None) or rule.name or rule.model_id
    tn_grp = None
    if meta and meta.tn_ved_group_code:
        try:
            tn_grp = normalize_tn_ved_eaeu_code_value(meta.tn_ved_group_code)
        except ValueError:
            tn_grp = str(meta.tn_ved_group_code).strip()

    fe_cfg = _pick_active_feature_config(dsl)
    feature_block: Dict[str, Any] = {
        "status": "skipped",
        "reason": "Нет активной конфигурации извлечения признаков в meta.feature_extraction_configs",
    }
    parsed: Dict[str, Any] = {}

    if payload.extracted_features_override is not None:
        parsed = dict(payload.extracted_features_override)
        compact = format_extracted_document_compact(parsed) if parsed else "(пустой JSON)"
        feature_block = {
            "status": "inspector_override",
            "extracted_document_ru": compact,
            "parsed": parsed,
            "reason": "Признаки заданы инспектором вручную; вызов модели извлечения не выполнялся.",
        }
    elif fe_cfg:
        models_raw = fe_cfg.get("selected_models")
        models = [str(m).strip() for m in models_raw] if isinstance(models_raw, list) else []
        model = models[0] if models else ""
        if not model:
            feature_block = {
                "status": "error",
                "reason": "В конфигурации извлечения не выбрана модель (selected_models пуст).",
            }
        else:
            prompt = _assemble_llm_prompt(fe_cfg, payload.description)
            ollama_body: Dict[str, Any] = {
                "model": model,
                "prompt": prompt,
                "num_ctx": 8192,
                "max_new_tokens": 3904,
                "repetition_penalty": 1.0,
                "temperature": 0.0,
                "enable_thinking": False,
            }
            try:
                with httpx.Client(timeout=OFFICER_HTTP_TIMEOUT) as client:
                    gen = client.post(
                        f"{PREPROCESSING_URL}/api/v1/ollama/generate",
                        json=ollama_body,
                    )
                    gen.raise_for_status()
                    gen_json = gen.json()
                    raw_text = str(gen_json.get("raw_response") or "").strip()

                    pr = client.post(
                        f"{PREPROCESSING_URL}/api/v1/parse-model-json",
                        json={"text": raw_text},
                    )
                    pr.raise_for_status()
                    pr_json = pr.json()
                    parsed_raw = pr_json.get("parsed")
                    parsed = parsed_raw if isinstance(parsed_raw, dict) else {}
            except httpx.HTTPStatusError as e:
                raise HTTPException(
                    status_code=502,
                    detail=f"Сервис извлечения (preprocessing) ответил с ошибкой: {e.response.status_code} {e.response.text[:800]}",
                ) from e
            except httpx.RequestError as e:
                raise HTTPException(
                    status_code=502,
                    detail=f"Сервис preprocessing недоступен ({PREPROCESSING_URL}): {e}",
                ) from e

            excerpt = raw_text[:1200] + ("…" if len(raw_text) > 1200 else "")
            compact = format_extracted_document_compact(parsed) if parsed else "(пустой JSON)"
            feature_block = {
                "status": "ok",
                "config_id": fe_cfg.get("id"),
                "config_name": fe_cfg.get("name"),
                "model": model,
                "extracted_document_ru": compact,
                "parsed": parsed,
                "raw_llm_excerpt": excerpt,
            }
    else:
        feature_block["extracted_document_ru"] = "Извлечение не выполнялось — задайте конфигурацию в настройках справочника."

    root_names = _root_property_names(compiled.root_schema)
    merged = _merge_officer_into_prochee(
        parsed,
        gross=payload.gross_weight_kg,
        net=payload.net_weight_kg,
        price=payload.price,
        root_names=root_names,
    )

    ok, errors, validated_dict, assigned_class = compiled.validate(merged)
    exactly_one_conflict = _extract_exactly_one_conflict(errors)

    clf_cfg = compiled.classification
    matched_rule = None
    if validated_dict is not None and clf_cfg is not None:
        matched_rule = find_first_matching_classification_rule(validated_dict, clf_cfg)

    rule_title: Optional[str] = None
    if matched_rule is not None:
        rule_title = matched_rule.title or matched_rule.class_id
    elif (
        clf_cfg
        and clf_cfg.strategy == "first_match"
        and assigned_class
        and clf_cfg.default_class_id == assigned_class
    ):
        rule_title = "Класс по умолчанию (default_class_id)"

    sep = "─" * 40
    extracted_text = (
        feature_block.get("extracted_document_ru")
        or feature_block.get("reason")
        or json.dumps(feature_block, ensure_ascii=False)
    )
    summary_lines = [
        f"Справочник · {catalog_name}",
        f"Идентификатор · {rule.id}",
        f"Группа ТН ВЭД · {tn_grp or '—'}",
        "",
        "Извлечённые признаки",
        sep,
        extracted_text,
        "",
        "Детерминированная классификация",
        sep,
        f"Валидация структуры и правил · {'успешно' if ok else 'есть ошибки'}",
    ]
    class_note = note_class_not_assigned_ru(ok, assigned_class)
    if class_note:
        summary_lines.append(class_note)
    if assigned_class:
        summary_lines.append(f"Итоговый класс (class_id): {assigned_class}")
    if rule_title:
        summary_lines.append(f"Сработавшее правило классификации: {rule_title}")
    errors_ru = humanize_officer_error_list(errors) if errors else []
    if errors:
        summary_lines.append("Ошибки (пояснение): " + json.dumps(errors_ru, ensure_ascii=False))
    if exactly_one_conflict:
        summary_lines.append(
            "Конфликт классификации: " + json.dumps(exactly_one_conflict["matched_class_ids"], ensure_ascii=False)
        )
        summary_lines.append(str(exactly_one_conflict["error_ru"]))

    out: Dict[str, Any] = {
        "declaration_id": payload.declaration_id,
        "status": "completed",
        "summary_ru": "\n".join(summary_lines),
        "catalog": {
            "rule_id": str(rule.id),
            "name": catalog_name,
            "model_id": rule.model_id,
            "tn_ved_group_code": tn_grp,
        },
        "feature_extraction": feature_block,
        "deterministic": {
            "validation_ok": ok,
            "errors": errors,
            "errors_ru": errors_ru,
            "class_note_ru": class_note,
            "assigned_class_id": assigned_class,
            "matched_classification_rule_title": rule_title,
            "matched_classification_class_id": matched_rule.class_id if matched_rule else None,
            "exactly_one_conflict": exactly_one_conflict,
            "candidate_class_ids": exactly_one_conflict["matched_class_ids"] if exactly_one_conflict else [],
            "requires_expert_review": bool(exactly_one_conflict),
        },
        "final_class_id": assigned_class,
        "catalog_classification_classes": _catalog_classification_entries(dsl),
        "requires_expert_review": bool(exactly_one_conflict),
    }
    return out
