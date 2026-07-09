"""M13.6: GET /v1/runs/{run_id}/trace-tree — a pure projection of the stored flat trace
through ``build_trace_trees``. Structural equality vs the library on a real run, session
filtering identical to the flat endpoint, 404 on unknown runs, deterministic repeated calls,
and component nesting preserved over the wire."""

from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from quantize.api.dto.trace_tree import TraceTreeResponse, trace_tree_dto
from quantize.api.settings import ApiSettings
from quantize.persistence.database import Database
from quantize.persistence.runs import RunRepository
from quantize.tracing.tree import build_trace_trees
from tests.helpers import load_fixture

_JSON = {"content-type": "application/json"}
_FIRST = "2025-07-31"
_LAST = "2025-08-29"


def _submit_backtest(client: TestClient, seeded: SimpleNamespace, **overrides: Any) -> str:
    body = {
        "strategy_id": seeded.strategy_id,
        "strategy_version": seeded.version,
        "dataset_id": seeded.dataset_id,
        "initial_cash": 1_000_000.0,
        "first_session": _FIRST,
        "last_session": _LAST,
    }
    body.update(overrides)
    response = client.post("/v1/runs/backtest", content=json.dumps(body), headers=_JSON)
    assert response.status_code == 201, response.text
    run_id: str = response.json()["run_id"]
    return run_id


def _expected_payload(db_path: str, run_id: str, session_date: date | None = None) -> Any:
    """The endpoint's contractual payload, built INDEPENDENTLY: stored flat events →
    build_trace_trees → DTO serialization."""
    with Database(db_path) as database:
        events = RunRepository(database).load_trace(run_id, session_date)
    trees = tuple(trace_tree_dto(tree) for tree in build_trace_trees(events))
    return TraceTreeResponse(trees=trees).model_dump(mode="json")


def test_tree_is_structurally_equal_to_build_trace_trees(
    client: TestClient, seeded: SimpleNamespace, db: ApiSettings
) -> None:
    run_id = _submit_backtest(client, seeded)
    response = client.get(f"/v1/runs/{run_id}/trace-tree")
    assert response.status_code == 200
    assert response.json() == _expected_payload(db.db_path, run_id)


def test_tree_shape_facts_not_derived_from_the_mapper(
    client: TestClient, seeded: SimpleNamespace
) -> None:
    """Spot-checks asserted by hand (independent of trace_tree_dto, so a mapper bug cannot
    self-certify): ascending instants; engine root LAST with only engine.* events; node
    roots hold no engine.* events."""
    run_id = _submit_backtest(client, seeded)
    trees = client.get(f"/v1/runs/{run_id}/trace-tree").json()["trees"]
    assert trees, "the windowed run evaluates, so trees exist"
    instants = [t["instant"] for t in trees]
    assert instants == sorted(instants)
    for tree in trees:
        engine_roots = [r for r in tree["roots"] if r["origin"] == "engine"]
        assert len(engine_roots) <= 1
        if engine_roots:
            assert tree["roots"][-1]["origin"] == "engine"  # engine sorts after node roots
            assert all(e["event_type"].startswith("engine.") for e in engine_roots[0]["events"])
        for root in tree["roots"]:
            if root["origin"] == "node":
                assert all(not e["event_type"].startswith("engine.") for e in root["events"])


def test_session_date_filter_matches_flat_endpoint_semantics(
    client: TestClient, seeded: SimpleNamespace, db: ApiSettings
) -> None:
    run_id = _submit_backtest(client, seeded)
    filtered = client.get(f"/v1/runs/{run_id}/trace-tree", params={"session_date": _FIRST}).json()
    assert filtered == _expected_payload(db.db_path, run_id, date.fromisoformat(_FIRST))
    assert filtered["trees"], "the first session evaluates"
    assert all(t["instant"].startswith(_FIRST) for t in filtered["trees"])
    unfiltered = client.get(f"/v1/runs/{run_id}/trace-tree").json()
    assert len(filtered["trees"]) < len(unfiltered["trees"])


def test_unknown_run_is_404(client: TestClient, db: ApiSettings) -> None:
    assert client.get(f"/v1/runs/{'0' * 36}/trace-tree").status_code == 404
    assert (
        client.get(f"/v1/runs/{'0' * 36}/trace-tree", params={"session_date": _FIRST}).status_code
        == 404
    )


def test_repeated_calls_are_byte_identical(client: TestClient, seeded: SimpleNamespace) -> None:
    run_id = _submit_backtest(client, seeded)
    first = client.get(f"/v1/runs/{run_id}/trace-tree")
    second = client.get(f"/v1/runs/{run_id}/trace-tree")
    assert first.content == second.content


def test_component_nesting_survives_the_wire(client: TestClient, seeded: SimpleNamespace) -> None:
    """A componentized run's tree nests the 'mom' instance root with its internal nodes as
    children (seeding pattern from tests/api/test_component_execution.py)."""
    assert (
        client.post(
            "/v1/components",
            content=json.dumps(load_fixture("component_momentum")),
            headers=_JSON,
        ).status_code
        == 201
    )
    strategy = load_fixture("strategy_a_component")
    assert (
        client.post("/v1/strategies", content=json.dumps(strategy), headers=_JSON).status_code
        == 201
    )
    run_id = _submit_backtest(
        client, seeded, strategy_id=strategy["strategy"]["id"], strategy_version=1
    )
    trees = client.get(f"/v1/runs/{run_id}/trace-tree").json()["trees"]
    mom_roots = [r for tree in trees for r in tree["roots"] if r["node_id"] == "mom"]
    assert mom_roots, "the component instance materializes as a root"
    mom = mom_roots[0]
    assert mom["events"] == []  # the instance itself emitted nothing
    child_ids = {child["node_id"] for child in mom["children"]}
    assert child_ids <= {"ret", "rk", "sel"} and child_ids
    for child in mom["children"]:
        assert child["component_path"] == ["mom"]
