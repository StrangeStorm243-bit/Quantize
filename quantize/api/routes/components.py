"""Component-definition endpoints: save (immutable, idempotent), list, load verbatim by SemVer.

Same posture as the strategy routes: Rust-path validation, client ``invalid_artifact`` → 422
locally, and verbatim stored-bytes loads. The component version is a SemVer STRING path parameter.
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status

from quantize.api.dto.documents import ComponentList, ComponentListRow, ComponentSaved
from quantize.api.errors import ApiRequestError
from quantize.api.parsing import JsonBody, SettingsDep, load_ir_document
from quantize.api.service import load_component_catalog
from quantize.components.resolve import diagnose_component_definition
from quantize.nodes import build_core_catalog
from quantize.persistence.database import Database
from quantize.persistence.documents import ComponentRepository
from quantize.persistence.errors import ARTIFACT_NOT_FOUND, INVALID_ARTIFACT, PersistenceError
from quantize.runtime.diagnostics import RuntimeDiagnostic
from quantize.schema.components import ComponentDefinition
from quantize.schema.serialization import to_ir_json

router = APIRouter(prefix="/v1/components", tags=["components"])

COMPONENT_DEFINITION_INVALID = "component_definition_invalid"


def _summarize(diagnostics: list[RuntimeDiagnostic]) -> str:
    """A single client-facing message from the ordered save-validation diagnostics: the first
    fault, plus a count of any that follow (the full set is deterministic but a 422 body carries
    one message — the first is the highest-priority per ``sort_runtime_diagnostics``)."""
    head = diagnostics[0]
    message = f"{head.code}: {head.message}"
    remaining = len(diagnostics) - 1
    if remaining:
        message += f" (+{remaining} more)"
    return message


def _component_exists(repo: ComponentRepository, component_id: str, version: str) -> bool:
    """Whether a component is already stored under this key (a divergent one would make save()
    raise ARTIFACT_CONFLICT → 409; identical is the idempotent-200 case)."""
    try:
        repo.load(component_id, version)
    except PersistenceError as error:
        if error.code == ARTIFACT_NOT_FOUND:
            return False
        raise
    return True


@router.post("", status_code=status.HTTP_201_CREATED)
def save_component(body: JsonBody, settings: SettingsDep, response: Response) -> ComponentSaved:
    definition = load_ir_document(body, ComponentDefinition)  # 400 parse/shape, 422 version
    registry = build_core_catalog().descriptor_registry
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        # Semantic validation BEFORE the immutable save: fetch this definition's own nested closure
        # from the store and run the same definition-level checks resolution runs. A broken
        # definition (unknown internal type, bad exposed-port wiring, self/transitive recursion,
        # dangling nested ref) is rejected here — the immutable store never sees it. A no-refs
        # component yields an empty closure (no extra reads), but the DB is already open for save.
        catalog = load_component_catalog(db, definition)
        diagnostics = diagnose_component_definition(definition, catalog, registry)
        if diagnostics:
            raise ApiRequestError(422, COMPONENT_DEFINITION_INVALID, _summarize(diagnostics))
        repo = ComponentRepository(db)
        existed = _component_exists(repo, definition.component_id, definition.version)
        try:
            key = repo.save(definition)
        except PersistenceError as error:
            if error.code == INVALID_ARTIFACT:
                raise ApiRequestError(422, INVALID_ARTIFACT, error.message) from error
            raise
    response.status_code = status.HTTP_200_OK if existed else status.HTTP_201_CREATED
    return ComponentSaved(component_id=key.component_id, version=key.version)


@router.get("")
def list_components(settings: SettingsDep) -> ComponentList:
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        summaries = ComponentRepository(db).list_components()
    return ComponentList(
        components=tuple(
            ComponentListRow(
                component_id=c.component_id,
                version=c.version,
                name=c.name,
                schema_version=c.schema_version,
                saved_at=c.saved_at,
            )
            for c in summaries
        )
    )


@router.get("/{component_id}/versions/{version}")
def load_component(component_id: str, version: str, settings: SettingsDep) -> Response:
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        definition = ComponentRepository(db).load(component_id, version)
    return Response(content=to_ir_json(definition), media_type="application/json")
