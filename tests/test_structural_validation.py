"""M1.2 structural-validation tests.

Structural-only: no node registry/catalog/descriptor is consulted (those are M2). Every negative
fixture here **parses** under the M1.1 models; M1.2 catches the cross-element faults Pydantic cannot
express. See the M1-vs-M2 boundary in ``docs/plans/M1_IMPLEMENTATION_PLAN.md`` §4.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument
from quantize.schema.version import CURRENT_SCHEMA_VERSION
from quantize.validation import (
    ComponentKey,
    StructuralError,
    validate_component_definition,
    validate_component_set,
    validate_strategy_document,
)
from tests.helpers import load_fixture, load_invalid_fixture

_OWNER = "22222222-2222-2222-2222-222222222222"
_UNSUPPORTED_SCHEMA_VERSION = "0.2.0"  # deliberately outside SUPPORTED_SCHEMA_VERSIONS
CID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
CID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
CID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc"
CID_D = "dddddddd-dddd-dddd-dddd-dddddddddddd"


def _codes(errors: tuple[StructuralError, ...]) -> set[str]:
    return {err.code for err in errors}


def _order_key(err: StructuralError) -> tuple[Any, ...]:
    loc = tuple((0, e) if isinstance(e, int) else (1, e) for e in err.loc)
    return (loc, err.code, err.subject or "")


# --- Positive: valid documents are accepted ---------------------------------------------------


@pytest.mark.parametrize("name", ["strategy_a", "strategy_b"])
def test_reference_strategy_is_structurally_valid(name: str) -> None:
    doc = StrategyDocument.model_validate(load_fixture(name))
    result = validate_strategy_document(doc)
    assert result.ok is True
    assert result.errors == ()


def test_empty_graph_is_structurally_valid() -> None:
    data = load_fixture("strategy_a")
    data["nodes"] = []
    data["edges"] = []
    data["component_refs"] = []
    result = validate_strategy_document(StrategyDocument.model_validate(data))
    assert result.ok is True


def test_unknown_future_type_id_remains_structurally_valid() -> None:
    # Invariant 9 / plan §4: M1 accepts an unknown future namespaced type_id; M2 rejects it.
    data = load_fixture("strategy_a")
    data["nodes"].append(
        {"id": "future", "type_id": "ai.generated.block", "type_version": "9.9.9", "params": {}}
    )
    result = validate_strategy_document(StrategyDocument.model_validate(data))
    assert result.ok is True


# --- Negative: graph structure ----------------------------------------------------------------


def test_duplicate_node_id_rejected() -> None:
    doc = StrategyDocument.model_validate(load_invalid_fixture("duplicate_node_id"))
    result = validate_strategy_document(doc)
    assert result.ok is False
    assert "duplicate_node_id" in _codes(result.errors)
    dup = next(e for e in result.errors if e.code == "duplicate_node_id")
    assert dup.subject == "a"
    assert dup.loc[0] == "nodes"


def test_dangling_edge_source_rejected() -> None:
    doc = StrategyDocument.model_validate(load_invalid_fixture("dangling_edge_source"))
    result = validate_strategy_document(doc)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "edge_endpoint_unknown_node")
    assert err.loc == ("edges", 0, "from")
    assert err.subject == "ghost"


def test_dangling_edge_destination_rejected() -> None:
    doc = StrategyDocument.model_validate(load_invalid_fixture("dangling_edge_destination"))
    result = validate_strategy_document(doc)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "edge_endpoint_unknown_node")
    assert err.loc == ("edges", 0, "to")
    assert err.subject == "ghost"


def test_self_edge_rejected_and_not_double_reported_as_cycle() -> None:
    doc = StrategyDocument.model_validate(load_invalid_fixture("self_edge"))
    result = validate_strategy_document(doc)
    assert result.ok is False
    assert "self_edge" in _codes(result.errors)
    assert "graph_cycle" not in _codes(result.errors)
    err = next(e for e in result.errors if e.code == "self_edge")
    assert err.loc == ("edges", 0)
    assert err.subject == "a"


def test_simple_cycle_rejected() -> None:
    doc = StrategyDocument.model_validate(load_invalid_fixture("cycle_simple"))
    result = validate_strategy_document(doc)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "graph_cycle")
    assert "->" in err.message
    assert err.subject in {"a", "b"}


def test_multi_node_cycle_rejected() -> None:
    doc = StrategyDocument.model_validate(load_invalid_fixture("cycle_multi_node"))
    result = validate_strategy_document(doc)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "graph_cycle")
    for node_id in ("a", "b", "c"):
        assert node_id in err.message


def test_disconnected_graph_with_isolated_cycle_rejected() -> None:
    # The cycle (x<->y) lives in a different connected component from the acyclic part (p->q) and
    # the isolated node; detection must scan EVERY component, not only the first sorted root.
    doc = StrategyDocument.model_validate(load_invalid_fixture("cycle_disconnected"))
    result = validate_strategy_document(doc)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "graph_cycle")
    cycle_tokens = err.message.split(": ", 1)[1].replace("->", " ").split()
    assert "x" in cycle_tokens and "y" in cycle_tokens  # cyclic portion identified
    assert {"p", "q", "iso"}.isdisjoint(cycle_tokens)  # acyclic part not implicated
    assert err.subject in {"x", "y"}
    assert validate_strategy_document(doc).errors == result.errors  # deterministic


# --- Negative: component references within a document ------------------------------------------


def test_unknown_component_ref_rejected() -> None:
    doc = StrategyDocument.model_validate(load_invalid_fixture("unknown_component_ref"))
    result = validate_strategy_document(doc)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "unknown_component_ref")
    assert err.subject == "missing"
    assert err.loc[0] == "nodes"


def test_duplicate_component_ref_id_rejected() -> None:
    doc = StrategyDocument.model_validate(load_invalid_fixture("duplicate_ref_id"))
    result = validate_strategy_document(doc)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "duplicate_ref_id")
    assert err.subject == "r1"
    assert err.loc[0] == "component_refs"


def test_strategy_document_resolves_declared_component_ref() -> None:
    # Document-level happy path: a reserved `component` node whose `ref` resolves to a declared
    # `component_refs` entry. M1.2 checks resolution structurally only — it does NOT load or
    # resolve the referenced component definition (that is M2/M3).
    data = load_fixture("strategy_a")
    data["nodes"] = [{"id": "cnode", "type_id": "component", "ref": "r1", "params": {}}]
    data["edges"] = []
    data["component_refs"] = [{"id": "r1", "component_id": CID_B, "version": "1.0.0"}]
    result = validate_strategy_document(StrategyDocument.model_validate(data))
    assert result.ok is True


# --- Diagnostics: collect-all + deterministic ordering ----------------------------------------


def test_collects_all_errors_in_deterministic_order() -> None:
    data = load_invalid_fixture("duplicate_node_id")  # two nodes both id "a"
    data["edges"] = [
        {"from": ["a", "o"], "to": ["a", "i"]},  # self-edge
        {"from": ["ghost", "o"], "to": ["a", "i"]},  # dangling source
    ]
    doc = StrategyDocument.model_validate(data)
    result = validate_strategy_document(doc)
    assert result.ok is False
    assert {"duplicate_node_id", "self_edge", "edge_endpoint_unknown_node"} <= _codes(result.errors)
    # Deterministic: returned in stable order, and identical across repeated calls.
    assert list(result.errors) == sorted(result.errors, key=_order_key)
    assert validate_strategy_document(doc).errors == result.errors


def test_error_carries_useful_code_and_location() -> None:
    doc = StrategyDocument.model_validate(load_invalid_fixture("duplicate_node_id"))
    err = validate_strategy_document(doc).errors[0]
    assert isinstance(err.code, str) and err.code
    assert isinstance(err.message, str) and err.message
    assert isinstance(err.loc, tuple)


# --- M1/M2 boundary: an absent `ref` field is a *parse-level* (M1.1) rejection -----------------


def test_component_node_missing_ref_field_is_parse_level_rejection() -> None:
    data = load_fixture("strategy_a")
    data["nodes"] = [{"id": "c", "type_id": "component", "params": {}}]  # no `ref`
    with pytest.raises(ValidationError):
        StrategyDocument.model_validate(data)


# --- Supported schema_version (plan §4, M1 column) ---------------------------------------------


def test_supported_strategy_schema_version_passes() -> None:
    data = load_fixture("strategy_a")
    data["schema_version"] = CURRENT_SCHEMA_VERSION
    result = validate_strategy_document(StrategyDocument.model_validate(data))
    assert result.ok is True
    assert "unsupported_schema_version" not in _codes(result.errors)


def test_unsupported_strategy_schema_version_rejected() -> None:
    data = load_fixture("strategy_a")
    data["schema_version"] = _UNSUPPORTED_SCHEMA_VERSION
    doc = StrategyDocument.model_validate(data)  # parses fine; structurally unsupported
    result = validate_strategy_document(doc)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "unsupported_schema_version")
    assert err.loc == ("schema_version",)
    assert err.subject == _UNSUPPORTED_SCHEMA_VERSION
    assert CURRENT_SCHEMA_VERSION in err.message  # message identifies what IS supported
    # Stable + deterministic + non-mutating.
    assert validate_strategy_document(doc).errors == result.errors


def test_supported_component_schema_version_passes() -> None:
    comp = _component_def(CID_A, "1.0.0", schema_version=CURRENT_SCHEMA_VERSION)
    result = validate_component_definition(comp)
    assert result.ok is True
    assert "unsupported_schema_version" not in _codes(result.errors)


def test_unsupported_component_schema_version_rejected() -> None:
    comp = _component_def(CID_A, "1.0.0", schema_version=_UNSUPPORTED_SCHEMA_VERSION)
    result = validate_component_definition(comp)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "unsupported_schema_version")
    assert err.loc == ("schema_version",)
    assert err.subject == _UNSUPPORTED_SCHEMA_VERSION
    assert validate_component_definition(comp).errors == result.errors


# --- Component definitions & component sets ----------------------------------------------------


def _component_def(
    component_id: str,
    version: str,
    *,
    refs: tuple[tuple[str, str, str], ...] = (),
    nodes: tuple[dict[str, Any], ...] = (),
    edges: tuple[dict[str, Any], ...] = (),
    schema_version: str = CURRENT_SCHEMA_VERSION,
) -> ComponentDefinition:
    return ComponentDefinition.model_validate(
        {
            "component_id": component_id,
            "version": version,
            "schema_version": schema_version,
            "name": "C",
            "component_refs": [
                {"id": rid, "component_id": cid, "version": ver} for (rid, cid, ver) in refs
            ],
            "implementation": {
                "kind": "graph",
                "graph": {"nodes": list(nodes), "edges": list(edges)},
            },
            "exposed_inputs": [],
            "exposed_outputs": [],
            "exposed_params": [],
            "provenance": {
                "owner": _OWNER,
                "creator": _OWNER,
                "contributors": [],
                "forked_from": None,
                "visibility": "private",
                "duplicable": False,
                "created_at": "2026-06-23T00:00:00Z",
            },
        }
    )


def test_valid_component_definition_passes() -> None:
    comp = _component_def(
        CID_A,
        "1.0.0",
        refs=(("child", CID_B, "1.0.0"),),
        nodes=({"id": "n", "type_id": "component", "ref": "child", "params": {}},),
    )
    result = validate_component_definition(comp)
    assert result.ok is True


def test_component_definition_internal_graph_is_validated() -> None:
    comp = _component_def(
        CID_A,
        "1.0.0",
        nodes=({"id": "n", "type_id": "data.price", "type_version": "1.0.0", "params": {}},),
        edges=({"from": ["ghost", "o"], "to": ["n", "i"]},),
    )
    result = validate_component_definition(comp)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "edge_endpoint_unknown_node")
    assert err.loc[:3] == ("implementation", "graph", "edges")


def test_component_definition_unknown_internal_component_ref_rejected() -> None:
    # An internal `component` node whose `ref` matches no declared local component_refs entry.
    comp = _component_def(
        CID_A,
        "1.0.0",
        nodes=({"id": "n", "type_id": "component", "ref": "nope", "params": {}},),
    )
    result = validate_component_definition(comp)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "unknown_component_ref")
    assert err.subject == "nope"
    assert err.loc[:2] == ("implementation", "graph")


def test_duplicate_ref_id_inside_component_definition_rejected() -> None:
    comp = _component_def(
        CID_A,
        "1.0.0",
        refs=(("r1", CID_B, "1.0.0"), ("r1", CID_C, "1.0.0")),
    )
    result = validate_component_definition(comp)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "duplicate_ref_id")
    assert err.subject == "r1"


def test_direct_component_recursion_rejected_for_single_definition() -> None:
    comp = _component_def(CID_A, "1.0.0", refs=(("self", CID_A, "1.0.0"),))
    result = validate_component_definition(comp)
    assert result.ok is False
    assert "component_direct_recursion" in _codes(result.errors)


def test_deep_acyclic_chain_does_not_raise_recursion_error() -> None:
    # A long linear chain n0 -> n1 -> ... exceeds CPython's default recursion limit; the
    # explicit-stack DFS must still classify it as acyclic without crashing.
    n = 2000
    data = load_fixture("strategy_a")
    data["nodes"] = [
        {"id": f"n{i}", "type_id": "transform.latest", "type_version": "1.0.0", "params": {}}
        for i in range(n)
    ]
    data["edges"] = [{"from": [f"n{i}", "o"], "to": [f"n{i + 1}", "i"]} for i in range(n - 1)]
    result = validate_strategy_document(StrategyDocument.model_validate(data))
    assert result.ok is True


def test_valid_closed_component_set() -> None:
    defs = [
        _component_def(CID_A, "1.0.0", refs=(("toB", CID_B, "1.0.0"),)),
        _component_def(CID_B, "1.0.0"),
    ]
    result = validate_component_set(defs)
    assert result.ok is True
    assert result.errors == ()
    assert result.unresolved_refs == ()


def test_acyclic_incomplete_set_reports_unresolved_refs() -> None:
    # A depends on B, but only A is supplied: B is an unresolved external dep, NOT a failure.
    defs = [_component_def(CID_A, "1.0.0", refs=(("toB", CID_B, "1.0.0"),))]
    result = validate_component_set(defs)
    assert result.ok is True
    assert result.errors == ()
    assert ComponentKey(CID_B, "1.0.0") in result.unresolved_refs


def test_direct_component_recursion_rejected_in_set() -> None:
    defs = [_component_def(CID_A, "1.0.0", refs=(("self", CID_A, "1.0.0"),))]
    result = validate_component_set(defs)
    assert result.ok is False
    assert "component_direct_recursion" in _codes(result.errors)


def test_two_component_cycle_rejected() -> None:
    # A -> B -> A. Distinct from direct self-reference (no self-ref present) and from the existing
    # three-component transitive cycle. Reported as `component_cycle`, deterministically.
    defs = [
        _component_def(CID_A, "1.0.0", refs=(("toB", CID_B, "1.0.0"),)),
        _component_def(CID_B, "1.0.0", refs=(("toA", CID_A, "1.0.0"),)),
    ]
    result = validate_component_set(defs)
    assert result.ok is False
    codes = _codes(result.errors)
    assert "component_cycle" in codes
    assert "component_direct_recursion" not in codes  # a 2-cycle is not a self-reference
    err = next(e for e in result.errors if e.code == "component_cycle")
    assert CID_A in err.message and CID_B in err.message
    assert validate_component_set(defs).errors == result.errors  # deterministic


def test_transitive_component_recursion_rejected() -> None:
    defs = [
        _component_def(CID_A, "1.0.0", refs=(("toB", CID_B, "1.0.0"),)),
        _component_def(CID_B, "1.0.0", refs=(("toC", CID_C, "1.0.0"),)),
        _component_def(CID_C, "1.0.0", refs=(("toA", CID_A, "1.0.0"),)),
    ]
    result = validate_component_set(defs)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "component_cycle")
    for cid in (CID_A, CID_B, CID_C):
        assert cid in err.message


def test_multiple_self_refs_emit_single_direct_recursion_in_set() -> None:
    # LOW-2 policy: `validate_component_set` emits ONE `component_direct_recursion` diagnostic per
    # component identity, even when a definition declares several self-referencing component_refs.
    comp = _component_def(
        CID_A, "1.0.0", refs=(("self1", CID_A, "1.0.0"), ("self2", CID_A, "1.0.0"))
    )
    result = validate_component_set([comp])
    assert result.ok is False
    direct = [e for e in result.errors if e.code == "component_direct_recursion"]
    assert len(direct) == 1
    assert direct[0].subject is not None and CID_A in direct[0].subject


def test_duplicate_component_identity_version_in_set_rejected() -> None:
    defs = [_component_def(CID_A, "1.0.0"), _component_def(CID_A, "1.0.0")]
    result = validate_component_set(defs)
    assert result.ok is False
    err = next(e for e in result.errors if e.code == "duplicate_component_definition")
    assert err.subject is not None and CID_A in err.subject


def test_same_component_id_different_versions_is_not_a_duplicate() -> None:
    defs = [_component_def(CID_A, "1.0.0"), _component_def(CID_A, "2.0.0")]
    result = validate_component_set(defs)
    assert result.ok is True
    assert result.errors == ()


# --- Component-set boundary regressions (Codex-verified, now committed) ------------------------


def test_valid_diamond_dependency_graph() -> None:
    # A -> B, A -> C, B -> D, C -> D. A diamond is acyclic and fully resolved.
    defs = [
        _component_def(CID_A, "1.0.0", refs=(("toB", CID_B, "1.0.0"), ("toC", CID_C, "1.0.0"))),
        _component_def(CID_B, "1.0.0", refs=(("toD", CID_D, "1.0.0"),)),
        _component_def(CID_C, "1.0.0", refs=(("toD", CID_D, "1.0.0"),)),
        _component_def(CID_D, "1.0.0"),
    ]
    result = validate_component_set(defs)
    assert result.ok is True
    assert result.errors == ()
    assert result.unresolved_refs == ()


def test_valid_longer_acyclic_chain() -> None:
    # A -> B -> C, kept separate from the diamond test so a failure pinpoints the shape.
    defs = [
        _component_def(CID_A, "1.0.0", refs=(("toB", CID_B, "1.0.0"),)),
        _component_def(CID_B, "1.0.0", refs=(("toC", CID_C, "1.0.0"),)),
        _component_def(CID_C, "1.0.0"),
    ]
    result = validate_component_set(defs)
    assert result.ok is True
    assert result.errors == ()
    assert result.unresolved_refs == ()


def test_same_id_cross_version_acyclic_dependency_passes() -> None:
    # A@1.0.0 -> A@2.0.0 with no reverse edge: distinct (component_id, version) identities, acyclic.
    defs = [
        _component_def(CID_A, "1.0.0", refs=(("toA2", CID_A, "2.0.0"),)),
        _component_def(CID_A, "2.0.0"),
    ]
    result = validate_component_set(defs)
    assert result.ok is True
    assert result.errors == ()  # neither direct recursion nor duplicate identity
    assert result.unresolved_refs == ()


def test_same_id_cross_version_cycle_rejected() -> None:
    # A@1.0.0 -> A@2.0.0 -> A@1.0.0: a genuine cycle between two distinct pinned versions.
    defs = [
        _component_def(CID_A, "1.0.0", refs=(("toA2", CID_A, "2.0.0"),)),
        _component_def(CID_A, "2.0.0", refs=(("toA1", CID_A, "1.0.0"),)),
    ]
    result = validate_component_set(defs)
    assert result.ok is False
    codes = _codes(result.errors)
    assert "component_cycle" in codes
    assert "component_direct_recursion" not in codes  # cross-version, not self-reference
    assert "duplicate_component_definition" not in codes  # distinct versions, not a duplicate
    err = next(e for e in result.errors if e.code == "component_cycle")
    assert f"{CID_A}@1.0.0" in err.message and f"{CID_A}@2.0.0" in err.message
    assert validate_component_set(defs).errors == result.errors  # deterministic
