"""Tests for semantic_projection / documents_semantically_equal (M1.1b)."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any

import pytest
from pydantic import ValidationError

from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument
from quantize.schema.semantics import components_semantically_equal, documents_semantically_equal
from tests.helpers import load_fixture

_OWNER = "22222222-2222-2222-2222-222222222222"


def _doc(data: dict[str, Any]) -> StrategyDocument:
    return StrategyDocument.model_validate(data)


def test_ui_change_does_not_affect_semantic_equality() -> None:
    base = load_fixture("strategy_a")
    moved = copy.deepcopy(base)
    moved["nodes"][0]["ui"] = {"x": 999, "y": 999}  # presentation-only
    assert documents_semantically_equal(_doc(base), _doc(moved))


def test_node_and_edge_reordering_does_not_affect_equality() -> None:
    base = load_fixture("strategy_a")
    shuffled = copy.deepcopy(base)
    shuffled["nodes"] = list(reversed(shuffled["nodes"]))
    shuffled["edges"] = list(reversed(shuffled["edges"]))
    assert documents_semantically_equal(_doc(base), _doc(shuffled))


# --- Each semantic change must break equality ------------------------------------------------


def _change_param(d: dict[str, Any]) -> None:
    d["nodes"][2]["params"]["lookback_sessions"] = 60


def _change_type_id(d: dict[str, Any]) -> None:
    d["nodes"][3]["type_id"] = "transform.moving_average"


def _change_type_version(d: dict[str, Any]) -> None:
    d["nodes"][3]["type_version"] = "2.0.0"


def _change_edge(d: dict[str, Any]) -> None:
    d["edges"].pop()


def _change_schedule(d: dict[str, Any]) -> None:
    d["schedule"] = {"kind": "weekly"}


def _change_component_ref(d: dict[str, Any]) -> None:
    d["component_refs"].append(
        {"id": "c1", "component_id": "44444444-4444-4444-4444-444444444444", "version": "1.0.0"}
    )


def _change_extensions(d: dict[str, Any]) -> None:
    d["extensions"] = {"vendor.flag": True}


@pytest.mark.parametrize(
    "mutate",
    [
        _change_param,
        _change_type_id,
        _change_type_version,
        _change_edge,
        _change_schedule,
        _change_component_ref,
        _change_extensions,
    ],
)
def test_semantic_changes_break_equality(mutate: Callable[[dict[str, Any]], None]) -> None:
    base = load_fixture("strategy_a")
    changed = copy.deepcopy(base)
    mutate(changed)
    assert not documents_semantically_equal(_doc(base), _doc(changed))


def test_projection_rejects_structurally_invalid_document() -> None:
    # An unparseable document is rejected at the StrategyDocument boundary, before projection.
    bad = load_fixture("strategy_a")
    del bad["schedule"]
    with pytest.raises(ValidationError):
        _doc(bad)


# --- Component projection (LOW-9) ------------------------------------------------------------


def _component(node_ui: dict[str, Any] | None) -> ComponentDefinition:
    node: dict[str, Any] = {
        "id": "inner",
        "type_id": "transform.rank",
        "type_version": "1.0.0",
        "params": {},
    }
    if node_ui is not None:
        node["ui"] = node_ui
    return ComponentDefinition.model_validate(
        {
            "component_id": "44444444-4444-4444-4444-444444444444",
            "version": "1.0.0",
            "schema_version": "0.1.0",
            "name": "C",
            "component_refs": [],
            "implementation": {"kind": "graph", "graph": {"nodes": [node], "edges": []}},
            "exposed_inputs": [],
            "exposed_outputs": [],
            "exposed_params": [],
            "provenance": {
                "owner": _OWNER,
                "creator": _OWNER,
                "contributors": [],
                "visibility": "private",
                "duplicable": False,
                "created_at": "2026-06-23T00:00:00Z",
            },
        }
    )


def test_component_projection_ignores_internal_node_ui() -> None:
    assert components_semantically_equal(_component(None), _component({"x": 5, "y": 9}))
