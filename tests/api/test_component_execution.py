"""M12.1: the HTTP layer wires a DB-backed ``ComponentCatalog`` into validate + run.

Before this slice the API passed NO catalog, so any strategy with a ``ComponentRef`` was
un-runnable and only ever produced ``component_definition_unavailable`` on validate. These tests
prove the catalog is now fetched from the store (BFS over the pinned closure) and threaded into the
SAME preflight/engine the library uses — a componentized strategy validates ``ok:true``, runs
byte-for-byte like its flat twin, and its trace carries the component path.
"""

from __future__ import annotations

import json
import os
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from quantize.api.settings import ApiSettings
from tests.helpers import load_fixture

_JSON = {"content-type": "application/json"}
_FIRST = "2025-07-31"
_LAST = "2025-08-29"
_SELF_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
_RECURSIVE_STRATEGY_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd"

# The record fields compared for composed-vs-flat equality (run_id/timestamps excluded).
_COMPARED = ("ok", "total_return", "valuations", "fills", "final_cash")


def _post(client: TestClient, path: str, body: Any) -> Any:
    return client.post(path, content=json.dumps(body), headers=_JSON)


def _validate(client: TestClient, body: Any) -> Any:
    return _post(client, "/v1/strategies/validate", body)


def _seed_component_and_strategy(client: TestClient) -> str:
    """Save the momentum component + the componentized Strategy A; return the strategy id."""
    assert _post(client, "/v1/components", load_fixture("component_momentum")).status_code == 201
    strategy = load_fixture("strategy_a_component")
    assert _post(client, "/v1/strategies", strategy).status_code == 201
    return str(strategy["strategy"]["id"])


def _self_recursive_component() -> dict[str, Any]:
    """A ComponentDefinition whose own ``component_refs`` pins itself — a direct cycle. The
    repository saves it (no structural validation on save); resolution rejects it at run time."""
    provenance = load_fixture("component_momentum")["provenance"]
    return {
        "component_id": _SELF_ID,
        "version": "1.0.0",
        "schema_version": "0.1.0",
        "name": "Self Recursive",
        "component_refs": [{"id": "self", "component_id": _SELF_ID, "version": "1.0.0"}],
        "implementation": {
            "kind": "graph",
            "graph": {
                "nodes": [{"id": "me", "type_id": "component", "ref": "self", "params": {}}],
                "edges": [],
            },
        },
        "exposed_inputs": [],
        "exposed_outputs": [],
        "exposed_params": [],
        "provenance": provenance,
    }


def _strategy_referencing(component_id: str, strategy_id: str) -> dict[str, Any]:
    """A minimal, structurally valid strategy: one component node pinned to *component_id*."""
    base = load_fixture("strategy_a")
    return {
        "schema_version": "0.1.0",
        "strategy": {**base["strategy"], "id": strategy_id, "version": 1},
        "execution_policy": base["execution_policy"],
        "schedule": base["schedule"],
        "nodes": [{"id": "c", "type_id": "component", "ref": "r", "params": {}}],
        "edges": [],
        "component_refs": [{"id": "r", "component_id": component_id, "version": "1.0.0"}],
    }


def _runtime_codes(body: dict[str, Any]) -> set[str]:
    return {d["code"] for d in body["runtime"]}


# --- (a) the catalog is fetched: a componentized strategy validates ok:true -------------------


def test_componentized_strategy_validates_ok_when_component_saved(
    client: TestClient, db: ApiSettings
) -> None:
    _seed_component_and_strategy(client)
    response = _validate(client, load_fixture("strategy_a_component"))
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True, body
    assert body["runtime"] == []
    assert body["warmup_sessions"] is not None


# --- (b) missing definition surfaces as a runtime component_definition_unavailable ------------


