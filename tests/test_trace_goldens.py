"""M6: trace goldens, tracing-on/off equivalence, validation sweep, reverse spec coverage."""

from __future__ import annotations

import dataclasses
from datetime import date

import pytest

from quantize.engine.backtest import run_backtest
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.nodes.data import PRICE
from quantize.nodes.logic import GREATER_THAN
from quantize.nodes.portfolio import EQUAL_WEIGHT, FIXED_WEIGHT, SELECT_TOP_N
from quantize.nodes.transform import LATEST, MOVING_AVERAGE, RANK, TRAILING_RETURN
from quantize.runtime.values import AssetSetValue, CrossSectionValue, TimeSeriesValue
from quantize.schema.document import StrategyDocument
from quantize.tracing.tree import TraceTree, build_trace_trees
from quantize.tracing.validate import collect_trace_specs, validate_trace
from tests.engine_harness import fixed_weight_strategy, make_engine_dataset
from tests.golden_utils import assert_summary_matches_golden, golden_bytes, trace_tree_summary
from tests.helpers import load_fixture
from tests.market_fixture import build_market_fixture
from tests.node_harness import business_days, invoke, make_view

RUN_ID = "99999999-9999-9999-9999-999999999999"
INITIAL_CASH = 1_000_000.0


@pytest.fixture(scope="module")
def market() -> MarketDataSet:
    return build_market_fixture()


def _load(name: str) -> StrategyDocument:
    return StrategyDocument.model_validate(load_fixture(name))


def _run(
    document: StrategyDocument, market: MarketDataSet, *, collect_trace: bool = True
) -> BacktestResult:
    return run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        collect_trace=collect_trace,
    )


@pytest.fixture(scope="module")
def strategy_a_result(market: MarketDataSet) -> BacktestResult:
    return _run(_load("strategy_a"), market)


@pytest.fixture(scope="module")
def strategy_b_result(market: MarketDataSet) -> BacktestResult:
    return _run(_load("strategy_b"), market)


def _tree_at(
    result: BacktestResult, market: MarketDataSet, day: date, *, at_open: bool
) -> TraceTree:
    session = market.calendar.session_on(day)
    assert session is not None
    instant = session.open_at if at_open else session.close_at
    trees = {tree.instant: tree for tree in build_trace_trees(result.trace)}
    return trees[instant]


# --- goldens -------------------------------------------------------------------------------------


def test_strategy_a_first_evaluation_tree_golden(
    strategy_a_result: BacktestResult, market: MarketDataSet, update_goldens: bool
) -> None:
    tree = _tree_at(strategy_a_result, market, date(2025, 7, 31), at_open=False)
    # Focused independent anchors alongside the byte comparison:
    roots = {root.node_id: root for root in tree.roots}
    finalized = [e for e in roots["tp"].events if e.event_type == "targets.finalized"][0]
    raw = finalized.payload["weights"]
    assert isinstance(raw, list)
    assert {pair[0]: pair[1] for pair in raw if isinstance(pair, list)} == {
        "IWM": pytest.approx(1 / 3),
        "QQQ": pytest.approx(1 / 3),
        "SPY": pytest.approx(1 / 3),
    }
    proposed = [e for e in roots["engine"].events if e.event_type == "engine.orders_proposed"][0]
    assert proposed.payload["portfolio_value"] == INITIAL_CASH
    assert len(proposed.payload["orders"]) == 3  # type: ignore[arg-type]
    assert tree.roots[-1].origin == "engine"  # engine root sorts last
    assert_summary_matches_golden(
        "trace_strategy_a_first_evaluation", trace_tree_summary(tree), update_goldens
    )


