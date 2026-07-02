"""M6: deterministic per-instant trace trees — identity, hierarchy, ordering, engine origin."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from quantize.components.resolve import ComponentCatalog
from quantize.evaluator.evaluate import evaluate_strategy
from quantize.schema.document import StrategyDocument
from quantize.tracing.events import TraceEvent
from quantize.tracing.tree import TraceTree, build_trace_trees
from tests.helpers import load_fixture
from tests.market_fixture import build_market_fixture

_RUN = "12121212-1212-1212-1212-121212121212"
_T1 = datetime(2026, 1, 5, 21, 0, tzinfo=UTC)
_T2 = datetime(2026, 1, 6, 14, 30, tzinfo=UTC)


def _event(
    node_id: str,
    event_type: str,
    path: tuple[str, ...] = (),
    timestamp: datetime = _T1,
) -> TraceEvent:
    return TraceEvent(
        run_id=_RUN,
        timestamp=timestamp,
        node_id=node_id,
        component_path=path,
        event_type=event_type,
        payload={"v": 1},
    )


def test_empty_stream_yields_no_trees() -> None:
    assert build_trace_trees(()) == ()


def test_identity_and_first_emission_sibling_order() -> None:
    events = [
        _event("b", "x.one"),
        _event("a", "x.two"),
        _event("b", "x.three"),  # merges into b's existing tree node
    ]
    (tree,) = build_trace_trees(events)
    assert tree.run_id == _RUN and tree.instant == _T1
    assert [root.node_id for root in tree.roots] == ["b", "a"]  # first emission, not sorted
    assert [e.event_type for e in tree.roots[0].events] == ["x.one", "x.three"]


def test_component_hierarchy_materializes_instance_nodes() -> None:
    events = [
        _event("inner", "x.deep", path=("outer_instance", "nested")),
        _event("top", "x.top"),
    ]
    (tree,) = build_trace_trees(events)
    # The instance chain exists even though the instances themselves emitted nothing.
    outer = tree.roots[0]
    assert outer.node_id == "outer_instance" and outer.events == ()
    nested = outer.children[0]
    assert nested.node_id == "nested" and nested.component_path == ("outer_instance",)
    leaf = nested.children[0]
    assert leaf.node_id == "inner" and leaf.component_path == ("outer_instance", "nested")
    assert [e.event_type for e in leaf.events] == ["x.deep"]
    assert tree.roots[1].node_id == "top"


def test_per_instant_grouping_ascending() -> None:
    events = [
        _event("n", "x.later", timestamp=_T2),
        _event("n", "x.earlier", timestamp=_T1),
    ]
    trees = build_trace_trees(events)
    assert [tree.instant for tree in trees] == [_T1, _T2]  # ascending, regardless of input


def test_engine_events_form_their_own_root_after_node_roots() -> None:
    events = [
        _event("engine", "engine.orders_proposed"),  # engine-origin (namespace)
        _event("engine", "x.user_event"),  # a USER node that happens to be named "engine"
        _event("a", "x.node_event"),
    ]
    (tree,) = build_trace_trees(events)
    assert [(root.node_id, root.origin) for root in tree.roots] == [
        ("engine", "node"),  # the user node keeps its identity
        ("a", "node"),
        ("engine", "engine"),  # the engine root sorts last (within-instant contract)
    ]
    assert [e.event_type for e in tree.roots[2].events] == ["engine.orders_proposed"]
    assert [e.event_type for e in tree.roots[0].events] == ["x.user_event"]


def test_multiple_runs_rejected() -> None:
    other = TraceEvent(
        run_id="34343434-3434-3434-3434-343434343434",
        timestamp=_T1,
        node_id="n",
        component_path=(),
        event_type="x.other",
        payload={"v": 1},
    )
    with pytest.raises(ValueError, match="multiple runs"):
        build_trace_trees([_event("n", "x.one"), other])


def test_rebuild_is_deterministic() -> None:
    events = [
        _event("b", "x.one"),
        _event("a", "x.two", path=("c",)),
        _event("engine", "engine.note"),
    ]
    assert build_trace_trees(events) == build_trace_trees(events)


# --- real nested-component tree (componentized Strategy A at the IWM-missing session) ------------


def _componentized_tree() -> TraceTree:
    from datetime import date

    from quantize.nodes import build_core_catalog
    from quantize.schema.components import ComponentDefinition

    market = build_market_fixture()
    document = StrategyDocument.model_validate(load_fixture("strategy_a_component"))
    components = ComponentCatalog(
        [ComponentDefinition.model_validate(load_fixture("component_momentum"))]
    )
    session = market.calendar.session_on(date(2026, 5, 15))
    assert session is not None
    outcome = evaluate_strategy(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=_RUN,
        evaluation_instant=session.close_at,
        components=components,
    )
    assert outcome.ok, outcome.diagnostics
    (tree,) = build_trace_trees(outcome.trace)
    return tree


def test_componentized_tree_golden(update_goldens: bool) -> None:
    from tests.golden_utils import assert_summary_matches_golden, trace_tree_summary

    tree = _componentized_tree()
    assert_summary_matches_golden(
        "trace_strategy_a_componentized", trace_tree_summary(tree), update_goldens
    )


def test_nested_component_tree_identity_and_events() -> None:
    tree = _componentized_tree()
    roots = {root.node_id: root for root in tree.roots}
    # The component instance "mom" is a root holding its internal nodes as children.
    mom = roots["mom"]
    assert mom.component_path == () and mom.events == ()
    children = {child.node_id: child for child in mom.children}
    assert set(children) == {"ret", "rk", "sel"}
    ret = children["ret"]
    assert ret.component_path == ("mom",)
    # The IWM missing-session exclusion lives INSIDE the component subtree, versioned.
    exclusions = [e.payload for e in ret.events if e.event_type == "transform.excluded"]
    assert {"v": 1, "asset": "IWM", "reason": "missing_current_close"} in exclusions
    # Top-level nodes are roots beside the instance; the terminal recorded the final targets.
    # ("cap" is absent: the 0.4 cap never binds at 1/3 weights, so it emits nothing — a node
    # appears in the tree only when it has facts to record.)
    assert {"u", "px", "ew", "tp"} <= set(roots)
    assert "cap" not in roots
    finalized = [e for e in roots["tp"].events if e.event_type == "targets.finalized"]
    assert len(finalized) == 1
    raw_weights = finalized[0].payload["weights"]
    assert isinstance(raw_weights, list)
    assert {pair[0] for pair in raw_weights if isinstance(pair, list)} == {
        "EFA",
        "QQQ",
        "SPY",
    }  # IWM excluded that session (M3 fact)
