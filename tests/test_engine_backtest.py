"""M4.7: engine orchestration — lifecycle, gates, failure paths, determinism, no mutation."""

from __future__ import annotations

from datetime import date

import pytest

from quantize.engine.backtest import run_backtest, run_window
from quantize.engine.metrics import max_drawdown, simple_returns, total_return
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import Edge, NodeInstance, RegisteredNode
from quantize.schema.serialization import to_ir_dict
from tests.engine_harness import RUN_ID, fixed_weight_strategy, make_document, make_engine_dataset

_D1, _D2, _D3, _D4 = (date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7), date(2026, 1, 8))


def _dataset() -> MarketDataSet:
    # Flat prices: open == close == constant, so accounting is trivially hand-checkable.
    days = {_D1: (10.0, 10.0), _D2: (10.0, 10.0), _D3: (10.0, 10.0), _D4: (10.0, 10.0)}
    return make_engine_dataset({"AAA": days, "BBB": days})


def _run(
    document: StrategyDocument,
    dataset: MarketDataSet | None = None,
    *,
    cash: float = 100.0,
    last_session: date | None = None,
) -> BacktestResult:
    return run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=dataset or _dataset(),
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=cash),
        last_session=last_session,
    )


# --- metrics (pure) ------------------------------------------------------------------------------


def test_metrics_hand_computed() -> None:
    values = [100.0, 110.0, 99.0, 105.6]
    assert simple_returns(values) == pytest.approx((0.10, -0.10, 1.0 / 15.0))
    assert total_return(values) == pytest.approx(0.056)
    assert max_drawdown(values) == pytest.approx(-0.10)  # 99/110 - 1
    assert max_drawdown([1.0, 2.0, 3.0]) == 0.0
    assert simple_returns([5.0]) == () and total_return([5.0]) == 0.0


def test_run_window_bounds() -> None:
    calendar = _dataset().calendar
    assert [s.session_date for s in run_window(calendar, _D2, _D3)] == [_D2, _D3]
    assert [s.session_date for s in run_window(calendar, None, None)] == [_D1, _D2, _D3, _D4]


# --- happy path ----------------------------------------------------------------------------------


def test_daily_lifecycle_hand_computed() -> None:
    """Equal-weight two assets, zero costs, flat 10.0 prices, 100 cash.

    D1 close: targets 0.5/0.5 -> orders buy 5 AAA, buy 5 BBB (PV=100).
    D2 open: fills at 10.0 -> positions 5/5, cash 0. Later evaluations: already at target.
    """
    result = _run(fixed_weight_strategy(["AAA", "BBB"]))
    assert result.ok, result.diagnostics
    assert result.final_state.as_dict() == {"AAA": pytest.approx(5.0), "BBB": pytest.approx(5.0)}
    assert result.final_state.cash == pytest.approx(0.0)
    assert [(e.session_date, e.fill.asset, e.fill.quantity) for e in result.fills] == [
        (_D2, "AAA", 5.0),
        (_D2, "BBB", 5.0),
    ]
    # Actual-fill instant recorded and equal to the scheduled fill instant (v0: the open).
    assert result.fills[0].actual_fill_instant == result.evaluations[0].scheduled_fill_instant
    # Valuation: flat prices -> 100 every session; no drawdown; zero returns.
    assert [value for _, value in result.valuations] == pytest.approx([100.0] * 4)
    assert result.total_return == pytest.approx(0.0)
    assert result.max_drawdown == pytest.approx(0.0)
    # D2/D3 evaluations are at-target (no orders); D4 evaluation hits no_next_session.
    assert [e.session_date for e in result.evaluations] == [_D1, _D2, _D3]
    assert all(e.reconciliation.orders == () for e in result.evaluations[1:])
    assert [(n.session_date, n.code) for n in result.notes] == [(_D4, "no_next_session")]
    # Order-creation/scheduled-fill instants recorded.
    first = result.evaluations[0]
    assert first.fill_session == _D2
    assert first.scheduled_fill_instant is not None
    assert first.evaluation_instant.hour == 21


