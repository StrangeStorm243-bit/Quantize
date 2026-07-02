"""M3: topological planning determinism and declared warm-up resolution."""

from __future__ import annotations

import pytest

from quantize.components.resolve import ComponentCatalog, resolve_strategy_components
from quantize.evaluator.plan import resolve_warmup, topological_order
from tests.runtime_fixtures import build_synthetic_catalog, edge, node, synthetic_document


def test_topological_order_respects_dependencies() -> None:
    nodes = [node("z", "test.const"), node("a", "test.split"), node("m", "test.opt")]
    edges = [edge(("z", "out"), ("a", "in")), edge(("a", "a"), ("m", "opt"))]
    order = topological_order(nodes, edges)
    assert order.index("z") < order.index("a") < order.index("m")


def test_topological_order_breaks_ties_by_node_id() -> None:
    nodes = [node("c", "test.const"), node("a", "test.const"), node("b", "test.const")]
    assert topological_order(nodes, []) == ("a", "b", "c")


def test_topological_order_is_stable_across_input_orderings() -> None:
    nodes = [node("c", "test.const"), node("sp", "test.split"), node("sb", "test.sub")]
    edges = [
        edge(("c", "out"), ("sp", "in")),
        edge(("sp", "a"), ("sb", "left")),
        edge(("sp", "b"), ("sb", "right")),
    ]
    forward = topological_order(nodes, edges)
    reversed_input = topological_order(list(reversed(nodes)), list(reversed(edges)))
    assert forward == reversed_input == ("c", "sp", "sb")


def test_parallel_edges_are_one_dependency() -> None:
    nodes = [node("sp", "test.split"), node("sb", "test.sub"), node("c", "test.const")]
    edges = [
        edge(("c", "out"), ("sp", "in")),
        edge(("sp", "a"), ("sb", "left")),
        edge(("sp", "b"), ("sb", "right")),  # second edge between the same node pair
    ]
    assert topological_order(nodes, edges) == ("c", "sp", "sb")


def test_cycle_raises_a_programming_error() -> None:
    nodes = [node("a", "test.opt"), node("b", "test.opt")]
    edges = [edge(("a", "out"), ("b", "opt")), edge(("b", "out"), ("a", "opt"))]
    with pytest.raises(ValueError, match="cycle"):
        topological_order(nodes, edges)


def test_duplicate_node_ids_raise() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        topological_order([node("a", "test.const"), node("a", "test.const")], [])


def test_unknown_edge_endpoint_raises() -> None:
    with pytest.raises(ValueError, match="unknown node"):
        topological_order([node("a", "test.const")], [edge(("a", "out"), ("ghost", "in"))])


def test_warmup_resolution_reads_declared_warmup_from_params() -> None:
    catalog = build_synthetic_catalog()
    document = synthetic_document(
        [node("w", "test.const", {"window": 7}), node("c", "test.const")], []
    )
    resolution = resolve_strategy_components(
        document, ComponentCatalog(), catalog.descriptor_registry
    )
    warmup = resolve_warmup(document, catalog, resolution)
    assert warmup.by_node[("w",)] == 7
    assert warmup.by_node[("c",)] == 0
    assert warmup.total == 7
