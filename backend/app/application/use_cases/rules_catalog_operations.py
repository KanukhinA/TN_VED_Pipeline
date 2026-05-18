"""Use case'ы каталога правил: список, CRUD, конфликты, семантика, эталоны."""

from __future__ import annotations

import statistics
from datetime import datetime
from typing import Any, Dict, Optional
import uuid

from ...db.models import Rule, RuleReferenceExample, RuleVersion
from ...rules.compiler import compile_rule
from ...rules.dsl_models import RuleDSL
from ..dto.rules_catalog import (
    CloneRuleRequest,
    CreateRuleResponse,
    ReferenceExampleBulkIn,
    ReferenceExampleBulkOut,
    RuleConflictsResponse,
    RuleListItem,
)
from ..ports.repositories import RuleCatalogRepositoryPort
from ..services.classification_conflicts import classification_conflict_items_for_rules
from ..services.dsl_meta import meta_tn_ved_group_code
from ..services.feature_extraction_meta import validate_feature_extraction_configs
from ..services.rule_clone import clone_copy_name, make_unique_clone_model_id
from ..services.rule_list import catalog_row_matches_search, rule_list_sort_key
from ..services.semantic_threshold import token_jaccard


def _normalize_reference_description(raw: str) -> str:
    desc = (raw or "").strip()
    return desc if desc else "(без описания)"


def _classification_class_ids_from_dsl(dsl: RuleDSL) -> set[str]:
    c = dsl.classification
    if c is None or not c.rules:
        return set()
    out: set[str] = set()
    for r in c.rules:
        cid = str(r.class_id).strip().lower()
        if cid:
            out.add(cid)
    return out


def _parse_and_compile_dsl(dsl_in: dict[str, Any]) -> RuleDSL:
    try:
        dsl = RuleDSL.model_validate(dsl_in)
        _ = compile_rule(dsl)
    except Exception as e:
        raise ValueError(f"Invalid DSL: {e}") from e
    return dsl


def _require_tn_ved_group(dsl: RuleDSL) -> None:
    if dsl.meta is None or not dsl.meta.tn_ved_group_code:
        raise ValueError(
            "Invalid DSL: meta.tn_ved_group_code is required (код ТН ВЭД ЕАЭС: 2, 4, 6, 8 или 10 цифр, глава 01–97)"
        )


class ListRulesUseCase:
    """Список активных справочников с поиском."""

    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, *, q: Optional[str], include_archived: bool) -> list[RuleListItem]:
        rows = self._repo.list_catalog_with_active_version(include_archived=include_archived)
        qn = (q or "").strip().lower()
        result: list[RuleListItem] = []
        for rule, rv in rows:
            dsl_json = rv.dsl_json if isinstance(rv.dsl_json, dict) else {}
            tn = meta_tn_ved_group_code(dsl_json)
            if not catalog_row_matches_search(
                model_id=rule.model_id,
                name=rule.name,
                tn_ved_group_code=tn,
                q_normalized=qn,
            ):
                continue
            result.append(
                RuleListItem(
                    rule_id=rule.id,
                    model_id=rule.model_id,
                    name=rule.name,
                    description=rule.description,
                    tn_ved_group_code=tn,
                    version=rv.version,
                    created_at=rv.created_at,
                    is_archived=rule.is_archived,
                )
            )
        result.sort(key=rule_list_sort_key)
        return result


class CreateRuleUseCase:
    """Создание справочника и первой активной версии."""

    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, dsl_in: Dict[str, Any]) -> CreateRuleResponse:
        dsl = _parse_and_compile_dsl(dsl_in)
        validate_feature_extraction_configs(dsl.meta)
        _require_tn_ved_group(dsl)
        created_at = datetime.utcnow()
        meta = dsl.meta
        rule = Rule(
            model_id=dsl.model_id,
            name=meta.name if meta else None,
            description=meta.description if meta else None,
            created_at=created_at,
        )
        self._repo.add(rule)
        self._repo.flush()
        dsl_json = dsl.model_dump(by_alias=True, exclude_none=True)
        rv = RuleVersion(
            rule_id=rule.id,
            version=1,
            is_active=True,
            model_id=dsl.model_id,
            dsl_json=dsl_json,
            created_at=created_at,
        )
        self._repo.add(rv)
        return CreateRuleResponse(
            rule_id=rule.id,
            version=1,
            dsl=dsl_json,
            created_at=created_at,
        )