def test_costs_scale_the_last_buy() -> None:
    # With 5 bps costs and full investment (w=0.5 x2), total buy cost = 100*1.0005 > 100 cash:
    # canonical last buy (BBB) is scaled; cash lands at exactly 0.
    result = _run(fixed_weight_strategy(["AAA", "BBB"], bps=5.0))
    assert result.ok
    # First fill event only (later sessions emit tiny cost-drift corrective fills).
    buys = {e.fill.asset: e.fill for e in result.fills if e.session_date == _D2}
    assert not buys["AAA"].scaled
    assert buys["BBB"].scaled
    assert buys["AAA"].quantity == pytest.approx(5.0)
    # BBB gets the remaining cash: 100 - 5*10*1.0005 = 49.975 -> qty = 49.975/(10*1.0005)
    assert buys["BBB"].quantity == pytest.approx(49.975 / 10.005)
    assert buys["BBB"].cash_delta == pytest.approx(-49.975)


def test_monthly_schedule_does_not_fire_mid_month() -> None:
    result = _run(fixed_weight_strategy(["AAA"], schedule="monthly"), last_session=_D3)
    assert result.ok
    assert result.evaluations == ()  # Jan 5-7 are not the last January session
    assert result.fills == ()
    assert result.final_state.cash == 100.0


# --- gates and notes -----------------------------------------------------------------------------


def test_warmup_gate_boundary() -> None:
    # trailing_return(lookback=2) -> warm-up 2: evaluations skipped while visible <= 2,
    # first fired at D3 (visible=3). Boundary pinned on both sides.
    nodes: list[NodeInstance] = [
        RegisteredNode(
            id="u",
            type_id="universe.fixed_list",
            type_version="1.0.0",
            params={"tickers": ["AAA", "BBB"]},
        ),
        RegisteredNode(id="px", type_id="data.price", type_version="1.0.0", params={}),
        RegisteredNode(
            id="ret",
            type_id="transform.trailing_return",
            type_version="1.0.0",
            params={"lookback_sessions": 2},
        ),
        RegisteredNode(id="rk", type_id="transform.rank", type_version="1.0.0", params={}),
        RegisteredNode(
            id="sel", type_id="portfolio.select_top_n", type_version="1.0.0", params={"n": 1}
        ),
        RegisteredNode(id="ew", type_id="portfolio.equal_weight", type_version="1.0.0", params={}),
        RegisteredNode(id="tp", type_id="output.target_portfolio", type_version="1.0.0", params={}),
    ]
    edges = [
        Edge.model_validate({"from": ("u", "assets"), "to": ("px", "assets")}),
        Edge.model_validate({"from": ("px", "series"), "to": ("ret", "series")}),
        Edge.model_validate({"from": ("ret", "values"), "to": ("rk", "values")}),
        Edge.model_validate({"from": ("rk", "values"), "to": ("sel", "scores")}),
        Edge.model_validate({"from": ("u", "assets"), "to": ("sel", "universe")}),
        Edge.model_validate({"from": ("sel", "assets"), "to": ("ew", "assets")}),
        Edge.model_validate({"from": ("ew", "targets"), "to": ("tp", "targets")}),
    ]
    document = make_document(nodes, edges, bps=0.0)
    result = _run(document)
    assert result.ok, result.diagnostics
    warmup_notes = [n for n in result.notes if n.code == "warmup_not_satisfied"]
    assert [n.session_date for n in warmup_notes] == [_D1, _D2]  # visible 1 and 2 <= 2
    assert [e.session_date for e in result.evaluations] == [_D3]  # first fired: visible 3 > 2


