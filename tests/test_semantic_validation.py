"""M2.2 — semantic validation (registry resolution + wiring by name)."""

import json
from pathlib import Path

from quantize.registry.registry import NodeRegistry
from quantize.schema.document import StrategyDocument
from quantize.validation.errors import SemanticDiagnostic, SemanticValidation
from quantize.validation.semantic import validate_strategy_semantics
from tests.registry_fixtures import (
    build_fixture_registry,
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
    assert any(
        d.code == "node_version_unavailable" and d.subject == "test.source" for d in v.diagnostics
    )


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


# --- determinism -----------------------------------------------------------------------------


def test_diagnostics_are_deterministically_ordered() -> None:
    doc = build_wired_document(source_out_port="nope", sink_in_port="nope")
    a = validate_strategy_semantics(doc, build_fixture_registry()).diagnostics
    b = validate_strategy_semantics(doc, build_fixture_registry()).diagnostics
    assert a == b


# --- reference strategies --------------------------------------------------------------------


def test_reference_strategy_a_wiring_resolves() -> None:
    v = validate_strategy_semantics(_load("strategy_a.json"), build_reference_registry())
    assert v.ok, v.diagnostics


def test_reference_strategy_b_wiring_resolves() -> None:
    v = validate_strategy_semantics(_load("strategy_b.json"), build_reference_registry())
    assert v.ok, v.diagnostics