class UpdateRuleUseCase:
    """Новая активная версия DSL существующего справочника."""

    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, rule_id: uuid.UUID, dsl_in: Dict[str, Any]) -> CreateRuleResponse:
        rule = self._repo.get_rule(rule_id)
        if rule is None:
            raise LookupError("Rule not found")
        dsl = _parse_and_compile_dsl(dsl_in)
        validate_feature_extraction_configs(dsl.meta)
        _require_tn_ved_group(dsl)
        for v in self._repo.list_active_versions_for_rule(rule_id):
            v.is_active = False
        latest = self._repo.latest_rule_version(rule_id)
        next_version = (latest.version if latest else 0) + 1
        created_at = datetime.utcnow()
        dsl_json = dsl.model_dump(by_alias=True, exclude_none=True)
        meta = dsl.meta
        rule.model_id = dsl.model_id
        rule.name = meta.name if meta else None
        rule.description = meta.description if meta else None
        rv = RuleVersion(
            rule_id=rule.id,
            version=next_version,
            is_active=True,
            model_id=dsl.model_id,
            dsl_json=dsl_json,
            created_at=created_at,
        )
        self._repo.add(rv)
        return CreateRuleResponse(
            rule_id=rule.id,
            version=next_version,
            dsl=dsl_json,
            created_at=created_at,
        )


class CloneRuleUseCase:
    """Клон активной версии в новый Rule."""

    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, rule_id: uuid.UUID, req: CloneRuleRequest) -> CreateRuleResponse:
        source_rule = self._repo.get_rule(rule_id)
        if source_rule is None:
            raise LookupError("Source rule not found")
        source_version = self._repo.get_active_rule_version(rule_id)
        if source_version is None:
            raise LookupError("Source active version not found")
        dsl_json = dict(source_version.dsl_json) if isinstance(source_version.dsl_json, dict) else {}
        meta = dsl_json.get("meta", {}) if isinstance(dsl_json.get("meta"), dict) else {}
        if req.name:
            meta["name"] = req.name
        else:
            source_name = source_rule.name or meta.get("name")
            meta["name"] = clone_copy_name(str(source_name) if source_name else None)
        dsl_json["meta"] = meta
        if req.model_id:
            dsl_json["model_id"] = req.model_id
        else:
            source_model_id = str(dsl_json.get("model_id") or source_rule.model_id or "").strip()
            dsl_json["model_id"] = make_unique_clone_model_id(self._repo, source_model_id)
        try:
            dsl = RuleDSL.model_validate(dsl_json)
            _ = compile_rule(dsl)
        except Exception as e:
            raise ValueError(f"Invalid DSL clone: {e}") from e
        validate_feature_extraction_configs(dsl.meta)
        created_at = datetime.utcnow()
        rule = Rule(
            model_id=dsl.model_id,
            name=meta.get("name"),
            description=meta.get("description"),
            created_at=created_at,
        )
        self._repo.add(rule)
        self._repo.flush()
        dumped = dsl.model_dump(by_alias=True, exclude_none=True)
        rv = RuleVersion(
            rule_id=rule.id,
            version=1,
            is_active=True,
            model_id=dsl.model_id,
            dsl_json=dumped,
            created_at=created_at,
        )
        self._repo.add(rv)
        return CreateRuleResponse(
            rule_id=rule.id,
            version=1,
            dsl=dumped,
            created_at=created_at,
        )


class ArchiveRuleUseCase:
    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, rule_id: uuid.UUID) -> dict[str, bool]:
        rule = self._repo.get_rule(rule_id)
        if rule is None:
            raise LookupError("Rule not found")
        rule.is_archived = True
        return {"ok": True}


class UnarchiveRuleUseCase:
    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, rule_id: uuid.UUID) -> dict[str, bool]:
        rule = self._repo.get_rule(rule_id)
        if rule is None:
            raise LookupError("Rule not found")
        rule.is_archived = False
        return {"ok": True}


class DeleteRuleUseCase:
    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, rule_id: uuid.UUID) -> dict[str, bool]:
        rule = self._repo.get_rule(rule_id)
        if rule is None:
            raise LookupError("Rule not found")
        self._repo.delete(rule)
        return {"ok": True}


class GetClassificationConflictsUseCase:
    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, rule_id: uuid.UUID) -> RuleConflictsResponse:
        rv = self._repo.get_active_rule_version(rule_id)
        if rv is None:
            raise LookupError("Active rule version not found")
        try:
            dsl = RuleDSL.model_validate(rv.dsl_json)
        except Exception as e:
            raise RuntimeError(f"Rule parse failed: {e}") from e
        clf = dsl.classification
        rules = list(clf.rules) if clf and clf.rules else []
        conflicts = classification_conflict_items_for_rules(rules)
        return RuleConflictsResponse(has_conflicts=len(conflicts) > 0, conflicts=conflicts)


