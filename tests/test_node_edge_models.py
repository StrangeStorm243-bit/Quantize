"""Tests for the generic NodeInstance and Edge models (M1.1a)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from quantize.schema.nodes import Edge, NodeInstance

# --- NodeInstance: ordinary nodes ------------------------------------------------------------


def test_ordinary_node_requires_type_id_and_type_version() -> None:
    node = NodeInstance.model_validate(
        {"id": "rk", "type_id": "transform.rank", "type_version": "1.0.0", "params": {"d": True}}
    )
    assert node.type_id == "transform.rank"
    assert node.type_version == "1.0.0"


def test_ordinary_node_without_type_version_is_rejected() -> None:
    with pytest.raises(ValidationError):
        NodeInstance.model_validate({"id": "rk", "type_id": "transform.rank"})


def test_ordinary_node_with_ref_is_rejected() -> None:
    with pytest.raises(ValidationError):
        NodeInstance.model_validate(
            {"id": "rk", "type_id": "transform.rank", "type_version": "1.0.0", "ref": "c1"}
        )


def test_node_accepts_unknown_future_type_id() -> None:
    # The extensible-block seam: M1 accepts a structurally valid node of an unknown future type.
    node = NodeInstance.model_validate(
        {"id": "x", "type_id": "future.unheard_of_block", "type_version": "0.1.0"}
    )
    assert node.type_id == "future.unheard_of_block"


def test_node_type_id_is_validated_not_open_ended() -> None:
    with pytest.raises(ValidationError):
        NodeInstance.model_validate({"id": "x", "type_id": "rank", "type_version": "1.0.0"})


# --- NodeInstance: the reserved component node -----------------------------------------------


def test_component_node_requires_ref_and_forbids_type_version() -> None:
    node = NodeInstance.model_validate({"id": "c", "type_id": "component", "ref": "c1"})
    assert node.ref == "c1"
    assert node.type_version is None

    with pytest.raises(ValidationError):  # missing ref
        NodeInstance.model_validate({"id": "c", "type_id": "component"})
    with pytest.raises(ValidationError):  # must not carry type_version
        NodeInstance.model_validate(
            {"id": "c", "type_id": "component", "ref": "c1", "type_version": "1.0.0"}
        )


# --- NodeInstance: strictness, portable params, round-trip -----------------------------------


def test_node_forbids_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        NodeInstance.model_validate(
            {"id": "rk", "type_id": "transform.rank", "type_version": "1.0.0", "bonus": 1}
        )


def test_node_params_reject_non_portable_json() -> None:
    with pytest.raises(ValidationError):
        NodeInstance.model_validate(
            {
                "id": "rk",
                "type_id": "transform.rank",
                "type_version": "1.0.0",
                "params": {"x": float("inf")},
            }
        )


def test_node_round_trips_with_ui_and_extensions() -> None:
    payload = {
        "id": "rk",
        "type_id": "transform.rank",
        "type_version": "1.0.0",
        "params": {"descending": True},
        "ui": {"x": 10, "y": 20},
        "extensions": {"vendor.note": "hello"},
    }
    node = NodeInstance.model_validate(payload)
    restored = NodeInstance.model_validate_json(node.model_dump_json())
    assert restored == node
    assert restored.ui == {"x": 10, "y": 20}
    assert restored.extensions == {"vendor.note": "hello"}


def test_node_json_schema_marks_id_and_type_id_required() -> None:
    schema = NodeInstance.model_json_schema()
    assert "id" in schema["required"]
    assert "type_id" in schema["required"]
    assert "type_version" not in schema["required"]  # optional at the field level


# --- Edge ------------------------------------------------------------------------------------


def test_edge_parses_from_and_to_arrays_and_round_trips() -> None:
    edge = Edge.model_validate({"from": ["px", "series"], "to": ["ret", "series"]})
    assert edge.from_ == ("px", "series")
    assert edge.to == ("ret", "series")
    # In JSON mode the tuple endpoints serialize as arrays (the canonical IR form).
    dumped = edge.model_dump(mode="json", by_alias=True)
    assert dumped == {"from": ["px", "series"], "to": ["ret", "series"]}
    assert Edge.model_validate(dumped) == edge


def test_edge_requires_two_element_endpoints() -> None:
    with pytest.raises(ValidationError):
        Edge.model_validate({"from": ["px"], "to": ["ret", "series"]})


def test_edge_json_schema_uses_tuple_prefix_items() -> None:
    schema = Edge.model_json_schema(by_alias=True)
    assert "from" in schema["properties"]
    from_schema = schema["properties"]["from"]
    assert from_schema["type"] == "array"
    assert len(from_schema["prefixItems"]) == 2
