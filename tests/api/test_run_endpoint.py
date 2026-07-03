"""M9.7: run submission (backtest + forward) and its error taxonomy.

The window 2025-07-31..2025-08-29 spans exactly Strategy A's two monthly evaluations, so the run
is small and its facts are hand-checkable against the reference-strategy tests.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from tests.helpers import load_fixture

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


def _post(client: TestClient, path: str, body: Any) -> Any:
    return client.post(path, content=json.dumps(body), headers=_JSON)


def test_backtest_run_returns_201_with_run_id(client: TestClient, seeded: SimpleNamespace) -> None:
    response = _post(client, "/v1/runs/backtest", _backtest_body(seeded))
    assert response.status_code == 201
    run_id = response.json()["run_id"]
    assert len(run_id) == 36  # uuid4 string


def test_forward_run_returns_201(client: TestClient, seeded: SimpleNamespace) -> None:
    response = _post(client, "/v1/runs/forward", _backtest_body(seeded))
    assert response.status_code == 201


def test_initial_positions_accepted(client: TestClient, seeded: SimpleNamespace) -> None:
    body = _backtest_body(seeded, initial_positions={"SPY": 10.0})
    assert _post(client, "/v1/runs/backtest", body).status_code == 201


def test_missing_last_session_on_forward_is_422(
    client: TestClient, seeded: SimpleNamespace
) -> None:
    body = _backtest_body(seeded)
    del body["last_session"]
    response = _post(client, "/v1/runs/forward", body)
    assert response.status_code == 422


def test_unknown_strategy_is_404(client: TestClient, seeded: SimpleNamespace) -> None:
    body = _backtest_body(seeded, strategy_id="nope", strategy_version=1)
    response = _post(client, "/v1/runs/backtest", body)
    assert response.status_code == 404


def test_unknown_dataset_is_404(client: TestClient, seeded: SimpleNamespace) -> None:
    body = _backtest_body(seeded, dataset_id="0" * 64)
    response = _post(client, "/v1/runs/backtest", body)
    assert response.status_code == 404


def test_client_supplied_run_id_is_rejected_422(
    client: TestClient, seeded: SimpleNamespace
) -> None:
    """extra=forbid: a client cannot pin the run_id (the server mints it)."""
    body = _backtest_body(seeded, run_id="deadbeef")
    response = _post(client, "/v1/runs/backtest", body)
    assert response.status_code == 422


def test_negative_initial_cash_is_422(client: TestClient, seeded: SimpleNamespace) -> None:
    body = _backtest_body(seeded, initial_cash=-1.0)
    response = _post(client, "/v1/runs/backtest", body)
    assert response.status_code == 422


def test_initial_cash_as_string_is_422(client: TestClient, seeded: SimpleNamespace) -> None:
    """Strict DTO: a numeric string is off-contract (schema: type number) → 422, not coerced."""
    body = _backtest_body(seeded, initial_cash="1000.0")
    assert _post(client, "/v1/runs/backtest", body).status_code == 422


def test_initial_position_boolean_is_422(client: TestClient, seeded: SimpleNamespace) -> None:
    body = _backtest_body(seeded, initial_positions={"SPY": True})
    assert _post(client, "/v1/runs/backtest", body).status_code == 422


def test_ok_false_run_still_persists_201(client: TestClient, seeded: SimpleNamespace) -> None:
    """A strategy that saves (structurally valid, unknown future type_id — the extensible seam)
    but fails run-time preflight produces ok:false. That is a run FACT, not an HTTP error: it
    persists and returns 201; the client reads ok from fetch-results."""
    broken = load_fixture("strategy_a")
    broken["strategy"] = {**broken["strategy"], "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}
    broken["nodes"][0]["type_id"] = "future.unknown_block"  # valid to store, unresolved at run
    saved = _post(client, "/v1/strategies", broken)
    assert saved.status_code == 201

    body = _backtest_body(seeded, strategy_id=broken["strategy"]["id"], strategy_version=1)
    submitted = _post(client, "/v1/runs/backtest", body)
    assert submitted.status_code == 201  # honest partial persists
    run_id = submitted.json()["run_id"]

    fetched = client.get(f"/v1/runs/{run_id}")
    assert fetched.status_code == 200
    assert fetched.json()["record"]["ok"] is False
