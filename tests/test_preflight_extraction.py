"""M9.1: the extracted document pre-flight is the single implementation the evaluator uses.

Two guarantees are pinned here:

* **Parity** — for a corpus spanning every pre-flight layer (structural, semantic, resolution,
  the terminal rule) plus the clean-pass reference strategies, down-converting
  ``run_document_preflight`` exactly as the evaluator does reproduces
  ``evaluate_strategy(...).diagnostics`` byte-for-byte. This is the "no second implementation"
  proof: the evaluator's document checks ARE ``run_document_preflight``.
* **loc-preservation** — the native pre-flight output carries the ``loc`` tuples the evaluator's
  uniform ``RuntimeDiagnostic`` stream necessarily drops, so an API can present them.

Every existing evaluator/validation test staying green (run by the full suite) is the third leg:
the extraction changed no behavior.
"""

from __future__ import annotations

from datetime import date, datetime

from quantize.components.resolve import ComponentCatalog
from quantize.evaluator.evaluate import evaluate_strategy
from quantize.evaluator.preflight import PreflightResult, run_document_preflight
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.runtime.binding import ImplementationCatalog
from quantize.runtime.diagnostics import RuntimeDiagnostic, sort_runtime_diagnostics
from quantize.schema.document import StrategyDocument
from tests.helpers import load_fixture, load_invalid_fixture
from tests.market_fixture import build_market_fixture
from tests.runtime_fixtures import (
    EVAL_INSTANT,
    RUN_ID,
    build_synthetic_catalog,
    edge,
    node,
    synthetic_document,
    two_session_dataset,
)

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

_REF_MAIN_DATE = date(2026, 6, 1)  # a session with full history for every fixture asset


def _downconvert(preflight: PreflightResult) -> tuple[RuntimeDiagnostic, ...]:
    """Reproduce the evaluator's own down-conversion of the pre-flight result to its uniform
    ``RuntimeDiagnostic`` stream — the exact transformation ``evaluate_strategy`` performs."""
    diagnostics: list[RuntimeDiagnostic] = []
    for error in preflight.structural:
        diagnostics.append(
            RuntimeDiagnostic(error.code, f"structural: {error.message}", subject=error.subject)
        )
    for finding in preflight.semantic:
        diagnostics.append(
            RuntimeDiagnostic(finding.code, f"semantic: {finding.message}", subject=finding.subject)
        )
    diagnostics.extend(preflight.runtime)
    return sort_runtime_diagnostics(diagnostics)


def _assert_parity(
    document: StrategyDocument,
    catalog: ImplementationCatalog,
    market_data: MarketDataSet,
    instant: datetime,
    *,
    components: ComponentCatalog | None = None,
) -> PreflightResult:
    """The evaluator's diagnostics (at a visible-session instant, so ``NO_VISIBLE_SESSION`` never
    fires) equal the down-converted pre-flight. Returns the pre-flight for further asserts."""
    outcome = evaluate_strategy(
        document,
        catalog=catalog,
        market_data=market_data,
        run_id=RUN_ID,
        evaluation_instant=instant,
        components=components,
    )
    preflight = run_document_preflight(
        document, registry=catalog.descriptor_registry, components=components
    )
    assert _downconvert(preflight) == outcome.diagnostics
    return preflight


# --- Parity across every pre-flight layer -----------------------------------------------------


def test_parity_structural_faults() -> None:
    """The invalid corpus fails at the structural layer; the evaluator never reaches execution."""
    catalog = build_core_catalog()
    market = build_market_fixture()
    instant = market.calendar.session_on(_REF_MAIN_DATE).close_at  # type: ignore[union-attr]
    for name in _INVALID_FIXTURES:
        document = StrategyDocument.model_validate(load_invalid_fixture(name))
        preflight = _assert_parity(document, catalog, market, instant)
        assert not preflight.structural_ok
        assert preflight.structural  # the layer that failed is populated
        assert preflight.semantic == ()  # gated: not run once structural failed
        assert preflight.runtime == ()
        assert not preflight.ok


