"""Shared builders for the value-tap test suites (service, cross-check, endpoint).

The drift TAMPER shape and the dual-output component are contracts all three suites must
exercise IDENTICALLY — defined once here so they cannot drift apart (a stale copy would let one
suite keep passing against a shape the others no longer test).
"""

from __future__ import annotations

import copy
from datetime import date
from typing import Any

from quantize.components.resolve import ComponentCatalog
from quantize.engine.backtest import run_backtest
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository
from quantize.persistence.provenance import recorded_input_provenance
from quantize.persistence.records import PersistedRunRecord
from quantize.persistence.runs import RunRepository
from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument
from tests.helpers import load_fixture

PINNED_CASH = 1_000_000.0


def run_pinned_backtest(
    document: StrategyDocument,
    market: MarketDataSet,
    *,
    run_id: str,
    components: ComponentCatalog | None = None,
) -> BacktestResult:
    """The ONE backtest invocation shape all value-tap suites seed with: the core catalog, the
    pinned ``PINNED_CASH`` initial state, and an explicit ``run_id`` — so the goldens, service,
    and endpoint suites can never drift onto different run shapes."""
    return run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=run_id,
        initial_state=PortfolioState.of(cash=PINNED_CASH),
        components=components,
    )


def persist_backtest_run(
    db: Database,
    document: StrategyDocument,
    result: BacktestResult,
    market: MarketDataSet,
    *,
    save_dataset: bool = True,
) -> PersistedRunRecord:
    """Persist a precomputed backtest (and, by default, its dataset) with RECORDED provenance —
    the persistence shape the tap resolves against in production. Returns the loaded record."""
    if save_dataset:
        DatasetRepository(db).save(market)
    runs = RunRepository(db)
    runs.save_run(document, result, input_provenance=recorded_input_provenance(market))
    return runs.load_run(result.run_id)


DUAL_COMPONENT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
OUTER_MOMENTUM_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd"
MOMENTUM_COMPONENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"  # component_momentum fixture


def momentum_component() -> ComponentDefinition:
    """The committed Momentum Selector fixture as a ``ComponentDefinition`` (inner of the depth-2
    shape). Its innermost graph nodes — ``ret``/``rk``/``sel`` — are all CORE node types, so the
    value-tap recompute (which pins ``build_core_catalog()``) can evaluate them."""
    return ComponentDefinition.model_validate(load_fixture("component_momentum"))


def outer_momentum_component() -> ComponentDefinition:
    """An outer component whose whole graph is a single ``ComponentRef`` to the Momentum Selector —
    the depth-2 shape built from registered CORE node types only (the tracer fixtures use the
    test-only ``test.trace`` type the recompute cannot evaluate). The outer instance re-exposes the
    inner ref's ``series``/``universe`` inputs and ``assets`` output through ``("inner", …)``,
    copying the two-level wiring of ``test_nested_components_evaluate_compositionally``."""
    provenance: dict[str, Any] = copy.deepcopy(load_fixture("component_momentum")["provenance"])
    data: dict[str, Any] = {
        "component_id": OUTER_MOMENTUM_ID,
        "version": "1.0.0",
        "schema_version": "0.1.0",
        "name": "Outer Momentum",
        "description": "Wraps the Momentum Selector one level deeper for depth-2 addressing.",
        "component_refs": [
            {"id": "inner_ref", "component_id": MOMENTUM_COMPONENT_ID, "version": "1.0.0"}
        ],
        "implementation": {
            "kind": "graph",
            "graph": {
                "nodes": [
                    {"id": "inner", "type_id": "component", "ref": "inner_ref", "params": {}}
                ],
                "edges": [],
            },
        },
        "exposed_inputs": [
            {
                "name": "series",
                "type": {"kind": "TimeSeries", "dtype": "Number"},
                "maps_to": ["inner", "series"],
            },
            {"name": "universe", "type": {"kind": "AssetSet"}, "maps_to": ["inner", "universe"]},
        ],
        "exposed_outputs": [
            {"name": "assets", "type": {"kind": "AssetSet"}, "maps_to": ["inner", "assets"]}
        ],
        "exposed_params": [],
        "provenance": provenance,
    }
    return ComponentDefinition.model_validate(data)


def outer_momentum_strategy() -> StrategyDocument:
    """``strategy_a_component`` re-pinned so its ``mom`` instance references the OUTER component
    (same top-level wiring). The outer exposes no params, so ``mom`` passes none and the inner
    Momentum's authored default ``n=3`` applies — the top-level ``mom.assets`` output is identical
    to the depth-1 case, but ``ret`` now lives two instance levels deep at ``("mom", "inner")``."""
    data: dict[str, Any] = copy.deepcopy(load_fixture("strategy_a_component"))
    data["component_refs"][0]["component_id"] = OUTER_MOMENTUM_ID
    for node in data["nodes"]:
        if node["id"] == "mom":
            node["params"] = {}
    return StrategyDocument.model_validate(data)


def dual_component() -> ComponentDefinition:
    """component_momentum plus a SECOND exposed output (so an instance exposes two ports)."""
    data: dict[str, Any] = copy.deepcopy(load_fixture("component_momentum"))
    data["component_id"] = DUAL_COMPONENT_ID
    data["exposed_outputs"].append(
        {
            "name": "returns",
            "type": {"kind": "CrossSection", "dtype": "Number"},
            "maps_to": ["ret", "values"],
        }
    )
    return ComponentDefinition.model_validate(data)


def dual_strategy() -> StrategyDocument:
    """strategy_a_component re-pinned to the dual component (same instance id ``mom``)."""
    data: dict[str, Any] = copy.deepcopy(load_fixture("strategy_a_component"))
    data["component_refs"][0]["component_id"] = DUAL_COMPONENT_ID
    return StrategyDocument.model_validate(data)


def tamper_trace(result: BacktestResult, node_id: str, when: date) -> None:
    """Corrupt ``node_id``'s recorded top-level trace at session ``when``, in place, to a value no
    faithful recompute can produce: append a sentinel to the first list-valued field of the node's
    first event's payload (for ``ret`` this is exactly its ``computed`` asset list). Envelope-level
    drift is detected regardless of which field or event type carries it. Asserts a target was
    found — a silent no-op tamper would fail the calling test loudly, not pass it."""
    for event in result.trace:
        if (
            event.node_id == node_id
            and tuple(event.component_path) == ()
            and event.timestamp.date() == when
        ):
            for key, current in event.payload.items():
                if isinstance(current, list):
                    event.payload[key] = [*current, "__DRIFTED__"]  # frozen model, mutable dict
                    return
            raise AssertionError(f"{node_id}'s event at {when} has no list payload field to tamper")
    raise AssertionError(f"no trace event for {node_id} at {when} to tamper")
