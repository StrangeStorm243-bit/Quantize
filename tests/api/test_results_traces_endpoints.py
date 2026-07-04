"""M9.7: fetch-results (verbatim + replay_verifiable), fetch-traces, list-runs."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from quantize.api.settings import ApiSettings
from quantize.persistence.database import Database
from quantize.persistence.runs import RunRepository
from quantize.schema.serialization import to_ir_json

_JSON = {"content-type": "application/json"}
_FIRST = "2025-07-31"
_LAST = "2025-08-29"


def _backtest_body(seeded: SimpleNamespace, **overrides: Any) -> dict[str, Any]:
    body = {
        "strategy_id": seeded.strategy_id,
        "strategy_version": seeded.version,
        "dataset_id": seeded.dataset_id,
        "initial_cash": 1_000_000.0,
        "first_session": _FIRST,
        "last_session": _LAST,
    }
    body.update(overrides)
    return body


def _submit(client: TestClient, path: str, body: Any) -> str:
    response = client.post(path, content=json.dumps(body), headers=_JSON)
    assert response.status_code == 201, response.text
    run_id: str = response.json()["run_id"]
    return run_id


def test_fetch_results_is_verbatim_load_run_plus_replay_verifiable(
    client: TestClient, seeded: SimpleNamespace, db: ApiSettings
) -> None:
    run_id = _submit(client, "/v1/runs/backtest", _backtest_body(seeded))
    response = client.get(f"/v1/runs/{run_id}")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"record", "replay_verifiable"}
    assert body["replay_verifiable"] is True  # recorded provenance
    # The record equals load_run's canonical serialization (embedded verbatim, beside the flag).
    with Database(db.db_path) as database:
        record = RunRepository(database).load_run(run_id)
    assert body["record"] == json.loads(to_ir_json(record))
    assert body["record"]["ok"] is True


def test_fetch_unknown_run_is_404(client: TestClient, db: ApiSettings) -> None:
    response = client.get(f"/v1/runs/{'0' * 36}")
    assert response.status_code == 404


def test_forward_record_identical_to_backtest_modulo_run_id_and_mode(
    client: TestClient, seeded: SimpleNamespace, db: ApiSettings
) -> None:
    """Same engine core: a forward record equals the backtest record once run_id and mode are
    normalized (mirrors the M8 backtest↔forward consistency test)."""
    backtest_id = _submit(client, "/v1/runs/backtest", _backtest_body(seeded))
    forward_id = _submit(client, "/v1/runs/forward", _backtest_body(seeded))
    backtest = client.get(f"/v1/runs/{backtest_id}").json()["record"]
    forward = client.get(f"/v1/runs/{forward_id}").json()["record"]
    normalized_forward = {**forward, "mode": "backtest", "run_id": backtest["run_id"]}
    assert normalized_forward == backtest


def test_fetch_traces_seq_order_and_session_filter(
    client: TestClient, seeded: SimpleNamespace
) -> None:
    run_id = _submit(client, "/v1/runs/backtest", _backtest_body(seeded))
    events = client.get(f"/v1/runs/{run_id}/trace").json()["events"]
    assert events, "the windowed run evaluates twice, so it emits trace events"
    timestamps = [e["timestamp"] for e in events]
    assert timestamps == sorted(timestamps)  # stored sequence order is non-decreasing in time

    # session_date filter narrows to one session's instants (each instant's ISO date is its session)
    one_day = client.get(f"/v1/runs/{run_id}/trace", params={"session_date": _FIRST}).json()[
        "events"
    ]
    assert one_day
    assert all(e["timestamp"].startswith(_FIRST) for e in one_day)
    assert len(one_day) < len(events)


def test_fetch_traces_unknown_run_is_404(client: TestClient, db: ApiSettings) -> None:
    assert client.get(f"/v1/runs/{'0' * 36}/trace").status_code == 404


def test_list_runs_filters_by_strategy_id(client: TestClient, seeded: SimpleNamespace) -> None:
    run_id = _submit(client, "/v1/runs/backtest", _backtest_body(seeded))
    listing = client.get("/v1/runs", params={"strategy_id": seeded.strategy_id})
    assert listing.status_code == 200
    rows = listing.json()["runs"]
    assert any(r["run_id"] == run_id for r in rows)
    assert all(r["strategy_id"] == seeded.strategy_id for r in rows)

    # a different strategy_id yields no rows
    other = client.get("/v1/runs", params={"strategy_id": "does-not-exist"})
    assert other.json()["runs"] == []
