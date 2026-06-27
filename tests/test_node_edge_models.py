"""Tests for the generic node union (RegisteredNode | ComponentRefNode) and Edge."""

from __future__ import annotations

from typing import cast

import pytest
from pydantic import ValidationError

from quantize.schema.nodes import ComponentRefNode, Edge, NodeAdapter, RegisteredNode


def _node(data: dict[str, object]) -> RegisteredNode | ComponentRefNode:
    return cast("RegisteredNode | ComponentRefNode", NodeAdapter.validate_python(data))


def _loc_mentions(exc: pytest.ExceptionInfo[ValidationError], field: str) -> bool:
    return any(field in str(err["loc"]) for err in exc.value.errors())


# --- Registered (ordinary) nodes -------------------------------------------------------------


def test_registered_node_requires_type_id_version_and_params() -> None:
    node = _node({"id": "rk", "type_id": "transform.rank", "type_version": "1.0.0", "params": {}})
    assert isinstance(node, RegisteredNode)
    assert node.type_version == "1.0.0"


def test_registered_node_without_type_version_is_rejected_at_that_field() -> None:
    with pytest.raises(ValidationError) as exc:
        _node({"id": "rk", "type_id": "transform.rank", "params": {}})
    assert _loc_mentions(exc, "type_version")


def test_registered_node_without_params_is_rejected_at_that_field() -> None:
    with pytest.raises(ValidationError) as exc:
        _node({"id": "rk", "type_id": "transform.rank", "type_version": "1.0.0"})
    assert _loc_mentions(exc, "params")


def test_registered_node_rejects_ref_as_extra_field() -> None:
    with pytest.raises(ValidationError):
        _node(
            {
                "id": "rk",
                "type_id": "transform.rank",
                "type_version": "1.0.0",
                "params": {},
                "ref": "c1",
            }
        )


def test_node_accepts_unknown_future_type_id() -> None:
    node = _node(
        {"id": "x", "type_id": "ai.generated.regime_v7", "type_version": "0.1.0", "params": {}}
    )
    assert isinstance(node, RegisteredNode)
    assert node.type_id == "ai.generated.regime_v7"


def test_node_type_id_must_be_namespaced() -> None:
    with pytest.raises(ValidationError):
        _node({"id": "x", "type_id": "rank", "type_version": "1.0.0", "params": {}})


# --- Reserved component node -----------------------------------------------------------------


def test_component_node_requires_ref_and_forbids_type_version() -> None:
    node = _node({"id": "c", "type_id": "component", "ref": "c1", "params": {}})
    assert isinstance(node, ComponentRefNode)
    assert node.ref == "c1"

    with pytest.raises(ValidationError) as exc:  # missing ref
        _node({"id": "c", "type_id": "component", "params": {}})
    assert _loc_mentions(exc, "ref")

    with pytest.raises(ValidationError):  # must not carry type_version
        _node(
            {"id": "c", "type_id": "component", "ref": "c1", "params": {}, "type_version": "1.0.0"}
        )


# --- Strictness / portable params ------------------------------------------------------------


def test_node_forbids_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        _node(
            {
                "id": "rk",
                "type_id": "transform.rank",
                "type_version": "1.0.0",
                "params": {},
                "bonus": 1,
            }
        )


def test_node_params_reject_non_portable_json() -> None:
    with pytest.raises(ValidationError):
        _node(
            {
                "id": "rk",
                "type_id": "transform.rank",
                "type_version": "1.0.0",
                "params": {"x": float("inf")},
            }
        )


# --- Edge ------------------------------------------------------------------------------------


def test_edge_parses_from_and_to_arrays_and_round_trips() -> None:
    edge = Edge.model_validate({"from": ["px", "series"], "to": ["ret", "series"]})
    assert edge.from_ == ("px", "series")
    assert edge.to == ("ret", "series")
    dumped = edge.model_dump(mode="json", by_alias=True)
    assert dumped == {"from": ["px", "series"], "to": ["ret", "series"]}
    assert Edge.model_validate(dumped) == edge


def test_edge_requires_two_element_endpoints() -> None:
    with pytest.raises(ValidationError):
        Edge.model_validate({"from": ["px"], "to": ["ret", "series"]})


def test_node_union_json_schema_distinguishes_variants() -> None:
    schema = NodeAdapter.json_schema()
    text = str(schema)
    # The schema must keep ordinary and component nodes structurally distinguishable...
    assert "RegisteredNode" in text
    assert "ComponentRefNode" in text
    # ...and remain generic (type_id is a pattern, not an enum of built-in node types).
    assert "pattern" in text