def test_strategy_a_first_fill_tree_golden(
    strategy_a_result: BacktestResult, market: MarketDataSet, update_goldens: bool
) -> None:
    tree = _tree_at(strategy_a_result, market, date(2025, 8, 1), at_open=True)
    assert [root.origin for root in tree.roots] == ["engine"]  # a pure fill-instant tree
    types = [e.event_type for e in tree.roots[0].events]
    assert types == ["engine.orders_filled", "engine.state_transition"]
    fills = tree.roots[0].events[0].payload["fills"]
    assert isinstance(fills, list)
    assert [row[1] for row in fills if isinstance(row, list)] == ["IWM", "QQQ", "SPY"]
    spy_row = fills[2]
    assert isinstance(spy_row, list) and spy_row[6] is True  # SPY scaled by the cost drag
    assert_summary_matches_golden(
        "trace_strategy_a_first_fill", trace_tree_summary(tree), update_goldens
    )


def test_strategy_b_first_evaluation_tree_golden(
    strategy_b_result: BacktestResult, market: MarketDataSet, update_goldens: bool
) -> None:
    tree = _tree_at(strategy_b_result, market, date(2025, 10, 24), at_open=False)
    roots = {root.node_id: root for root in tree.roots}
    evaluated = [e for e in roots["gt"].events if e.event_type == "logic.evaluated"][0]
    assert evaluated.payload == {
        "v": 1,
        "passed": ["AGG", "EFA", "SPY"],
        "failed": ["VNQ"],  # genuinely false — NOT missing
        "defaulted_missing": [],
    }
    masked = [e for e in roots["mask"].events if e.event_type == "portfolio.mask_applied"][0]
    assert masked.payload == {"v": 1, "kept": ["AGG", "EFA", "SPY"], "zeroed": ["VNQ"]}
    assert_summary_matches_golden(
        "trace_strategy_b_first_evaluation", trace_tree_summary(tree), update_goldens
    )


def test_trace_golden_bytes_are_stable_across_runs(
    strategy_a_result: BacktestResult, market: MarketDataSet
) -> None:
    again = _run(_load("strategy_a"), market)
    tree_a = _tree_at(strategy_a_result, market, date(2025, 7, 31), at_open=False)
    tree_b = _tree_at(again, market, date(2025, 7, 31), at_open=False)
    assert golden_bytes(trace_tree_summary(tree_a)) == golden_bytes(trace_tree_summary(tree_b))


# --- tracing-on/off equivalence -------------------------------------------------------------------


def test_tracing_disabled_changes_nothing_but_the_trace(
    strategy_a_result: BacktestResult, market: MarketDataSet
) -> None:
    untraced = _run(_load("strategy_a"), market, collect_trace=False)
    assert untraced.trace == ()
    assert strategy_a_result.trace != ()
    # Identical in every other field: targets, orders, fills, state, notes, diagnostics, metrics.
    assert dataclasses.replace(strategy_a_result, trace=()) == untraced


def test_tracing_switch_at_the_evaluator_level(market: MarketDataSet) -> None:
    from quantize.evaluator.evaluate import evaluate_strategy

    session = market.calendar.session_on(date(2026, 6, 1))
    assert session is not None
    on = evaluate_strategy(
        _load("strategy_a"),
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        evaluation_instant=session.close_at,
    )
    off = evaluate_strategy(
        _load("strategy_a"),
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        evaluation_instant=session.close_at,
        collect_trace=False,
    )
    assert off.trace == () and on.trace != ()
    assert on.targets == off.targets
    assert on.outputs == off.outputs
    assert on.diagnostics == off.diagnostics


# --- validation sweep + reverse coverage ---------------------------------------------------------