def _series_pipeline(head: list[NodeInstance], head_edges: list[Edge]) -> StrategyDocument:
    """u -> px -> <head chain> -> rank -> select_top_n(1) -> equal_weight -> terminal."""
    nodes: list[NodeInstance] = [
        RegisteredNode(
            id="u",
            type_id="universe.fixed_list",
            type_version="1.0.0",
            params={"tickers": ["AAA", "BBB"]},
        ),
        RegisteredNode(id="px", type_id="data.price", type_version="1.0.0", params={}),
        *head,
        RegisteredNode(id="rk", type_id="transform.rank", type_version="1.0.0", params={}),
        RegisteredNode(
            id="sel", type_id="portfolio.select_top_n", type_version="1.0.0", params={"n": 1}
        ),
        RegisteredNode(id="ew", type_id="portfolio.equal_weight", type_version="1.0.0", params={}),
        RegisteredNode(id="tp", type_id="output.target_portfolio", type_version="1.0.0", params={}),
    ]
    edges = [
        Edge.model_validate({"from": ("u", "assets"), "to": ("px", "assets")}),
        *head_edges,
        Edge.model_validate({"from": ("rk", "values"), "to": ("sel", "scores")}),
        Edge.model_validate({"from": ("u", "assets"), "to": ("sel", "universe")}),
        Edge.model_validate({"from": ("sel", "assets"), "to": ("ew", "assets")}),
        Edge.model_validate({"from": ("ew", "targets"), "to": ("tp", "targets")}),
    ]
    return make_document(nodes, edges, bps=0.0)


def _trending_dataset() -> MarketDataSet:
    # Distinct, hand-checkable closes: AAA trends up, BBB trends down.
    return make_engine_dataset(
        {
            "AAA": {_D1: (10.0, 10.0), _D2: (11.0, 11.0), _D3: (12.0, 12.0), _D4: (13.0, 13.0)},
            "BBB": {_D1: (20.0, 20.0), _D2: (19.0, 19.0), _D3: (18.0, 18.0), _D4: (17.0, 17.0)},
        }
    )


def test_moving_average_warmup_gate_exact_boundary() -> None:
    """Warm-up convention: declared = sessions required STRICTLY BEFORE the evaluation session.

    MA(window=3) declares warm-up 2, so the gate skips D1 (visible 1) and D2 (visible 2) and
    fires at D3 (visible 3) — the FIRST session with a full window, not one session later.
    Hand check at D3: MA3(AAA) = (10+11+12)/3 = 11, MA3(BBB) = (20+19+18)/3 = 19; descending
    rank picks BBB; equal weight -> BBB 1.0. All inputs are closes <= D3's close (no look-ahead).
    """
    head: list[NodeInstance] = [
        RegisteredNode(
            id="ma", type_id="transform.moving_average", type_version="1.0.0", params={"window": 3}
        ),
        RegisteredNode(id="lt", type_id="transform.latest", type_version="1.0.0", params={}),
    ]
    head_edges = [
        Edge.model_validate({"from": ("px", "series"), "to": ("ma", "series")}),
        Edge.model_validate({"from": ("ma", "series"), "to": ("lt", "series")}),
        Edge.model_validate({"from": ("lt", "values"), "to": ("rk", "values")}),
    ]
    result = _run(_series_pipeline(head, head_edges), _trending_dataset())
    assert result.ok, result.diagnostics
    warmup_notes = [n.session_date for n in result.notes if n.code == "warmup_not_satisfied"]
    assert warmup_notes == [_D1, _D2]  # one-before boundary: D2 (visible 2 <= 2) still skipped
    assert [e.session_date for e in result.evaluations] == [_D3]  # exactly-enough: visible 3 > 2
    first = result.evaluations[0]
    assert dict(first.target_weights) == {"BBB": 1.0}
    assert first.fill_session == _D4
    # One-after boundary: D4 fires the schedule past warm-up; only the window tail stops it.
    assert [(n.session_date, n.code) for n in result.notes if n.session_date == _D4] == [
        (_D4, "no_next_session")
    ]


