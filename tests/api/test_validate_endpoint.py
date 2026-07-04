"""M9.5: the run-faithful validate endpoint.

The centerpiece is the **3-way parity** proof: over the invalid-fixture corpus, the codes the
endpoint reports equal the codes ``run_document_preflight`` reports equal the codes a real
``evaluate_strategy`` run rejects with. One implementation, three call sites — the
no-second-implementation invariant, tested.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

from fastapi.testclient import TestClient

from quantize.evaluator.evaluate import evaluate_strategy
from quantize.evaluator.preflight import run_document_preflight
from quantize.nodes import build_core_catalog
from quantize.runtime.binding import ImplementationCatalog
from quantize.schema.document import StrategyDocument
from tests.helpers import load_fixture, load_invalid_fixture
from tests.market_fixture import build_market_fixture

_JSON = {"content-type": "application/json"}
_RUN_ID = "12121212-1212-1212-1212-121212121212"
_REF_MAIN_DATE = date(2026, 6, 1)

_INVALID_FIXTURES = (
    "cycle_disconnected",
    "cycle_multi_node",
    "cycle_simple",
    "dangling_edge_destination",
    "dangling_edge_source",
    "duplicate_node_id",
    "duplicate_ref_id",
    "self_edge",
    "unknown_component_ref",
)


def _validate(client: TestClient, payload: object) -> Any:
    return client.post("/v1/strategies/validate", content=json.dumps(payload), headers=_JSON)


def _endpoint_codes(body: dict[str, Any]) -> set[str]:
    codes: set[str] = set()
    for layer in ("structural", "semantic", "runtime"):
        codes.update(d["code"] for d in body[layer])
    return codes


# --- staged HTTP semantics --------------------------------------------------------------------


def test_valid_strategy_is_ok_with_warmup(client: TestClient) -> None:
    response = _validate(client, load_fixture("strategy_b"))
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["structural"] == [] and body["semantic"] == [] and body["runtime"] == []
    assert body["warmup_sessions"] == 199  # Strategy B's resolved warm-up


def test_strategy_a_warmup(client: TestClient) -> None:
    body = _validate(client, load_fixture("strategy_a")).json()
    assert body["ok"] is True
    assert body["warmup_sessions"] == 126


def test_semantically_invalid_is_200_ok_false(client: TestClient) -> None:
    """A structural fault is a 200 with ok:false — not an HTTP error (it is a run fact)."""
    response = _validate(client, load_invalid_fixture("self_edge"))
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["structural"]  # populated, loc-aware
    assert body["warmup_sessions"] is None


def test_unsupported_version_is_422(client: TestClient) -> None:
    doc = load_fixture("strategy_a")
    doc["schema_version"] = "0.2.0"
    response = _validate(client, doc)
    assert response.status_code == 422
    assert response.json()["code"] == "unsupported_schema_version"


def test_malformed_body_is_400(client: TestClient) -> None:
    response = client.post("/v1/strategies/validate", content="{not json", headers=_JSON)
    assert response.status_code == 400


def test_depth_bomb_is_clean_400_never_500(client: TestClient) -> None:
    """A deeply nested payload must surface as a clean 400/413 (Rust parse path), never a 500
    from a Python RecursionError."""
    depth = 2000
    bomb = "[" * depth + "]" * depth
    response = client.post("/v1/strategies/validate", content=bomb, headers=_JSON)
    assert response.status_code in (400, 413)


# --- dual-shape, loc-aware diagnostics --------------------------------------------------------


def test_structural_diagnostic_carries_loc_and_subject(client: TestClient) -> None:
    body = _validate(client, load_invalid_fixture("self_edge")).json()
    assert body["structural"]
    for diag in body["structural"]:
        assert set(diag) == {"code", "message", "loc", "subject"}
        assert isinstance(diag["loc"], list)


def test_runtime_diagnostic_carries_node_path(client: TestClient) -> None:
    """Missing-terminal is a runtime-layer fault located by node_path (not loc)."""
    doc = load_fixture("strategy_a")
    terminals = {n["id"] for n in doc["nodes"] if n["type_id"] == "output.target_portfolio"}
    doc["nodes"] = [n for n in doc["nodes"] if n["id"] not in terminals]
    # drop edges touching the removed terminal so the graph stays structurally valid (the fault
    # we want is the runtime missing-terminal rule, not a structural dangling edge)
    doc["edges"] = [
        e for e in doc["edges"] if e["from"][0] not in terminals and e["to"][0] not in terminals
    ]
    body = _validate(client, doc).json()
    assert any(d["code"] == "missing_terminal_node" for d in body["runtime"])
    for diag in body["runtime"]:
        assert set(diag) == {"code", "message", "node_path", "subject"}


# --- the 3-way parity proof -------------------------------------------------------------------


def _run_codes(catalog: ImplementationCatalog, document: StrategyDocument) -> set[str]:
    market = build_market_fixture()
    instant = market.calendar.session_on(_REF_MAIN_DATE).close_at  # type: ignore[union-attr]
    outcome = evaluate_strategy(
        document,
        catalog=catalog,
        market_data=market,
        run_id=_RUN_ID,
        evaluation_instant=instant,
    )
    # NO_VISIBLE_SESSION is data-dependent, not a document fault — exclude it (instant is visible).
    return {d.code for d in outcome.diagnostics if d.code != "no_visible_session"}


def _preflight_codes(catalog: ImplementationCatalog, document: StrategyDocument) -> set[str]:
    pf = run_document_preflight(document, registry=catalog.descriptor_registry)
    codes = {e.code for e in pf.structural}
    codes.update(f.code for f in pf.semantic)
    codes.update(d.code for d in pf.runtime)
    return codes


def test_three_way_parity_over_invalid_corpus(client: TestClient) -> None:
    catalog = build_core_catalog()
    for name in _INVALID_FIXTURES:
        raw = load_invalid_fixture(name)
        document = StrategyDocument.model_validate(raw)
        endpoint = _endpoint_codes(_validate(client, raw).json())
        preflight = _preflight_codes(catalog, document)
        run = _run_codes(catalog, document)
        assert endpoint == preflight == run, (
            f"{name}: endpoint={endpoint} preflight={preflight} run={run}"
        )
        assert endpoint  # non-empty: each fixture really is invalid
