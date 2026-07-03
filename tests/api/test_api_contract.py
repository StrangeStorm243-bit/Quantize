"""M9.3: cross-language contract checks on the *committed* API artifacts.

Mirrors the IR contract test: the committed ``quantize-api.schema.json`` is a valid Draft 2020-12
document, and a representative payload per DTO — built by the pydantic model but validated by an
INDEPENDENT ``jsonschema`` validator against the committed schema — is accepted. Also pins the
intentional mixed ``loc`` array and asserts this packet left the IR bundle byte-unchanged.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from quantize.api.dto.common import ApiError, MetaResponse
from quantize.api.dto.datasets import (
    CalendarDto,
    DatasetStored,
    DatasetUpload,
    ObservationDto,
    SessionDto,
)
from quantize.api.dto.documents import (
    ComponentList,
    ComponentListRow,
    ComponentSaved,
    StrategyList,
    StrategyListRow,
    StrategySaved,
    VersionList,
)
from quantize.api.dto.runs import (
    BacktestRunRequest,
    ForwardRunRequest,
    RunCreated,
    RunList,
    RunListRow,
    RunRecordResponse,
    TraceResponse,
)
from quantize.api.dto.validate import (
    RuntimeDiagnosticDto,
    SemanticDiagnosticDto,
    StructuralDiagnosticDto,
    ValidateResponse,
)
from quantize.codegen.schema import (
    API_SCHEMA_PATH,
    API_TS_PATH,
    SCHEMA_PATH,
    build_bundle,
    build_ts_input,
    canonical_json,
)
from quantize.persistence.provenance import RunInputProvenance
from quantize.persistence.records import PersistedRunRecord
from quantize.tracing.events import TraceEvent


@pytest.fixture(scope="module")
def api_schema() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(API_SCHEMA_PATH.read_text(encoding="utf-8"))
    return data


@pytest.fixture(scope="module")
def api_ts() -> str:
    return API_TS_PATH.read_text(encoding="utf-8")


def _def_validator(api_schema: dict[str, Any], name: str) -> Draft202012Validator:
    """A validator for one DTO ``$def`` within the committed bundle (shares the bundle's $defs)."""
    return Draft202012Validator({"$defs": api_schema["$defs"], "$ref": f"#/$defs/{name}"})


def _as_json(instance: Any) -> Any:
    return instance.model_dump(mode="json", by_alias=True)


# --- the schema is a valid Draft 2020-12 document ---------------------------------------------


def test_api_schema_is_valid_draft_2020_12(api_schema: dict[str, Any]) -> None:
    Draft202012Validator.check_schema(api_schema)


def test_api_root_is_synthetic_object_not_oneof(api_schema: dict[str, Any]) -> None:
    assert api_schema["type"] == "object"
    assert "oneOf" not in api_schema


# --- a representative payload per DTO validates against the COMMITTED schema -------------------

_PROVENANCE = RunInputProvenance(status="unknown")
_RECORD = PersistedRunRecord(
    record_format=2,
    run_id="11111111-1111-1111-1111-111111111111",
    mode="backtest",
    strategy_id="s1",
    strategy_version=1,
    ok=True,
    input_provenance=_PROVENANCE,
    exchange="QSE",
    timezone="UTC-05:00",
    first_session=None,
    last_session=None,
    valuations=(),
    returns=(),
    total_return=0.0,
    max_drawdown=0.0,
    final_cash=1000.0,
    final_positions=(),
    evaluations=(),
    fills=(),
    stale_marks=(),
    notes=(),
    diagnostics=(),
)
_TRACE_EVENT = TraceEvent(
    run_id="11111111-1111-1111-1111-111111111111",
    timestamp=datetime(2026, 1, 5, 21, 0, tzinfo=UTC),
    node_id="n1",
    event_type="node.evaluated",
    payload={"k": 1},
)

_SAMPLES: dict[str, Any] = {
    "ApiError": ApiError(code="artifact_not_found", message="no such strategy"),
    "MetaResponse": MetaResponse(
        api_version="v1", schema_version="0.1.0", record_format=2, trace_format=1
    ),
    "StrategySaved": StrategySaved(strategy_id="s1", version=1),
    "StrategyList": StrategyList(
        strategies=(
            StrategyListRow(
                strategy_id="s1", version=1, name="A", schema_version="0.1.0", saved_at="t"
            ),
        )
    ),
    "VersionList": VersionList(versions=(1, 2, 3)),
    "ComponentSaved": ComponentSaved(component_id="c1", version="1.0.0"),
    "ComponentList": ComponentList(
        components=(
            ComponentListRow(
                component_id="c1", version="1.0.0", name="C", schema_version="0.1.0", saved_at="t"
            ),
        )
    ),
    "ValidateResponse": ValidateResponse(
        ok=False,
        structural=(
            StructuralDiagnosticDto(
                code="self_edge",
                message="edge is a self-loop",
                loc=("edges", 2, "from"),
                subject="n1",
            ),
        ),
        semantic=(
            SemanticDiagnosticDto(code="unknown_node_type", message="unknown", loc=("nodes", 0)),
        ),
        runtime=(
            RuntimeDiagnosticDto(code="missing_terminal_node", message="no terminal", node_path=()),
        ),
        warmup_sessions=None,
    ),
    "DatasetUpload": DatasetUpload(
        calendar=CalendarDto(
            exchange="QSE",
            timezone="UTC-05:00",
            sessions=(
                SessionDto(
                    session_date=date(2026, 1, 5),
                    open_at=datetime(2026, 1, 5, 14, 30, tzinfo=UTC),
                    close_at=datetime(2026, 1, 5, 21, 0, tzinfo=UTC),
                ),
            ),
        ),
        observations={
            "AAA": (
                ObservationDto(
                    session_date=date(2026, 1, 5),
                    open_price=10.0,
                    close_price=10.5,
                    open_available_at=datetime(2026, 1, 5, 14, 30, tzinfo=UTC),
                    close_available_at=datetime(2026, 1, 5, 21, 0, tzinfo=UTC),
                ),
            )
        },
    ),
    "DatasetStored": DatasetStored(
        dataset_id="a" * 64,
        dataset_fingerprint="b" * 64,
        calendar_fingerprint="c" * 64,
        sessions=1,
        assets=1,
    ),
    "BacktestRunRequest": BacktestRunRequest(
        strategy_id="s1",
        strategy_version=1,
        dataset_id="a" * 64,
        initial_cash=1_000_000.0,
        initial_positions={"AAA": 10.0},
        first_session=date(2025, 7, 31),
        last_session=date(2025, 8, 29),
    ),
    "ForwardRunRequest": ForwardRunRequest(
        strategy_id="s1",
        strategy_version=1,
        dataset_id="a" * 64,
        initial_cash=1_000_000.0,
        last_session=date(2025, 8, 29),
    ),
    "RunCreated": RunCreated(run_id="11111111-1111-1111-1111-111111111111"),
    "RunList": RunList(
        runs=(
            RunListRow(
                run_id="11111111-1111-1111-1111-111111111111",
                strategy_id="s1",
                strategy_version=1,
                mode="backtest",
                ok=True,
                first_session=None,
                last_session=None,
                total_return=0.0,
                saved_at="t",
            ),
        )
    ),
    "RunRecordResponse": RunRecordResponse(record=_RECORD, replay_verifiable=True),
    "TraceResponse": TraceResponse(events=(_TRACE_EVENT,)),
}


@pytest.mark.parametrize("name", sorted(_SAMPLES))
def test_representative_payload_validates(api_schema: dict[str, Any], name: str) -> None:
    payload = _as_json(_SAMPLES[name])
    errors = sorted(_def_validator(api_schema, name).iter_errors(payload), key=str)
    assert not errors, "; ".join(e.message for e in errors[:5])


def test_loc_accepts_mixed_string_and_int_array(api_schema: dict[str, Any]) -> None:
    """The ``loc`` contract is intentionally a ``(string | number)[]`` — a purely-string loc and a
    mixed string/int loc both validate."""
    validator = _def_validator(api_schema, "StructuralDiagnosticDto")
    for loc in (["nodes", "0", "field"], ["edges", 2, "from"], []):
        payload = {"code": "x", "message": "m", "loc": loc}
        assert not list(validator.iter_errors(payload)), loc


# --- extra=forbid closed objects & required fields survive generation --------------------------


def test_dtos_forbid_unknown_fields(api_schema: dict[str, Any]) -> None:
    for name in ("ApiError", "MetaResponse", "BacktestRunRequest", "DatasetUpload"):
        assert api_schema["$defs"][name]["additionalProperties"] is False


def test_forward_request_requires_last_session(api_schema: dict[str, Any]) -> None:
    required = set(api_schema["$defs"]["ForwardRunRequest"]["required"])
    assert "last_session" in required
    # backtest's last_session is optional (not required)
    assert "last_session" not in set(api_schema["$defs"]["BacktestRunRequest"]["required"])


# --- the generated TypeScript preserves the key shapes ----------------------------------------


def test_ts_exports_core_interfaces(api_ts: str) -> None:
    for interface in ("ApiError", "MetaResponse", "ValidateResponse", "RunRecordResponse"):
        assert f"export interface {interface}" in api_ts


def test_ts_loc_is_mixed_array(api_ts: str) -> None:
    assert "loc: (string | number)[]" in api_ts


# --- this packet must NOT change the committed IR artifacts ------------------------------------


def test_ir_bundle_unchanged_by_api_packet() -> None:
    """The committed IR schema still equals a fresh IR build (the API packet is additive-only)."""
    expected = canonical_json(build_bundle())
    actual = SCHEMA_PATH.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert actual == expected
    # and the IR ts input still carries prefixItems tuples (untouched by the API bundle work)
    assert "prefixItems" not in json.dumps(build_ts_input(build_bundle()))
