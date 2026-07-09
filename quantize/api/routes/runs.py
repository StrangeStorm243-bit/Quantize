"""Run submission + result/trace/list endpoints.

Submissions execute synchronously (v0) and persist honest facts — an ``ok:false`` run still
persists and returns 201; the client reads ``ok`` from fetch-results. Fetch-results returns the
stored record VERBATIM: the handler embeds ``to_ir_json(record)`` directly (byte-fidelity), with
``replay_verifiable`` beside it — never inside it, never re-encoded through the model encoder.
"""

from __future__ import annotations

import json
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
from quantize.api.parsing import JsonBody, SettingsDep, load_dto
from quantize.api.service import execute_backtest_run, execute_forward_run
from quantize.persistence.database import Database
from quantize.persistence.provenance import PROVENANCE_RECORDED
from quantize.persistence.runs import RunRepository
from quantize.schema.serialization import to_ir_json
from quantize.tracing.tree import build_trace_trees

router = APIRouter(prefix="/v1/runs", tags=["runs"])


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
