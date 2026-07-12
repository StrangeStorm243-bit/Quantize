"""Run submission + result/trace/list endpoints.

Submissions execute synchronously (v0) and persist honest facts — an ``ok:false`` run still
persists and returns 201; the client reads ``ok`` from fetch-results. Fetch-results returns the
stored record VERBATIM: the handler embeds ``to_ir_json(record)`` directly (byte-fidelity), with
``replay_verifiable`` beside it — never inside it, never re-encoded through the model encoder.
"""

from __future__ import annotations

import json
import re
from datetime import date

from fastapi import APIRouter, Response, status

from quantize.api.dto.runs import (
    BacktestRunRequest,
    ForwardRunRequest,
    RunCreated,
    RunList,
    RunListRow,
    TraceResponse,
)
from quantize.api.dto.trace_tree import TraceTreeResponse, trace_tree_dto
from quantize.api.dto.values import NodeValueResponse, node_value_dto
from quantize.api.errors import ApiRequestError
from quantize.api.parsing import JsonBody, SettingsDep, load_dto
from quantize.api.service import execute_backtest_run, execute_forward_run
from quantize.persistence.database import Database
from quantize.persistence.provenance import (
    CALENDAR_MISMATCH,
    DATASET_MISMATCH,
    PROVENANCE_RECORDED,
    UNKNOWN_PROVENANCE,
)
from quantize.persistence.runs import RunRepository
from quantize.runtime.summarize import summarize
from quantize.schema.serialization import to_ir_json
from quantize.tracing.tree import build_trace_trees
from quantize.valuetap import (
    AMBIGUOUS_OUTPUT_PORT,
    ENGINE_DRIFT,
    NO_EVALUATION_AT_SESSION,
    RECOMPUTE_FAILED,
    VALUE_ADDRESS_NOT_FOUND,
    ValueTapError,
    resolve_node_value,
)

router = APIRouter(prefix="/v1/runs", tags=["runs"])

# Value-address request fault + the identifier pattern each address segment must match. The pattern
# is the same as ``_IDENT`` in quantize/schema/primitives.py (module-private there); re-stated here
# so the route validates component_path segments / node_id / output_port exactly as the IR does.
INVALID_VALUE_ADDRESS = "invalid_value_address"
_VALUE_ADDRESS_SEGMENT = re.compile(r"^[A-Za-z0-9_]+$")

# ValueTapError code -> HTTP status (the M14 plan's table). Keyed by the imported code constants so
# a renamed code fails at import, never silently. An unknown code defaults to 500 (defensive,
# mirroring quantize/api/errors.py's persistence-code map).
_STATUS_FOR_VALUE_TAP_CODE: dict[str, int] = {
    VALUE_ADDRESS_NOT_FOUND: 404,
    NO_EVALUATION_AT_SESSION: 404,
    AMBIGUOUS_OUTPUT_PORT: 422,
    UNKNOWN_PROVENANCE: 409,
    DATASET_MISMATCH: 409,
    CALENDAR_MISMATCH: 409,
    RECOMPUTE_FAILED: 409,
    ENGINE_DRIFT: 409,
}


def _validate_segment(value: str, *, label: str) -> None:
    """Reject a value-address segment that is not a bare identifier (422, request fault)."""
    if not _VALUE_ADDRESS_SEGMENT.match(value):
        raise ApiRequestError(
            422, INVALID_VALUE_ADDRESS, f"{label} {value!r} is not a valid identifier"
        )


@router.post("/backtest", status_code=status.HTTP_201_CREATED)
def submit_backtest(body: JsonBody, settings: SettingsDep) -> RunCreated:
    request = load_dto(body, BacktestRunRequest)  # extra=forbid rejects a client run_id → 422
    return RunCreated(run_id=execute_backtest_run(settings, request))


@router.post("/forward", status_code=status.HTTP_201_CREATED)
def submit_forward(body: JsonBody, settings: SettingsDep) -> RunCreated:
    request = load_dto(body, ForwardRunRequest)  # last_session required by the DTO → 422 if missing
    return RunCreated(run_id=execute_forward_run(settings, request))