def test_componentized_strategy_missing_component_is_unavailable(
    client: TestClient, db: ApiSettings
) -> None:
    # The component is NOT saved; the DB branch runs but the closure comes back empty.
    body = _validate(client, load_fixture("strategy_a_component")).json()
    assert body["ok"] is False
    assert "component_definition_unavailable" in _runtime_codes(body)


# --- (c) a stored self-recursive definition is rejected at resolution -------------------------


def test_self_recursive_component_surfaces_direct_recursion(
    client: TestClient, db: ApiSettings
) -> None:
    saved = _post(client, "/v1/components", _self_recursive_component())
    assert saved.status_code == 201  # repository saves without structural validation
    strategy = _strategy_referencing(_SELF_ID, _RECURSIVE_STRATEGY_ID)
    body = _validate(client, strategy).json()
    assert body["ok"] is False
    # resolve down-converts set-level structural errors to runtime diagnostics; assert MEMBERSHIP
    # (a wrapping component_definition_invalid may accompany it).
    assert "component_direct_recursion" in _runtime_codes(body)


# --- (d) a componentized run equals its flat twin, byte-for-byte on the compared facts --------


def _fetch_record(client: TestClient, run_id: str) -> dict[str, Any]:
    fetched = client.get(f"/v1/runs/{run_id}")
    assert fetched.status_code == 200
    record: dict[str, Any] = fetched.json()["record"]
    return record


def _run(client: TestClient, mode: str, seeded: SimpleNamespace, strategy_id: str) -> str:
    body = {
        "strategy_id": strategy_id,
        "strategy_version": 1,
        "dataset_id": seeded.dataset_id,
        "initial_cash": 1_000_000.0,
        "first_session": _FIRST,
        "last_session": _LAST,
    }
    response = _post(client, f"/v1/runs/{mode}", body)
    assert response.status_code == 201, response.text
    return str(response.json()["run_id"])


def test_componentized_backtest_matches_flat_strategy(
    client: TestClient, seeded: SimpleNamespace
) -> None:
    composed_id = _seed_component_and_strategy(client)  # bbbb… (componentized Strategy A)
    composed = _fetch_record(client, _run(client, "backtest", seeded, composed_id))
    flat = _fetch_record(client, _run(client, "backtest", seeded, seeded.strategy_id))
    assert composed["ok"] is True and flat["ok"] is True
    for field in _COMPARED:
        assert composed[field] == flat[field], field


def test_componentized_forward_matches_flat_strategy(
    client: TestClient, seeded: SimpleNamespace
) -> None:
    composed_id = _seed_component_and_strategy(client)
    composed = _fetch_record(client, _run(client, "forward", seeded, composed_id))
    flat = _fetch_record(client, _run(client, "forward", seeded, seeded.strategy_id))
    assert composed["ok"] is True and flat["ok"] is True
    for field in _COMPARED:
        assert composed[field] == flat[field], field


# --- (e) the persisted trace carries the component path ---------------------------------------


def test_componentized_run_trace_carries_component_path(
    client: TestClient, seeded: SimpleNamespace
) -> None:
    composed_id = _seed_component_and_strategy(client)
    run_id = _run(client, "backtest", seeded, composed_id)
    trace = client.get(f"/v1/runs/{run_id}/trace")
    assert trace.status_code == 200
    events = trace.json()["events"]
    assert any(event["component_path"] == ["mom"] for event in events), (
        "expected trace events under the 'mom' component instance"
    )


# --- (f) the no-refs fast path never opens a DB -----------------------------------------------


def test_no_refs_strategy_uses_fast_path_without_touching_db(
    client: TestClient, db: ApiSettings
) -> None:
    assert not os.path.exists(db.db_path)  # fresh per-test path, nothing has opened it yet
    body = _validate(client, load_fixture("strategy_a")).json()
    assert body["ok"] is True
    assert body["warmup_sessions"] == 126  # identical to the pre-M12.1 result
    # Database(path) auto-creates the file on open, so absence PROVES the DB was never opened.
    assert not os.path.exists(db.db_path)
