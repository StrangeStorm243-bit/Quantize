"""Strategy-document endpoints: save (immutable, idempotent), list, list versions, load verbatim.

Saves validate the raw body on the Rust path and persist via ``StrategyRepository``; a client-caused
``invalid_artifact`` is re-mapped to 422 locally (the split mechanism — the global handler defaults
that code to 500, reachable only via server-internal invariants). Loads return the stored canonical
bytes VERBATIM via a raw ``Response`` — never re-encoded through FastAPI's model encoder, which does
not reproduce ``to_ir_json``'s compact aliased form.
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status

from quantize.api.dto.documents import (
    StrategyList,
    StrategyListRow,
    StrategySaved,
    VersionList,
)
from quantize.api.errors import ApiRequestError
from quantize.api.parsing import JsonBody, SettingsDep, load_ir_document
from quantize.persistence.database import Database
from quantize.persistence.documents import StrategyRepository
from quantize.persistence.errors import (
    ARTIFACT_NOT_FOUND,
    INVALID_ARTIFACT,
    PersistenceError,
)
from quantize.schema.document import StrategyDocument
from quantize.schema.serialization import to_ir_json

router = APIRouter(prefix="/v1/strategies", tags=["strategies"])


@router.post("", status_code=status.HTTP_201_CREATED)
def save_strategy(body: JsonBody, settings: SettingsDep, response: Response) -> StrategySaved:
    document = load_ir_document(body, StrategyDocument)
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        repo = StrategyRepository(db)
        try:
            # ``pending is None`` ⇒ a byte-identical version is already stored (idempotent → 200);
            # a divergent version under the same key raises ARTIFACT_CONFLICT here (→ 409). save()
            # then does the actual (idempotent) persistence.
            key, pending = repo.prepare_save(document)
            repo.save(document)
        except PersistenceError as error:
            # Client-save invalid content is a 422 here (not the global 500 default for the code).
            if error.code == INVALID_ARTIFACT:
                raise ApiRequestError(422, INVALID_ARTIFACT, error.message) from error
            raise
    response.status_code = status.HTTP_200_OK if pending is None else status.HTTP_201_CREATED
    return StrategySaved(strategy_id=key.strategy_id, version=key.version)


@router.get("")
def list_strategies(settings: SettingsDep) -> StrategyList:
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        summaries = StrategyRepository(db).list_strategies()
    return StrategyList(
        strategies=tuple(
            StrategyListRow(
                strategy_id=s.strategy_id,
                version=s.version,
                name=s.name,
                schema_version=s.schema_version,
                saved_at=s.saved_at,
            )
            for s in summaries
        )
    )


@router.get("/{strategy_id}/versions")
def list_versions(strategy_id: str, settings: SettingsDep) -> VersionList:
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        versions = StrategyRepository(db).list_versions(strategy_id)
    if not versions:
        raise ApiRequestError(
            404, ARTIFACT_NOT_FOUND, f"strategy {strategy_id!r} has no stored versions"
        )
    return VersionList(versions=versions)


@router.get("/{strategy_id}/versions/{version}")
def load_strategy(strategy_id: str, version: int, settings: SettingsDep) -> Response:
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        document = StrategyRepository(db).load(strategy_id, version)
    # Stored-bytes verbatim: to_ir_json reproduces the exact persisted canonical form.
    return Response(content=to_ir_json(document), media_type="application/json")
