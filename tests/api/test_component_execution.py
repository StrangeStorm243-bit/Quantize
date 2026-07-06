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
from quantize.persistence.database import Database
from quantize.persistence.documents import ComponentRepository
from quantize.schema.components import ComponentDefinition
from tests.helpers import load_fixture

_JSON = {"content-type": "application/json"}
_FIRST = "2025-07-31"
_LAST = "2025-08-29"
_SELF_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"

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
    """A ComponentDefinition whose own ``component_refs`` pins itself — a direct cycle. Save-time
    validation (M12.8) rejects it at the boundary, before the immutable store ever sees it."""
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


# --- (c) an invalid definition is rejected AT SAVE (M12.8) — never persisted -------------------


def _component_ids(client: TestClient) -> set[str]:
    """The component ids currently in the store (via the list endpoint)."""
    listing = client.get("/v1/components")
    assert listing.status_code == 200
    return {row["component_id"] for row in listing.json()["components"]}


def test_self_recursive_component_rejected_at_save(client: TestClient, db: ApiSettings) -> None:
    """A self-recursive definition is caught at the save boundary (strictly earlier than the old
    resolve-time surfacing): POST → 422 ``component_definition_invalid``, and NOT persisted."""
    saved = _post(client, "/v1/components", _self_recursive_component())
    assert saved.status_code == 422, saved.text
    assert saved.json()["code"] == "component_definition_invalid"
    assert _SELF_ID not in _component_ids(client)  # the immutable store never saw it


def test_run_layer_recursion_defense_over_http_store_bypass(
    client: TestClient, db: ApiSettings
) -> None:
    """Defense-in-depth over HTTP (M12.9): since M12.8 the save route 422s a recursive definition,
    so no API test can plant one via POST anymore — the run-layer ``validate_component_set``
    rejection is otherwise unreachable end-to-end. But ``ComponentRepository.save`` performs NO
    semantic validation, so a direct write / migration / import is a real bypass vector. Plant the
    self-recursive definition STRAIGHT THROUGH the repository (bypassing the save route), reference
    it from a saved strategy, and assert the run-layer recursion defense still fires at validate."""
    # Plant the recursive definition directly in the immutable store; the save ROUTE would 422 it.
    definition = ComponentDefinition.model_validate(_self_recursive_component())
    with Database(db.db_path) as database:
        ComponentRepository(database).save(definition)

    # A strategy pinning the planted (recursive) component. Strategy save does not check refs (201).
    strategy = load_fixture("strategy_a_component")
    strategy["strategy"]["id"] = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    strategy["component_refs"][0]["component_id"] = _SELF_ID
    assert _post(client, "/v1/strategies", strategy).status_code == 201

    body = _validate(client, strategy).json()
    assert body["ok"] is False, body
    # Membership, not exact set: a wrapping component_definition_invalid may accompany.
    assert "component_direct_recursion" in _runtime_codes(body)


def test_unknown_internal_node_type_rejected_at_save(client: TestClient, db: ApiSettings) -> None:
    """A structurally valid definition whose internal graph pins an unregistered node ``type_id``
    is rejected at save (M2's rule applied to the internal graph, at the save boundary)."""
    bad = load_fixture("component_momentum")
    bad["component_id"] = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
    bad["implementation"]["graph"]["nodes"][0]["type_id"] = "transform.does_not_exist"
    response = _post(client, "/v1/components", bad)
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "component_definition_invalid"
    assert bad["component_id"] not in _component_ids(client)


def test_dangling_nested_ref_rejected_at_save(client: TestClient, db: ApiSettings) -> None:
    """A definition that pins a nested component absent from the store is rejected at save
    (``component_definition_unavailable`` closure fault), and not persisted."""
    dangling = load_fixture("component_momentum")
    dangling["component_id"] = "ffffffff-ffff-ffff-ffff-ffffffffffff"
    dangling["component_refs"] = [{"id": "missing", "component_id": _SELF_ID, "version": "9.9.9"}]
    response = _post(client, "/v1/components", dangling)
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "component_definition_invalid"
    assert dangling["component_id"] not in _component_ids(client)


def test_valid_component_still_saves_and_is_idempotent(client: TestClient, db: ApiSettings) -> None:
    """Regression: a VALID definition still passes the new save-time validation → 201, and a
    byte-identical re-POST is idempotent → 200."""
    first = _post(client, "/v1/components", load_fixture("component_momentum"))
    assert first.status_code == 201, first.text
    again = _post(client, "/v1/components", load_fixture("component_momentum"))
    assert again.status_code == 200, again.text


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