def _unit_scenario_events() -> list[tuple[str, object]]:
    """Targeted invocations exercising the rare declared events the reference runs never hit."""
    days = business_days(3)
    view = make_view(days, {"AAA": {days[0]: 10.0, days[1]: 10.0, days[2]: 10.0}})
    collected: list[tuple[str, object]] = []

    def run(implementation: object, **kwargs: object) -> None:
        _, events = invoke(implementation, view=view, **kwargs)  # type: ignore[arg-type]
        collected.extend(events)

    run(PRICE, inputs={"assets": AssetSetValue.of(["AAA", "GHOST"])})  # data.missing_asset
    run(EQUAL_WEIGHT, inputs={"assets": AssetSetValue.of([])})  # portfolio.empty_selection
    run(
        FIXED_WEIGHT,
        params={"weight_per_asset": "equal"},
        inputs={"assets": AssetSetValue.of([])},
    )  # portfolio.empty_universe
    run(
        GREATER_THAN,
        inputs={
            "left": CrossSectionValue.numbers(["AAA"], {}),
            "right": CrossSectionValue.numbers(["AAA"], {"AAA": 1.0}),
        },
    )  # logic.missing_operand
    run(
        RANK,
        inputs={"values": CrossSectionValue.numbers(["AAA", "BBB"], {"AAA": 1.0, "BBB": 1.0})},
    )  # rank.tie_broken
    run(
        SELECT_TOP_N,
        params={"n": 1},
        inputs={
            "scores": CrossSectionValue.numbers(["AAA", "BBB"], {"AAA": 1.0, "BBB": 2.0}),
            "universe": AssetSetValue.of(["AAA", "BBB", "CCC"]),
        },
    )  # select.selected with unselected + select.excluded (CCC unscored)
    run(
        MOVING_AVERAGE,
        params={"window": 99},
        inputs={"series": TimeSeriesValue.of({"AAA": [(days[0], 10.0)]})},
    )  # transform.excluded warmup_unmet
    run(LATEST, inputs={"series": TimeSeriesValue.of({"AAA": []})})  # missing_current_observation
    run(
        TRAILING_RETURN,
        params={"lookback_sessions": 1},
        inputs={"series": TimeSeriesValue.of({"AAA": [(days[1], 10.0), (days[2], 10.0)]})},
    )  # transform.computed
    return collected


def test_validation_sweep_and_reverse_coverage(
    strategy_a_result: BacktestResult, strategy_b_result: BacktestResult
) -> None:
    catalog = build_core_catalog()
    specs = collect_trace_specs(catalog)

    # Sweep: every event of both full reference runs conforms to its declared contract.
    for result in (strategy_a_result, strategy_b_result):
        violations = validate_trace(result.trace, specs)
        assert violations == (), violations[:5]

    # Rare-path scenarios: fill_outside_window note + cap event via a windowed capped run.
    windowed = _run_windowed_cap_scenario()
    assert validate_trace(windowed.trace, specs) == ()

    exercised = {event.event_type for event in strategy_a_result.trace}
    exercised |= {event.event_type for event in strategy_b_result.trace}
    exercised |= {event.event_type for event in windowed.trace}
    for event_type, payload in _unit_scenario_events():
        exercised.add(event_type)
        spec = specs[event_type]  # every unit-scenario event must be declared
        assert spec.payload_schema.errors(payload) == (), (event_type, payload)

    # REVERSE coverage: every declared contract is exercised somewhere in the suite battery —
    # a declared-but-dead spec fails loudly here.
    declared = set(specs)
    assert exercised >= declared, sorted(declared - exercised)


