"""M2.2 — semantic validation (registry resolution + wiring by name)."""

import json
from pathlib import Path

from quantize.registry.registry import NodeRegistry
from quantize.schema.document import StrategyDocument
from quantize.validation.errors import SemanticDiagnostic, SemanticValidation
from quantize.validation.semantic import validate_strategy_semantics
from tests.registry_fixtures import (
    build_component_edge_document,
    build_fixture_registry,
    build_incompatible_document,
    build_reference_registry,
    build_unknown_source_document,
    build_wired_document,
)

_FIX = Path(__file__).parent / "fixtures"


def _load(name: str) -> StrategyDocument:
    return StrategyDocument.model_validate(json.loads((_FIX / name).read_text(encoding="utf-8")))


# --- result types ----------------------------------------------------------------------------


def test_semantic_validation_ok_when_empty() -> None:
    v = SemanticValidation(ok=True)
    assert v.ok and v.diagnostics == ()


def test_semantic_diagnostic_fields() -> None:
    d = SemanticDiagnostic(code="unknown_node_type", message="x", loc=("nodes", 0), subject="a.b")
    assert d.code == "unknown_node_type" and d.loc == ("nodes", 0)


# --- node resolution -------------------------------------------------------------------------


def test_valid_document_resolves_clean() -> None:
    v = validate_strategy_semantics(build_wired_document(), build_fixture_registry())
    assert v.ok and v.diagnostics == ()


def test_unknown_node_type() -> None:
    v = validate_strategy_semantics(build_wired_document(), NodeRegistry())
    assert any(d.code == "unknown_node_type" for d in v.diagnostics) and not v.ok


def test_node_version_unavailable() -> None:
    doc = build_wired_document(source_type_version="9.9.9")
    v = validate_strategy_semantics(doc, build_fixture_registry())
    matches = [
        d
        for d in v.diagnostics
        if d.code == "node_version_unavailable" and d.subject == "test.source"
    ]
    assert matches
    # the message lists the available versions (registry has test.source@1.0.0 and @1.1.0)
    assert "1.0.0" in matches[0].message and "1.1.0" in matches[0].message


# --- port-name existence ---------------------------------------------------------------------


def test_unknown_output_port() -> None:
    doc = build_wired_document(source_out_port="nope")
    v = validate_strategy_semantics(doc, build_fixture_registry())
    assert any(d.code == "unknown_output_port" and d.subject == "nope" for d in v.diagnostics)


def test_unknown_input_port() -> None:
    doc = build_wired_document(sink_in_port="nope")
    v = validate_strategy_semantics(doc, build_fixture_registry())
    assert any(d.code == "unknown_input_port" and d.subject == "nope" for d in v.diagnostics)


# --- required-input connectivity -------------------------------------------------------------


def test_required_input_unconnected() -> None:
    doc = build_wired_document().model_copy(update={"edges": []})
    v = validate_strategy_semantics(doc, build_fixture_registry())
    assert any(d.code == "required_input_unconnected" and d.subject == "in" for d in v.diagnostics)


def test_optional_input_unconnected_is_fine() -> None:
    v = validate_strategy_semantics(build_wired_document(), build_fixture_registry())
    assert all(d.code != "required_input_unconnected" for d in v.diagnostics)


def test_connectivity_satisfied_even_if_source_unknown() -> None:
    # Edit-2: source is an unknown type, but its edge still satisfies sink.in connectivity.
    doc = build_unknown_source_document()
    v = validate_strategy_semantics(doc, build_fixture_registry())
    codes = {d.code for d in v.diagnostics}
    assert "unknown_node_type" in codes
    assert "required_input_unconnected" not in codes


# --- component endpoint (per-endpoint skip) --------------------------------------------------


def test_component_endpoint_skipped_registered_endpoint_clean() -> None:
    # Edit-1: a component node's output feeds a valid sink input. The component endpoint is skipped
    # (no port diagnostic for it), the registered endpoint is fine, so the document is clean.
    v = validate_strategy_semantics(build_component_edge_document(), build_fixture_registry())
    assert v.ok and v.diagnostics == ()


def test_component_endpoint_skipped_but_registered_endpoint_still_validated() -> None:
    # Edit-1: the component (source) endpoint is skipped, but the registered (sink) endpoint's bad
    # port name is still reported — proving only the component endpoint is skipped, not the edge.
    doc = build_component_edge_document(sink_in_port="nope")
    v = validate_strategy_semantics(doc, build_fixture_registry())
    codes = {d.code for d in v.diagnostics}
    assert "unknown_input_port" in codes  # registered endpoint validated
    assert "unknown_output_port" not in codes  # component endpoint skipped


# --- port-type compatibility (M2.3) ----------------------------------------------------------


def test_incompatible_port_types_detected() -> None:
    v = validate_strategy_semantics(build_incompatible_document(), build_fixture_registry())
    diags = [d for d in v.diagnostics if d.code == "incompatible_port_types"]
    assert diags
    # lock the diagnostic contract: edge-level loc and the destination input as subject
    assert diags[0].loc == ("edges", 0)
    assert diags[0].subject == "in"
    assert "TimeSeries[Number]" in diags[0].message and "CrossSection[Number]" in diags[0].message


def test_no_compat_diagnostic_when_input_port_missing() -> None:
    doc = build_wired_document(sink_in_port="nope")
    codes = {d.code for d in validate_strategy_semantics(doc, build_fixture_registry()).diagnostics}
    assert "unknown_input_port" in codes and "incompatible_port_types" not in codes


def test_no_compat_diagnostic_when_output_port_missing() -> None:
    doc = build_wired_document(source_out_port="nope")
    codes = {d.code for d in validate_strategy_semantics(doc, build_fixture_registry()).diagnostics}
    assert "unknown_output_port" in codes and "incompatible_port_types" not in codes


def test_no_compat_diagnostic_when_source_node_unresolved() -> None:
    doc = build_unknown_source_document()
    codes = {d.code for d in validate_strategy_semantics(doc, build_fixture_registry()).diagnostics}
    assert "unknown_node_type" in codes and "incompatible_port_types" not in codes


def test_no_compat_diagnostic_for_component_endpoint() -> None:
    v = validate_strategy_semantics(build_component_edge_document(), build_fixture_registry())
    assert all(d.code != "incompatible_port_types" for d in v.diagnostics)


# --- determinism -----------------------------------------------------------------------------


def test_diagnostics_are_deterministically_ordered() -> None:
    # Bad output + bad input on edges[0], plus the now-unconnected required sink input on nodes[1].
    # Order is (loc, code, subject): edge findings precede the node finding ("edges" < "nodes"),
    # and within edges[0] "from" precedes "to".
    doc = build_wired_document(source_out_port="nope", sink_in_port="nope")
    v = validate_strategy_semantics(doc, build_fixture_registry())
    assert [d.code for d in v.diagnostics] == [
        "unknown_output_port",
        "unknown_input_port",
        "required_input_unconnected",
    ]
    # repeatable across runs
    assert v.diagnostics == validate_strategy_semantics(doc, build_fixture_registry()).diagnostics


# --- reference strategies --------------------------------------------------------------------


def test_reference_strategy_a_wiring_resolves() -> None:
    v = validate_strategy_semantics(_load("strategy_a.json"), build_reference_registry())
    assert v.ok, v.diagnostics


def test_reference_strategy_b_wiring_resolves() -> None:
    v = validate_strategy_semantics(_load("strategy_b.json"), build_reference_registry())
    assert v.ok, v.diagnostics
