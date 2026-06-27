"""Contract tests for the document & component models."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import ComponentRefNode, RegisteredNode
from tests.helpers import load_fixture

_OWNER = "22222222-2222-2222-2222-222222222222"


def _loc_mentions(exc: pytest.ExceptionInfo[ValidationError], field: str) -> bool:
    return any(field in str(err["loc"]) for err in exc.value.errors())


# --- Reference strategies validate -----------------------------------------------------------


@pytest.mark.parametrize("name", ["strategy_a", "strategy_b"])
def test_reference_strategy_validates(name: str) -> None:
    doc = StrategyDocument.model_validate(load_fixture(name))
    for node in doc.nodes:
        assert isinstance(node, RegisteredNode)
        assert node.type_version is not None
        assert "." in node.type_id, node.type_id


def test_strategy_document_accepts_unknown_future_type_id() -> None:
    data = load_fixture("strategy_a")
    data["nodes"].append(
        {"id": "future", "type_id": "ai.generated.block", "type_version": "9.9.9", "params": {}}
    )
    doc = StrategyDocument.model_validate(data)
    assert any(n.type_id == "ai.generated.block" for n in doc.nodes)


# --- Required persisted fields (BLOCKER-1) ---------------------------------------------------


@pytest.mark.parametrize("field", ["nodes", "edges", "component_refs"])
def test_omitting_a_required_collection_is_rejected(field: str) -> None:
    data = load_fixture("strategy_a")
    del data[field]
    with pytest.raises(ValidationError) as exc:
        StrategyDocument.model_validate(data)
    assert _loc_mentions(exc, field)


def test_omitting_contributors_is_rejected() -> None:
    data = load_fixture("strategy_a")
    del data["strategy"]["provenance"]["contributors"]
    with pytest.raises(ValidationError) as exc:
        StrategyDocument.model_validate(data)
    assert _loc_mentions(exc, "contributors")


def test_explicit_empty_collections_are_accepted() -> None:
    data = load_fixture("strategy_a")
    data["nodes"] = []
    data["edges"] = []
    data["component_refs"] = []
    doc = StrategyDocument.model_validate(data)
    assert doc.nodes == []


# --- Strict numeric governed fields (BLOCKER-3) ----------------------------------------------


def test_boolean_strategy_version_is_rejected_but_int_accepted() -> None:
    data = load_fixture("strategy_a")
    data["strategy"]["version"] = True
    with pytest.raises(ValidationError) as exc:
        StrategyDocument.model_validate(data)
    assert _loc_mentions(exc, "version")

    data["strategy"]["version"] = 3
    assert StrategyDocument.model_validate(data).strategy.version == 3


def test_boolean_bps_is_rejected_but_int_and_float_accepted() -> None:
    data = load_fixture("strategy_a")
    costs = data["execution_policy"]["transaction_costs"]
    costs["bps"] = True
    with pytest.raises(ValidationError):
        StrategyDocument.model_validate(data)

    costs["bps"] = 5  # integer JSON number is a valid bps
    assert StrategyDocument.model_validate(data).execution_policy.transaction_costs.bps == 5.0
    costs["bps"] = 2.5
    assert StrategyDocument.model_validate(data).execution_policy.transaction_costs.bps == 2.5


# --- Components ------------------------------------------------------------------------------


def _component(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "component_id": "44444444-4444-4444-4444-444444444444",
        "version": "1.0.0",
        "schema_version": "0.1.0",
        "name": "Momentum Selector",
        "component_refs": [],
        "implementation": {"kind": "graph", "graph": {"nodes": [], "edges": []}},
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
    base.update(overrides)
    return base


def test_component_definition_validates_with_graph_implementation() -> None:
    comp = ComponentDefinition.model_validate(_component())
    assert comp.implementation.kind == "graph"


def test_component_cannot_expose_orderlist_port() -> None:
    bad = _component(
        exposed_outputs=[{"name": "orders", "type": {"kind": "OrderList"}, "maps_to": ["n", "out"]}]
    )
    with pytest.raises(ValidationError) as exc:
        ComponentDefinition.model_validate(bad)
    err = exc.value.errors()[0]
    assert err["type"] == "union_tag_invalid"
    assert "exposed_outputs" in str(err["loc"])


def test_component_rejects_non_graph_implementation_kind() -> None:
    bad = _component(implementation={"kind": "python", "graph": {"nodes": [], "edges": []}})
    with pytest.raises(ValidationError) as exc:
        ComponentDefinition.model_validate(bad)
    err = exc.value.errors()[0]
    assert err["type"] == "union_tag_invalid"
    assert "implementation" in str(err["loc"])


def test_component_with_pinned_dependency_and_internal_component_node() -> None:
    # MEDIUM-8: a nested-dependency shape — pinned ref + internal `component` node pointing at it.
    comp = ComponentDefinition.model_validate(
        _component(
            component_refs=[
                {
                    "id": "d1",
                    "component_id": "55555555-5555-5555-5555-555555555555",
                    "version": "2.1.0",
                }
            ],
            implementation={
                "kind": "graph",
                "graph": {
                    "nodes": [{"id": "inner", "type_id": "component", "ref": "d1", "params": {}}],
                    "edges": [],
                },
            },
        )
    )
    assert comp.component_refs[0].id == "d1"
    inner = comp.implementation.graph.nodes[0]
    assert isinstance(inner, ComponentRefNode)
    assert inner.ref == "d1"


def test_component_fork_ref_uses_semver_not_int() -> None:
    # HIGH-5: a component fork reference records a component SemVer, not a strategy integer.
    comp = ComponentDefinition.model_validate(
        _component(
            provenance={
                "owner": _OWNER,
                "creator": _OWNER,
                "contributors": [],
                "forked_from": {"id": "44444444-4444-4444-4444-444444444444", "version": "0.9.0"},
                "visibility": "private",
                "duplicable": False,
                "created_at": "2026-06-23T00:00:00Z",
            }
        )
    )
    assert comp.provenance.forked_from is not None
    assert comp.provenance.forked_from.version == "0.9.0"

    bad = _component(
        provenance={
            "owner": _OWNER,
            "creator": _OWNER,
            "contributors": [],
            "forked_from": {"id": "44444444-4444-4444-4444-444444444444", "version": 1},
            "visibility": "private",
            "duplicable": False,
            "created_at": "2026-06-23T00:00:00Z",
        }
    )
    with pytest.raises(ValidationError):
        ComponentDefinition.model_validate(bad)
