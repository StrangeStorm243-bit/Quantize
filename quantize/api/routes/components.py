"""Component-definition endpoints: save (immutable, idempotent), list, load verbatim by SemVer.

Same posture as the strategy routes: Rust-path validation, client ``invalid_artifact`` → 422
locally, and verbatim stored-bytes loads. The component version is a SemVer STRING path parameter.
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status

from quantize.api.dto.documents import ComponentList, ComponentListRow, ComponentSaved
from quantize.api.errors import ApiRequestError
from quantize.api.parsing import JsonBody, SettingsDep, load_ir_document
from quantize.persistence.database import Database
from quantize.persistence.documents import ComponentRepository
from quantize.persistence.errors import ARTIFACT_NOT_FOUND, INVALID_ARTIFACT, PersistenceError
from quantize.schema.components import ComponentDefinition
from quantize.schema.serialization import to_ir_json

router = APIRouter(prefix="/v1/components", tags=["components"])


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
    definition = load_ir_document(body, ComponentDefinition)
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
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
