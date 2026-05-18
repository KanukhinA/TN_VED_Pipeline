"""Composition root: фабрики use case с SQLAlchemy-репозиториями на сессию запроса.

Связывает HTTP-слой (`api.routes_*`) с application-слоем без Service Locator:
кадая функция принимает `Session` из FastAPI Depends и возвращает готовый use case.
"""

from __future__ import annotations

import os

from sqlalchemy.orm import Session

from .application.use_cases.expert_decisions import CreateExpertDecisionUseCase
from .application.use_cases.expert_decisions_query import ListExpertDecisionsUseCase, PatchExpertDecisionUseCase
from .application.use_cases.feature_extraction_settings import (
    GetFeatureExtractionSettingsUseCase,
    PutFeatureExtractionSettingsUseCase,
)
from .application.use_cases.rules_catalog import GetRuleWithActiveVersionUseCase, ValidateRuleUseCase
from .application.use_cases.rules_catalog_operations import (
    ArchiveRuleUseCase,
    BulkReferenceExamplesUseCase,
    CloneRuleUseCase,
    CreateRuleUseCase,
    DeleteReferenceExampleUseCase,
    DeleteRuleUseCase,
    GetClassificationConflictsUseCase,
    GetSemanticThresholdUseCase,
    ListReferenceExamplesUseCase,
    ListRulesUseCase,
    UnarchiveRuleUseCase,
    UpdateRuleUseCase,
)
from .infrastructure.repositories.sqlalchemy_app_settings import SqlAlchemyAppSettingsRepository
from .infrastructure.repositories.sqlalchemy_expert_decisions import SqlAlchemyExpertDecisionRepository
from .infrastructure.repositories.sqlalchemy_rule_catalog import SqlAlchemyRuleCatalogRepository
from .rules.compiler import compile_rule
from .rules.dsl_models import RuleDSL


SETTINGS_KEY = "feature_extraction_model_settings_v1"


def create_expert_decision_use_case(db: Session) -> CreateExpertDecisionUseCase:
    return CreateExpertDecisionUseCase(SqlAlchemyExpertDecisionRepository(db))


def list_expert_decisions_use_case(db: Session) -> ListExpertDecisionsUseCase:
    return ListExpertDecisionsUseCase(SqlAlchemyExpertDecisionRepository(db))


def patch_expert_decisions_use_case(db: Session) -> PatchExpertDecisionUseCase:
    return PatchExpertDecisionUseCase(SqlAlchemyExpertDecisionRepository(db))


def get_rule_with_active_version_use_case(db: Session) -> GetRuleWithActiveVersionUseCase:
    return GetRuleWithActiveVersionUseCase(SqlAlchemyRuleCatalogRepository(db))


def validate_rule_use_case(db: Session) -> ValidateRuleUseCase:
    return ValidateRuleUseCase(
        repo=SqlAlchemyRuleCatalogRepository(db),
        compiler=lambda dsl_json: compile_rule(RuleDSL.model_validate(dsl_json)),
    )


def _rule_catalog_repo(db: Session) -> SqlAlchemyRuleCatalogRepository:
    return SqlAlchemyRuleCatalogRepository(db)


def list_rules_use_case(db: Session) -> ListRulesUseCase:
    return ListRulesUseCase(_rule_catalog_repo(db))


def create_rule_use_case(db: Session) -> CreateRuleUseCase:
    return CreateRuleUseCase(_rule_catalog_repo(db))


def update_rule_use_case(db: Session) -> UpdateRuleUseCase:
    return UpdateRuleUseCase(_rule_catalog_repo(db))


def clone_rule_use_case(db: Session) -> CloneRuleUseCase:
    return CloneRuleUseCase(_rule_catalog_repo(db))


def archive_rule_use_case(db: Session) -> ArchiveRuleUseCase:
    return ArchiveRuleUseCase(_rule_catalog_repo(db))


def unarchive_rule_use_case(db: Session) -> UnarchiveRuleUseCase:
    return UnarchiveRuleUseCase(_rule_catalog_repo(db))


def delete_rule_use_case(db: Session) -> DeleteRuleUseCase:
    return DeleteRuleUseCase(_rule_catalog_repo(db))


def get_classification_conflicts_use_case(db: Session) -> GetClassificationConflictsUseCase:
    return GetClassificationConflictsUseCase(_rule_catalog_repo(db))


def get_semantic_threshold_use_case(db: Session) -> GetSemanticThresholdUseCase:
    return GetSemanticThresholdUseCase(
        _rule_catalog_repo(db),
        global_default=float(os.getenv("SEMANTIC_SIMILARITY_THRESHOLD", "0.75")),
    )


def list_reference_examples_use_case(db: Session) -> ListReferenceExamplesUseCase:
    return ListReferenceExamplesUseCase(_rule_catalog_repo(db))


def bulk_reference_examples_use_case(db: Session) -> BulkReferenceExamplesUseCase:
    return BulkReferenceExamplesUseCase(_rule_catalog_repo(db))


def delete_reference_example_use_case(db: Session) -> DeleteReferenceExampleUseCase:
    return DeleteReferenceExampleUseCase(_rule_catalog_repo(db))


def get_feature_extraction_settings_use_case(db: Session, defaults_provider):
    return GetFeatureExtractionSettingsUseCase(
        repo=SqlAlchemyAppSettingsRepository(db),
        settings_key=SETTINGS_KEY,
        defaults_provider=defaults_provider,
    )


def put_feature_extraction_settings_use_case(db: Session) -> PutFeatureExtractionSettingsUseCase:
    return PutFeatureExtractionSettingsUseCase(
        repo=SqlAlchemyAppSettingsRepository(db),
        settings_key=SETTINGS_KEY,
    )
