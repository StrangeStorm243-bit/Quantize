"""M3: evaluator mechanics over synthetic nodes — ordering, mapping, failures, determinism.

Quantitative node correctness is tested per real node; these tests pin the machinery itself.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from quantize.evaluator.evaluate import EvaluationOutcome, evaluate_strategy
from quantize.runtime.binding import ImplementationCatalog
from quantize.runtime.values import PortfolioTargetsValue, ScalarValue
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import Edge, NodeInstance
from quantize.schema.serialization import to_ir_dict
from tests.runtime_fixtures import (
    EVAL_INSTANT,
    RUN_ID,
    build_synthetic_catalog,
    edge,
    node,
    synthetic_document,
    two_session_dataset,
)


def _evaluate(
    document: StrategyDocument,
    catalog: ImplementationCatalog | None = None,
    instant: datetime = EVAL_INSTANT,
) -> EvaluationOutcome:
    return evaluate_strategy(
        document,
        catalog=catalog or build_synthetic_catalog(),
        market_data=two_session_dataset(),
        run_id=RUN_ID,
        evaluation_instant=instant,
    )


def _codes(outcome: EvaluationOutcome) -> list[str]:
    return [diagnostic.code for diagnostic in outcome.diagnostics]


def _diamond_nodes_edges() -> tuple[list[NodeInstance], list[Edge]]:
    """const(3) -> split -> sub(left=a, right=b): (3+1) - (3*2) = -2."""
    nodes = [
        node("c", "test.const", {"value": 3}),
        node("sp", "test.split"),
        node("sb", "test.sub"),
    ]
    edges = [
        edge(("c", "out"), ("sp", "in")),
        edge(("sp", "a"), ("sb", "left")),
        edge(("sp", "b"), ("sb", "right")),
    ]
    return nodes, edges


# --- basic shapes ------------------------------------------------------------------------------


def test_single_node_strategy_produces_targets() -> None:
    outcome = _evaluate(synthetic_document([], []))
    assert outcome.ok
    assert outcome.diagnostics == ()
    assert outcome.targets is not None
    assert outcome.targets.as_dict() == {"SPY": 0.5}
    assert outcome.targets.cash_weight == pytest.approx(0.5)


def test_linear_chain_flows_values() -> None:
    nodes = [node("c", "test.const", {"value": 4}), node("sp", "test.split")]
    edges = [edge(("c", "out"), ("sp", "in"))]
    outcome = _evaluate(synthetic_document(nodes, edges))
    assert outcome.ok
    a = outcome.output_value(["sp"], "a")
    b = outcome.output_value(["sp"], "b")
    assert isinstance(a, ScalarValue) and a.value == 5.0
    assert isinstance(b, ScalarValue) and b.value == 8.0


def test_branch_and_converge_maps_ports_correctly() -> None:
    nodes, edges = _diamond_nodes_edges()
    outcome = _evaluate(synthetic_document(nodes, edges))
    assert outcome.ok
    result = outcome.output_value(["sb"], "out")
    assert isinstance(result, ScalarValue)
    assert result.value == -2.0  # left=a=4, right=b=6 — asymmetric op proves the mapping


def test_swapped_edges_change_the_asymmetric_result() -> None:
    nodes, _ = _diamond_nodes_edges()
    edges = [
        edge(("c", "out"), ("sp", "in")),
        edge(("sp", "b"), ("sb", "left")),
        edge(("sp", "a"), ("sb", "right")),
    ]
    outcome = _evaluate(synthetic_document(nodes, edges))
    assert outcome.ok
    result = outcome.output_value(["sb"], "out")
    assert isinstance(result, ScalarValue)
    assert result.value == 2.0


def test_every_node_invoked_exactly_once_despite_fanout() -> None:
    log: list[tuple[tuple[str, ...], str]] = []
    nodes, edges = _diamond_nodes_edges()
    outcome = _evaluate(synthetic_document(nodes, edges), build_synthetic_catalog(log))
    assert outcome.ok
    invoked = [node_id for _, node_id in log]
    assert sorted(invoked) == ["c", "ptsrc", "sb", "sp", "term"]  # once each


def test_evaluation_order_is_deterministic_topological() -> None:
    log: list[tuple[tuple[str, ...], str]] = []
    nodes = [
        node("nb", "test.const"),
        node("na", "test.const"),
        node("nc", "test.const"),
    ]
    outcome = _evaluate(synthetic_document(nodes, []), build_synthetic_catalog(log))
    assert outcome.ok
    assert [node_id for _, node_id in log] == ["na", "nb", "nc", "ptsrc", "term"]


def test_optional_input_may_stay_unconnected() -> None:
    outcome = _evaluate(synthetic_document([node("o", "test.opt")], []))
    assert outcome.ok
    result = outcome.output_value(["o"], "out")
    assert isinstance(result, ScalarValue) and result.value == 0.0


# --- pre-flight diagnostics ---------------------------------------------------------------------


def test_unknown_node_type_is_rejected_before_execution() -> None:
    log: list[tuple[tuple[str, ...], str]] = []
    document = synthetic_document([node("x", "test.nonexistent")], [])
    outcome = _evaluate(document, build_synthetic_catalog(log))
    assert not outcome.ok
    assert "unknown_node_type" in _codes(outcome)
    assert log == []  # nothing executed


def test_unavailable_version_is_rejected() -> None:
    from quantize.schema.nodes import RegisteredNode

    bad: NodeInstance = RegisteredNode(
        id="x", type_id="test.const", type_version="9.9.9", params={}
    )
    outcome = _evaluate(synthetic_document([bad], []))
    assert not outcome.ok
    assert "node_version_unavailable" in _codes(outcome)


def test_unconnected_required_input_is_rejected() -> None:
    nodes = [node("c", "test.const"), node("sb", "test.sub")]
    edges = [edge(("c", "out"), ("sb", "left"))]  # "right" left unconnected
    outcome = _evaluate(synthetic_document(nodes, edges))
    assert not outcome.ok
    assert "required_input_unconnected" in _codes(outcome)


def test_ambiguous_fan_in_is_rejected() -> None:
    nodes = [node("c1", "test.const"), node("c2", "test.const"), node("o", "test.opt")]
    edges = [edge(("c1", "out"), ("o", "opt")), edge(("c2", "out"), ("o", "opt"))]
    outcome = _evaluate(synthetic_document(nodes, edges))
    assert not outcome.ok
    assert "ambiguous_input" in _codes(outcome)


def test_structurally_invalid_document_is_refused_with_original_codes() -> None:
    nodes = [node("a", "test.opt"), node("b", "test.opt")]
    edges = [edge(("a", "out"), ("b", "opt")), edge(("b", "out"), ("a", "opt"))]  # a cycle
    outcome = _evaluate(synthetic_document(nodes, edges))
    assert not outcome.ok
    assert "graph_cycle" in _codes(outcome)


def test_missing_terminal_is_rejected() -> None:
    document = synthetic_document([node("c", "test.const")], [], with_terminal=False)
    outcome = _evaluate(document)
    assert not outcome.ok
    assert "missing_terminal_node" in _codes(outcome)


def test_multiple_terminals_are_rejected() -> None:
    nodes = [
        node("pt2", "test.targets", {"weights": {"SPY": 0.5}}),
        node("term2", "output.target_portfolio"),
    ]
    edges = [edge(("pt2", "targets"), ("term2", "targets"))]
    outcome = _evaluate(synthetic_document(nodes, edges))  # terminal tail adds the second
    assert not outcome.ok
    assert "multiple_terminal_nodes" in _codes(outcome)


def test_no_visible_session_is_rejected() -> None:
    before_any_close = datetime(2026, 1, 5, 12, 0, tzinfo=UTC)
    outcome = _evaluate(synthetic_document([], []), instant=before_any_close)
    assert not outcome.ok
    assert _codes(outcome) == ["no_visible_session"]


def test_naive_evaluation_instant_raises() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        _evaluate(synthetic_document([], []), instant=datetime(2026, 1, 6, 21, 0))


def test_non_uuid_run_id_raises() -> None:
    with pytest.raises(ValueError):
        evaluate_strategy(
            synthetic_document([], []),
            catalog=build_synthetic_catalog(),
            market_data=two_session_dataset(),
            run_id="not-a-uuid",
            evaluation_instant=EVAL_INSTANT,
        )


# --- execution failures --------------------------------------------------------------------------


def test_node_execution_failure_stops_the_run_with_identity() -> None:
    nodes = [node("c", "test.const"), node("zboom", "test.fail")]  # "c" evaluates first
    outcome = _evaluate(synthetic_document(nodes, []))
    assert not outcome.ok
    assert _codes(outcome) == ["node_execution_failed"]
    diagnostic = outcome.diagnostics[0]
    assert diagnostic.node_path == ("zboom",)
    assert "RuntimeError" in diagnostic.message
    # The run stopped, but already-computed outputs are preserved for inspection.
    assert (("c",), "out") in outcome.outputs
    assert outcome.targets is None


def test_wrong_output_port_set_is_a_structured_failure() -> None:
    outcome = _evaluate(synthetic_document([node("w", "test.wrong_ports")], []))
    assert not outcome.ok
    assert _codes(outcome) == ["wrong_output_ports"]
    assert outcome.diagnostics[0].node_path == ("w",)


def test_wrong_runtime_output_type_is_a_structured_failure() -> None:
    outcome = _evaluate(synthetic_document([node("w", "test.wrong_type")], []))
    assert not outcome.ok
    assert _codes(outcome) == ["wrong_output_type"]
    assert outcome.diagnostics[0].subject == "out"


# --- purity, mutation, determinism ---------------------------------------------------------------


def test_document_is_not_mutated_by_evaluation() -> None:
    nodes, edges = _diamond_nodes_edges()
    document = synthetic_document(nodes, edges)
    before = to_ir_dict(document)
    outcome = _evaluate(document)
    assert outcome.ok
    assert to_ir_dict(document) == before


def test_catalog_descriptors_are_not_mutated() -> None:
    catalog = build_synthetic_catalog()
    before = catalog.implementations()
    _evaluate(synthetic_document([], []), catalog)
    assert catalog.implementations() == before


def test_repeated_runs_are_identical() -> None:
    nodes = [node("t", "test.trace", {"events": ["t.first", "t.second"]})]
    document = synthetic_document(nodes, [])
    first = _evaluate(document)
    second = _evaluate(document)
    assert first.ok and second.ok
    assert first.targets == second.targets
    assert first.outputs == second.outputs
    assert first.trace == second.trace
    assert first.diagnostics == second.diagnostics


def test_no_state_leaks_between_runs_on_one_catalog() -> None:
    catalog = build_synthetic_catalog()
    doc_a = synthetic_document([node("c", "test.const", {"value": 1})], [])
    doc_b = synthetic_document([node("c", "test.const", {"value": 9})], [])
    _evaluate(doc_a, catalog)
    shared = _evaluate(doc_b, catalog)
    fresh = _evaluate(doc_b, build_synthetic_catalog())
    assert shared.outputs == fresh.outputs
    assert shared.trace == fresh.trace


# --- trace plumbing ------------------------------------------------------------------------------


def test_trace_events_are_ordered_and_stamped_deterministically() -> None:
    nodes = [node("t", "test.trace", {"events": ["t.first", "t.second"]})]
    outcome = _evaluate(synthetic_document(nodes, []))
    assert outcome.ok
    assert [event.event_type for event in outcome.trace] == ["t.first", "t.second"]
    for index, event in enumerate(outcome.trace):
        assert event.run_id == RUN_ID
        assert event.node_id == "t"
        assert event.component_path == ()
        assert event.timestamp == EVAL_INSTANT
        assert event.payload == {"index": index}


def test_targets_value_is_the_terminal_input() -> None:
    outcome = _evaluate(synthetic_document([], []))
    assert isinstance(outcome.targets, PortfolioTargetsValue)
    assert outcome.output_value(["ptsrc"], "targets") == outcome.targets


def test_output_type_guard_covers_the_whole_runtime_value_union() -> None:
    """The evaluator's isinstance guard is a hand-maintained mirror of the RuntimeValue
    union; a variant added to one but not the other would misclassify valid node output
    as wrong-type. This tripwire fails the moment they drift."""
    from typing import get_args

    from quantize.evaluator.evaluate import _RUNTIME_VALUE_TYPES
    from quantize.runtime.values import RuntimeValue

    assert set(_RUNTIME_VALUE_TYPES) == set(get_args(RuntimeValue))
