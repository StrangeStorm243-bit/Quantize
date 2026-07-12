"""Shared builders for the value-tap test suites (service, cross-check, endpoint).

The drift TAMPER shape and the dual-output component are contracts all three suites must
exercise IDENTICALLY — defined once here so they cannot drift apart (a stale copy would let one
suite keep passing against a shape the others no longer test).
"""

from __future__ import annotations

import copy
from datetime import date
from typing import Any

from quantize.engine.records import BacktestResult
from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument
from tests.helpers import load_fixture

DUAL_COMPONENT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"


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