def test_parity_reference_strategies_clean_pass() -> None:
    """Strategy A and B pass every layer: down-converted pre-flight and evaluator both empty."""
    catalog = build_core_catalog()
    market = build_market_fixture()
    instant = market.calendar.session_on(_REF_MAIN_DATE).close_at  # type: ignore[union-attr]
    for name in ("strategy_a", "strategy_b"):
        document = StrategyDocument.model_validate(load_fixture(name))
        preflight = _assert_parity(document, catalog, market, instant)
        assert preflight.ok
        assert preflight.structural_ok and preflight.semantic_ok and preflight.resolution_ok
        assert preflight.structural == () and preflight.semantic == () and preflight.runtime == ()


def test_parity_semantic_fault_unknown_type() -> None:
    """An unknown node type is a semantic fault; structural passes, semantic populates."""
    document = synthetic_document([node("mystery", "test.does_not_exist")], [])
    catalog = build_synthetic_catalog()
    preflight = _assert_parity(document, catalog, two_session_dataset(), EVAL_INSTANT)
    assert preflight.structural_ok
    assert not preflight.semantic_ok
    assert preflight.semantic  # semantic layer flagged the unknown type
    assert any(d.code == "unknown_node_type" for d in preflight.semantic)


def test_parity_missing_terminal_is_runtime_layer() -> None:
    """No terminal node → a runtime-layer diagnostic (structural + semantic + resolution pass)."""
    document = synthetic_document([node("c", "test.const", {"value": 1})], [], with_terminal=False)
    catalog = build_synthetic_catalog()
    preflight = _assert_parity(document, catalog, two_session_dataset(), EVAL_INSTANT)
    assert preflight.structural_ok and preflight.semantic_ok and preflight.resolution_ok
    assert any(d.code == "missing_terminal_node" for d in preflight.runtime)
    assert not preflight.ok


def test_parity_multiple_terminals_is_runtime_layer() -> None:
    """Two terminal nodes → the MULTIPLE_TERMINAL_NODES runtime diagnostic."""
    extra = [
        node("ptsrc2", "test.targets", {"weights": {"SPY": 0.5}}),
        node("term2", "output.target_portfolio"),
    ]
    extra_edges = [edge(("ptsrc2", "targets"), ("term2", "targets"))]
    document = synthetic_document(extra, extra_edges)  # base tail adds a second terminal
    catalog = build_synthetic_catalog()
    preflight = _assert_parity(document, catalog, two_session_dataset(), EVAL_INSTANT)
    assert any(d.code == "multiple_terminal_nodes" for d in preflight.runtime)


# --- loc preservation (native shapes carry what the evaluator drops) ---------------------------


def test_structural_native_output_preserves_loc() -> None:
    """A structural fault's native ``loc`` tuple survives in the pre-flight; the evaluator's
    down-converted RuntimeDiagnostic has no ``loc`` field at all."""
    document = StrategyDocument.model_validate(load_invalid_fixture("self_edge"))
    catalog = build_core_catalog()
    preflight = run_document_preflight(document, registry=catalog.descriptor_registry)
    assert preflight.structural
    for error in preflight.structural:
        assert isinstance(error.loc, tuple)
        assert error.loc  # non-empty structural path
    # The uniform runtime stream the evaluator builds cannot carry loc:
    assert not hasattr(RuntimeDiagnostic("x", "y"), "loc")


def test_semantic_native_output_preserves_loc() -> None:
    """A semantic fault's native ``loc`` tuple is available in the pre-flight result."""
    document = synthetic_document([node("mystery", "test.does_not_exist")], [])
    catalog = build_synthetic_catalog()
    preflight = run_document_preflight(document, registry=catalog.descriptor_registry)
    assert preflight.semantic
    for finding in preflight.semantic:
        assert isinstance(finding.loc, tuple)


def test_resolution_is_reusable_downstream() -> None:
    """The pre-flight surfaces the resolved strategy the evaluator reuses for execution."""
    document = synthetic_document([node("c", "test.const", {"value": 1})], [])
    catalog = build_synthetic_catalog()
    preflight = run_document_preflight(document, registry=catalog.descriptor_registry)
    assert preflight.resolution.ok
    assert preflight.resolution_ok
