"""The run-faithful validate endpoint.

Runs the SAME ``run_document_preflight`` the evaluator runs (the no-second-implementation
guarantee), projecting its native per-layer diagnostics — loc-aware — onto ``ValidateResponse``.
A semantically-invalid but parseable document is a 200 with ``ok:false`` (its faults are run
FACTS, not HTTP errors); only a parse/shape failure (400) or an unsupported ``schema_version``
(422) is an HTTP error. On ``ok:true`` the resolved warm-up requirement is reported (no market
data needed). No database, no numerics — pure translation.
"""

from __future__ import annotations

from fastapi import APIRouter

from quantize.api.dto.validate import (
    RuntimeDiagnosticDto,
    SemanticDiagnosticDto,
    StructuralDiagnosticDto,
    ValidateResponse,
)
from quantize.api.parsing import JsonBody, SettingsDep, load_ir_document
from quantize.api.service import load_component_catalog
from quantize.components.resolve import ComponentCatalog
from quantize.evaluator.plan import resolve_warmup
from quantize.evaluator.preflight import run_document_preflight
from quantize.nodes import build_core_catalog
from quantize.persistence.database import Database
from quantize.schema.document import StrategyDocument

router = APIRouter(prefix="/v1/strategies", tags=["strategies"])


@router.post("/validate")
def validate_strategy(body: JsonBody, settings: SettingsDep) -> ValidateResponse:
    document = load_ir_document(body, StrategyDocument)  # 400 parse/shape, 422 version
    catalog = build_core_catalog()
    # Only touch the store when the document actually pins components — a no-refs strategy keeps the
    # DB-free fast path (opening ``Database(path)`` would auto-create the file for nothing).
    if document.component_refs:
        with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
            components = load_component_catalog(db, document)
    else:
        components = ComponentCatalog()
    preflight = run_document_preflight(
        document, registry=catalog.descriptor_registry, components=components
    )
    warmup_sessions = (
        resolve_warmup(document, catalog, preflight.resolution).total if preflight.ok else None
    )
    return ValidateResponse(
        ok=preflight.ok,
        structural=tuple(
            StructuralDiagnosticDto(
                code=error.code, message=error.message, loc=error.loc, subject=error.subject
            )
            for error in preflight.structural
        ),
        semantic=tuple(
            SemanticDiagnosticDto(
                code=finding.code,
                message=finding.message,
                loc=finding.loc,
                subject=finding.subject,
            )
            for finding in preflight.semantic
        ),
        runtime=tuple(
            RuntimeDiagnosticDto(
                code=diag.code,
                message=diag.message,
                node_path=diag.node_path,
                subject=diag.subject,
            )
            for diag in preflight.runtime
        ),
        warmup_sessions=warmup_sessions,
    )