def test_latest_only_strategy_evaluates_at_the_first_session() -> None:
    """transform.latest needs zero prior sessions: a latest-driven strategy is evaluable at the
    very first close (visible 1 > warm-up 0) — no warm-up note is ever emitted."""
    head: list[NodeInstance] = [
        RegisteredNode(id="lt", type_id="transform.latest", type_version="1.0.0", params={}),
    ]
    head_edges = [
        Edge.model_validate({"from": ("px", "series"), "to": ("lt", "series")}),
        Edge.model_validate({"from": ("lt", "values"), "to": ("rk", "values")}),
    ]
    result = _run(_series_pipeline(head, head_edges), _trending_dataset())
    assert result.ok, result.diagnostics
    assert [n for n in result.notes if n.code == "warmup_not_satisfied"] == []
    assert [e.session_date for e in result.evaluations] == [_D1, _D2, _D3]
    # D1 hand check: latest closes AAA 10 / BBB 20 -> descending rank picks BBB.
    assert dict(result.evaluations[0].target_weights) == {"BBB": 1.0}


def test_fill_outside_window_note() -> None:
    result = _run(fixed_weight_strategy(["AAA"]), last_session=_D2)
    assert result.ok
    # D1 evaluates (fill D2 inside window); D2's fill session (D3) is outside -> note, no eval.
    assert [e.session_date for e in result.evaluations] == [_D1]
    assert [(n.session_date, n.code) for n in result.notes] == [(_D2, "fill_outside_window")]
    # No orders were silently dropped: the only queued orders (from D1) filled at D2.
    assert {e.session_date for e in result.fills} == {_D2}


# --- failure paths --------------------------------------------------------------------------------


def test_evaluation_failure_is_structured_with_partial_artifacts() -> None:
    nodes: list[NodeInstance] = [
        RegisteredNode(id="x", type_id="test.nonexistent", type_version="1.0.0", params={})
    ]
    document = make_document(nodes, [])
    result = _run(document)
    assert not result.ok
    codes = [d.code for d in result.diagnostics]
    assert codes[0] == "evaluation_failed" and "unknown_node_type" in codes
    # Partial artifacts are internally consistent: D1's valuation landed before the failure.
    assert [day for day, _ in result.valuations] == [_D1]
    assert result.final_state.cash == 100.0  # last consistent transition = initial state
    # Structured, portable messages: no tracebacks, reprs, or machine paths.
    for diagnostic in result.diagnostics:
        assert "Traceback" not in diagnostic.message
        assert "C:\\" not in diagnostic.message and "0x" not in diagnostic.message


def test_reconciliation_failure_on_unpriced_targeted_asset() -> None:
    result = _run(fixed_weight_strategy(["AAA", "GHOST"]))  # GHOST has no data at all
    assert not result.ok
    codes = [d.code for d in result.diagnostics]
    assert codes[0] == "reconciliation_failed"
    assert "missing_reconciliation_price" in codes
    assert result.fills == ()  # atomic: nothing traded
    # The failing evaluation record is preserved for inspection.
    assert len(result.evaluations) == 1 and not result.evaluations[0].reconciliation.ok


def test_fill_failure_on_missing_next_open() -> None:
    bars = {
        "AAA": {_D1: (10.0, 10.0), _D2: (10.0, 10.0)},
        "BBB": {_D1: (10.0, 10.0)},  # no D2 observation: close exists D1, open missing D2
    }
    result = _run(fixed_weight_strategy(["AAA", "BBB"]), make_engine_dataset(bars))
    assert not result.ok
    assert [d.code for d in result.diagnostics] == ["missing_open_price"]
    assert result.diagnostics[0].subject == "BBB"
    assert result.final_state.cash == 100.0  # atomic: starting state preserved


def test_unsupported_transaction_costs_fail_the_run_up_front() -> None:
    # bps=20000 parses (the IR schema allows any non-negative finite bps) but is outside the
    # engine-supported range: the run fails before any session executes.
    result = _run(fixed_weight_strategy(["AAA"], bps=20_000.0))
    assert not result.ok
    assert [d.code for d in result.diagnostics] == ["invalid_transaction_costs"]
    assert result.valuations == () and result.fills == ()
    assert result.final_state.cash == 100.0