class GetSemanticThresholdUseCase:
    def __init__(self, repo: RuleCatalogRepositoryPort, *, global_default: float) -> None:
        self._repo = repo
        self._global_default = global_default

    def execute(self, rule_id: uuid.UUID) -> Dict[str, Any]:
        rule = self._repo.get_rule(rule_id)
        if rule is None:
            raise LookupError("Rule not found")
        rows = self._repo.list_reference_examples_ordered(rule_id)
        if len(rows) < 2:
            return {
                "threshold": None,
                "source": "global_fallback",
                "n_examples": len(rows),
                "n_pairs": 0,
                "global_default_hint": self._global_default,
                "reason": "need_at_least_two_examples",
            }
        by_class: dict[str, list[str]] = {}
        for r in rows:
            cid = str(r.assigned_class_id or "").strip()
            if not cid:
                continue
            by_class.setdefault(cid, []).append(r.description_text or "")
        sims: list[float] = []
        for texts in by_class.values():
            if len(texts) < 2:
                continue
            for i in range(len(texts)):
                for j in range(i + 1, len(texts)):
                    sims.append(token_jaccard(texts[i], texts[j]))
        if not sims:
            return {
                "threshold": None,
                "source": "global_fallback",
                "n_examples": len(rows),
                "n_pairs": 0,
                "global_default_hint": self._global_default,
                "reason": "no_intra_class_pairs",
            }
        med = float(statistics.median(sims))
        calibrated = max(0.35, min(0.92, med * 0.85))
        return {
            "threshold": calibrated,
            "source": "reference_examples",
            "n_examples": len(rows),
            "n_pairs": len(sims),
            "median_intra_class_similarity": med,
            "global_default_hint": self._global_default,
        }


class ListReferenceExamplesUseCase:
    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, rule_id: uuid.UUID) -> Dict[str, Any]:
        rule = self._repo.get_rule(rule_id)
        if rule is None:
            raise LookupError("Rule not found")
        rows = self._repo.list_reference_examples_ordered(rule_id)
        ids = [r.id for r in rows]
        emb_rows = self._repo.list_embeddings_for_example_ids(ids)
        emb_by_ref = {e.reference_example_id: e for e in emb_rows}
        return {
            "examples": [
                {
                    "id": str(r.id),
                    "rule_id": str(r.rule_id),
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                    "description_text": r.description_text,
                    "features_json": r.features_json,
                    "assigned_class_id": r.assigned_class_id,
                    "embedding_model": emb_by_ref[r.id].embedding_model if r.id in emb_by_ref else None,
                    "embedding": emb_by_ref[r.id].embedding_json.get("vector")
                    if r.id in emb_by_ref and isinstance(emb_by_ref[r.id].embedding_json, dict)
                    else None,
                }
                for r in rows
            ]
        }


class BulkReferenceExamplesUseCase:
    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(
        self, rule_id: uuid.UUID, body: ReferenceExampleBulkIn
    ) -> tuple[ReferenceExampleBulkOut, list[RuleReferenceExample]]:
        rule = self._repo.get_rule(rule_id)
        if rule is None:
            raise LookupError("Rule not found")
        rv = self._repo.get_active_rule_version(rule_id)
        if rv is None:
            raise LookupError("Active rule version not found")
        try:
            dsl = RuleDSL.model_validate(rv.dsl_json)
            compiled = compile_rule(dsl)
        except Exception as e:
            raise RuntimeError(f"Rule compilation failed: {e}") from e
        allowed_classes = _classification_class_ids_from_dsl(dsl)
        seen_descriptions = set(self._repo.reference_example_normalized_descriptions(rule_id))
        inserted = 0
        skipped: list[dict[str, Any]] = []
        inserted_rows: list[RuleReferenceExample] = []
        for idx, item in enumerate(body.items):
            desc = _normalize_reference_description(item.description_text or "")
            if desc in seen_descriptions:
                skipped.append(
                    {
                        "index": idx,
                        "reason": "duplicate_description_text",
                        "detail": "example with identical description_text already exists; existing record is preserved",
                    }
                )
                continue
            ok, errors, validated_data, assigned_class = compiled.validate(item.data)
            if not ok:
                skipped.append(
                    {
                        "index": idx,
                        "reason": "validation_failed",
                        "errors": errors,
                    }
                )
                continue
            expert_raw = (item.assigned_class_id or "").strip()
            expert_norm = expert_raw.lower() if expert_raw else ""
            if expert_norm:
                if expert_norm not in allowed_classes:
                    skipped.append(
                        {
                            "index": idx,
                            "reason": "invalid_class_override",
                            "detail": "assigned_class_id must match a classification rule class_id",
                        }
                    )
                    continue
                final_class = expert_norm
            else:
                if not assigned_class:
                    skipped.append(
                        {
                            "index": idx,
                            "reason": "no_class",
                            "errors": None,
                        }
                    )
                    continue
                final_class = str(assigned_class)
            row = RuleReferenceExample(
                rule_id=rule_id,
                description_text=desc[:500_000],
                features_json=validated_data if isinstance(validated_data, dict) else item.data,
                assigned_class_id=final_class,
            )
            self._repo.add(row)
            inserted_rows.append(row)
            seen_descriptions.add(desc)
            inserted += 1
        return ReferenceExampleBulkOut(inserted=inserted, skipped=skipped), inserted_rows


class DeleteReferenceExampleUseCase:
    def __init__(self, repo: RuleCatalogRepositoryPort) -> None:
        self._repo = repo

    def execute(self, rule_id: uuid.UUID, example_id: uuid.UUID) -> dict[str, str]:
        row = self._repo.get_reference_example(rule_id, example_id)
        if row is None:
            raise LookupError("Example not found")
        self._repo.delete(row)
        return {"status": "ok"}