@router.get("")
def list_runs(settings: SettingsDep, strategy_id: str | None = None) -> RunList:
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        summaries = RunRepository(db).list_runs(strategy_id)
    return RunList(
        runs=tuple(
            RunListRow(
                run_id=s.run_id,
                strategy_id=s.strategy_id,
                strategy_version=s.strategy_version,
                mode=s.mode,
                ok=s.ok,
                first_session=s.first_session,
                last_session=s.last_session,
                total_return=s.total_return,
                saved_at=s.saved_at,
            )
            for s in summaries
        )
    )


@router.get("/{run_id}")
def fetch_run(run_id: str, settings: SettingsDep) -> Response:
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        record = RunRepository(db).load_run(run_id)
    replay_verifiable = record.input_provenance.status == PROVENANCE_RECORDED
    # Verbatim stored record bytes embedded as the ``record`` value; ``replay_verifiable`` beside
    # it. Shape matches RunRecordResponse (the governed contract) without re-encoding the record.
    record_text = to_ir_json(record)
    flag = json.dumps(replay_verifiable)
    envelope = f'{{"record":{record_text},"replay_verifiable":{flag}}}'
    return Response(content=envelope, media_type="application/json")


@router.get("/{run_id}/trace")
def fetch_trace(
    run_id: str, settings: SettingsDep, session_date: date | None = None
) -> TraceResponse:
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        events = RunRepository(db).load_trace(run_id, session_date)
    return TraceResponse(events=events)


@router.get("/{run_id}/trace-tree")
def fetch_trace_tree(
    run_id: str, settings: SettingsDep, session_date: date | None = None
) -> TraceTreeResponse:
    """The run's trace as per-instant trees (M13.6) — ``build_trace_trees`` over the SAME
    stored flat stream ``/trace`` serves, with identical ``session_date`` semantics. A pure
    projection: no stored format, no engine fact, and no ordering is re-decided here. Unknown
    runs 404 via ``load_trace``'s not-found fault; a malformed ``session_date`` 422s in query
    parsing — both exactly as the flat endpoint behaves."""
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        events = RunRepository(db).load_trace(run_id, session_date)
    return TraceTreeResponse(
        trees=tuple(trace_tree_dto(tree) for tree in build_trace_trees(events))
    )


@router.get("/{run_id}/values")
def fetch_node_value(
    run_id: str,
    node_id: str,
    session_date: date,
    settings: SettingsDep,
    component_path: str | None = None,
    output_port: str | None = None,
) -> NodeValueResponse:
    """The value a node's output port produced at a session (M14.1c) — a pure projection over the
    run's stored facts plus a bounded recompute-on-demand through the ONE evaluator
    (``resolve_node_value``); no stored value is read, nothing is written. The address is validated
    here (comma-split ``component_path``; every segment / ``node_id`` / a present ``output_port``
    must be a bare identifier — else 422 ``invalid_value_address``); a malformed ``session_date``
    422s in query parsing. ``ValueTapError`` codes map to the M14 status table (404 address /
    no-eval; 422 ambiguous port; 409 provenance / dataset / calendar / recompute / drift refusals)
    with only ``code`` + ``message`` crossing the wire. An unknown run raises ``PersistenceError``
    unwrapped — the global handler renders it 404 ``artifact_not_found``, as the trace endpoints."""
    segments = tuple(component_path.split(",")) if component_path else ()
    for segment in segments:
        _validate_segment(segment, label="component path segment")
    _validate_segment(node_id, label="node_id")
    if output_port is not None:
        _validate_segment(output_port, label="output_port")
    try:
        with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
            resolved = resolve_node_value(
                db,
                run_id=run_id,
                node_id=node_id,
                session_date=session_date,
                component_path=segments,
                output_port=output_port,
            )
    except ValueTapError as error:
        # Only code + message cross the wire — subject/diagnostics never leave the boundary.
        raise ApiRequestError(
            _STATUS_FOR_VALUE_TAP_CODE.get(error.code, 500), error.code, error.message
        ) from error
    return node_value_dto(
        summarize(resolved.value),
        node_id=resolved.node_id,
        component_path=resolved.component_path,
        session_date=resolved.session_date,
        output_port=resolved.output_port,
        run_id=resolved.run_id,
        dataset_fingerprint=resolved.dataset_fingerprint,
        captured=resolved.captured,
    )