def _run_windowed_cap_scenario() -> BacktestResult:
    """Top-2 momentum under a binding cap, window-truncated: exercises risk.cap_applied,
    engine.note (warmup + fill_outside_window + no_next_session come from A/B runs too)."""
    from quantize.schema.nodes import Edge, NodeInstance, RegisteredNode
    from tests.engine_harness import make_document

    nodes: list[NodeInstance] = [
        RegisteredNode(
            id="u",
            type_id="universe.fixed_list",
            type_version="1.0.0",
            params={"tickers": ["EFA", "QQQ", "SPY"]},
        ),
        RegisteredNode(id="px", type_id="data.price", type_version="1.0.0", params={}),
        RegisteredNode(
            id="ret",
            type_id="transform.trailing_return",
            type_version="1.0.0",
            params={"lookback_sessions": 126},
        ),
        RegisteredNode(id="rk", type_id="transform.rank", type_version="1.0.0", params={}),
        RegisteredNode(
            id="sel", type_id="portfolio.select_top_n", type_version="1.0.0", params={"n": 2}
        ),
        RegisteredNode(id="ew", type_id="portfolio.equal_weight", type_version="1.0.0", params={}),
        RegisteredNode(
            id="cap", type_id="risk.max_weight", type_version="1.0.0", params={"max": 0.4}
        ),
        RegisteredNode(id="tp", type_id="output.target_portfolio", type_version="1.0.0", params={}),
    ]
    edges = [
        Edge.model_validate({"from": ("u", "assets"), "to": ("px", "assets")}),
        Edge.model_validate({"from": ("px", "series"), "to": ("ret", "series")}),
        Edge.model_validate({"from": ("ret", "values"), "to": ("rk", "values")}),
        Edge.model_validate({"from": ("rk", "values"), "to": ("sel", "scores")}),
        Edge.model_validate({"from": ("u", "assets"), "to": ("sel", "universe")}),
        Edge.model_validate({"from": ("sel", "assets"), "to": ("ew", "assets")}),
        Edge.model_validate({"from": ("ew", "targets"), "to": ("cap", "targets")}),
        Edge.model_validate({"from": ("cap", "targets"), "to": ("tp", "targets")}),
    ]
    document = make_document(nodes, edges, schedule="monthly", bps=5.0)
    return run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=build_market_fixture(),
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        first_session=date(2025, 7, 31),
        last_session=date(2025, 8, 31),
    )


def test_hold_omissions_are_traced_in_a_flat_at_target_run(
    strategy_a_result: BacktestResult,
) -> None:
    # Strategy A's cost drift produces REAL corrective orders each month (omitted stays empty
    # there — asserted), so the planning-layer "order did not fire" facts are exercised where
    # they truly occur: a flat-price zero-cost run whose later evaluations are exactly at
    # target -> every asset appears as an omitted "hold" row with delta 0.
    proposals = [e for e in strategy_a_result.trace if e.event_type == "engine.orders_proposed"]
    assert len(proposals) == 11  # one per evaluation

    flat = run_backtest(
        fixed_weight_strategy(["AAA", "BBB"]),
        catalog=build_core_catalog(),
        market_data=make_engine_dataset(
            {
                "AAA": {
                    date(2026, 1, 5): (10.0, 10.0),
                    date(2026, 1, 6): (10.0, 10.0),
                    date(2026, 1, 7): (10.0, 10.0),
                },
                "BBB": {
                    date(2026, 1, 5): (10.0, 10.0),
                    date(2026, 1, 6): (10.0, 10.0),
                    date(2026, 1, 7): (10.0, 10.0),
                },
            }
        ),
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=100.0),
    )
    proposals = [e for e in flat.trace if e.event_type == "engine.orders_proposed"]
    at_target = proposals[1]  # D2 evaluation: portfolio already exactly at target
    assert at_target.payload["orders"] == []
    assert at_target.payload["omitted"] == [["AAA", "hold", 0.0], ["BBB", "hold", 0.0]]


def test_fixed_weight_strategy_weighted_events(market: MarketDataSet) -> None:
    # portfolio.weighted from fixed_weight (B) and equal_weight (A) are both exercised; pin one
    # hand literal here for the fixed_weight path over a tiny window.
    result = run_backtest(
        fixed_weight_strategy(["AAA"]),
        catalog=build_core_catalog(),
        market_data=make_engine_dataset(
            {"AAA": {date(2026, 1, 5): (10.0, 10.0), date(2026, 1, 6): (10.0, 10.0)}}
        ),
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=100.0),
    )
    weighted = [e for e in result.trace if e.event_type == "portfolio.weighted"]
    assert weighted[0].payload == {"v": 1, "weights": [["AAA", 1.0]], "cash": 0.0}