def test_missing_valuation_price_for_never_priced_holding() -> None:
    result = run_backtest(
        fixed_weight_strategy(["AAA"]),
        catalog=build_core_catalog(),
        market_data=_dataset(),
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=0.0, positions={"ZZZ": 1.0}),
    )
    assert not result.ok
    assert [d.code for d in result.diagnostics] == ["missing_valuation_price"]
    assert result.valuations == ()  # failed at the very first valuation


def test_stale_mark_valuation_carry() -> None:
    bars = {
        "AAA": {_D1: (10.0, 10.0), _D2: (10.0, 12.0), _D4: (14.0, 14.0)},  # D3 missing
        "BBB": {_D1: (1.0, 1.0), _D2: (1.0, 1.0), _D3: (1.0, 1.0), _D4: (1.0, 1.0)},
    }
    result = run_backtest(
        fixed_weight_strategy(["BBB"], schedule="monthly"),  # never trades: pure valuation run
        catalog=build_core_catalog(),
        market_data=make_engine_dataset(bars),
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=0.0, positions={"AAA": 2.0}),
    )
    assert result.ok
    values = dict(result.valuations)
    assert values[_D2] == pytest.approx(24.0)
    assert values[_D3] == pytest.approx(24.0)  # carried D2 close, recorded as stale
    assert values[_D4] == pytest.approx(28.0)
    assert [(m.session_date, m.asset, m.mark_date) for m in result.stale_marks] == [
        (_D3, "AAA", _D2)
    ]


def test_order_queue_is_empty_at_every_evaluation_instant() -> None:
    # ADR-0005 R16, asserted explicitly: every batch of queued orders fills at or before the
    # NEXT evaluation's session, so no evaluation ever runs against outstanding orders. With a
    # daily schedule and real trades this exercises the tightest case (fill at D+1 open, next
    # evaluation at D+1 close).
    result = _run(fixed_weight_strategy(["AAA", "BBB"], bps=5.0))
    assert result.ok
    fill_days = sorted({e.session_date for e in result.fills})
    evaluation_days = [e.session_date for e in result.evaluations]
    for previous, current in zip(evaluation_days, evaluation_days[1:], strict=False):
        queued = [e for e in result.evaluations if e.session_date == previous][0]
        if queued.reconciliation.orders:
            assert queued.fill_session is not None
            assert queued.fill_session <= current  # drained before the next evaluation
    # And every fill day corresponds to some evaluation's scheduled fill session.
    scheduled = {e.fill_session for e in result.evaluations if e.reconciliation.orders}
    assert set(fill_days) <= scheduled


# --- determinism / purity -------------------------------------------------------------------------


def test_repeated_runs_are_identical() -> None:
    document = fixed_weight_strategy(["AAA", "BBB"], bps=5.0)
    dataset = _dataset()
    first = _run(document, dataset)
    second = _run(document, dataset)
    assert first == second  # full value-object equality incl. trace and records


def test_engine_mutates_nothing() -> None:
    document = fixed_weight_strategy(["AAA", "BBB"], bps=5.0)
    dataset = _dataset()
    initial = PortfolioState.of(cash=100.0)
    before_doc = to_ir_dict(document)
    catalog = build_core_catalog()
    run_backtest(
        document,
        catalog=catalog,
        market_data=dataset,
        run_id=RUN_ID,
        initial_state=initial,
    )
    assert to_ir_dict(document) == before_doc
    assert initial == PortfolioState.of(cash=100.0)
    assert dataset == _dataset()
    # A fresh catalog produces the identical result: no state accumulated in the shared one.
    shared = run_backtest(
        document, catalog=catalog, market_data=dataset, run_id=RUN_ID, initial_state=initial
    )
    fresh = run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=dataset,
        run_id=RUN_ID,
        initial_state=initial,
    )
    assert shared == fresh
