"""M5: ``risk.max_weight`` overflow exercised through the FULL engine (MVP_PLAN §M5).

Strategy A's 0.4 cap never binds (1/3 < 0.4). This scenario makes the cap genuinely overflow:
top-2 momentum equal-weighted gives {QQQ: 0.5, SPY: 0.5}; the 0.4 cap caps BOTH simultaneously,
no eligible receiver has capacity, and the unresolved 0.2 stays in cash — the ratified waterfall's
rule 4/5 end-to-end, with the ``risk.cap_applied`` trace event observable in the run record.

(With the v0 node set every portfolio constructor emits EQUAL weights, so the in-graph overflow
form is always all-capped-at-once; the unequal-weight proportional waterfall remains unit-level
coverage in ``test_nodes_risk.py`` — see the M5 plan.)
"""

from __future__ import annotations

from datetime import date

import pytest

from quantize.engine.backtest import run_backtest
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.nodes import build_core_catalog
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import Edge, NodeInstance, RegisteredNode
from tests.engine_harness import RUN_ID, make_document
from tests.market_fixture import build_market_fixture, fixture_close

INITIAL_CASH = 1_000_000.0
_EVAL_DAY = date(2025, 7, 31)  # month-end; 145 sessions visible > 126 warm-up
_FILL_DAY = date(2025, 8, 1)
_EVAL_INDEX = 144


def _capped_momentum_strategy() -> StrategyDocument:
    """u -> px -> ret(126) -> rk -> sel(n=2) -> ew -> cap(0.4) -> tp, monthly, 5 bps."""
    nodes: list[NodeInstance] = [
        RegisteredNode(
            id="u",
            type_id="universe.fixed_list",
            type_version="1.0.0",
            params={"tickers": ["EFA", "GLD", "IWM", "QQQ", "SPY", "TLT"]},
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
    return make_document(nodes, edges, schedule="monthly", bps=5.0)


@pytest.fixture(scope="module")
def result() -> BacktestResult:
    return run_backtest(
        _capped_momentum_strategy(),
        catalog=build_core_catalog(),
        market_data=build_market_fixture(),
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        first_session=_EVAL_DAY,
        last_session=date(2025, 8, 31),
    )


def test_cap_overflow_targets_and_cash_remainder(result: BacktestResult) -> None:
    assert result.ok, result.diagnostics
    first = result.evaluations[0]
    assert first.session_date == _EVAL_DAY
    # Top-2 momentum = QQQ, SPY; equal weight 0.5 each; BOTH exceed the 0.4 cap; no uncapped
    # asset has capacity, so the excess 0.2 stays in cash (waterfall rules 4/5) — the cap is
    # never violated to force full investment.
    assert dict(first.target_weights) == {"QQQ": 0.4, "SPY": 0.4}
    assert first.reconciliation.portfolio_value == INITIAL_CASH
    assert first.reconciliation.target_cash == pytest.approx(0.2 * INITIAL_CASH)


def test_cap_applied_trace_event_reaches_the_run_record(result: BacktestResult) -> None:
    events = [e for e in result.trace if e.event_type == "risk.cap_applied"]
    assert events, "the cap node's redistribution trace event must surface in the run record"
    payload = events[0].payload
    assert payload["capped_assets"] == ["QQQ", "SPY"]
    assert payload["iterations"] == 1
    assert payload["left_in_cash"] == pytest.approx(0.2)
    assert events[0].node_id == "cap"


def test_cap_overflow_orders_fills_and_ending_state_hand_computed(
    result: BacktestResult,
) -> None:
    first = result.evaluations[0]
    expected_quantities = {
        asset: (0.4 * INITIAL_CASH) / fixture_close(asset, _EVAL_INDEX) for asset in ("QQQ", "SPY")
    }
    orders = {o.asset: o for o in first.reconciliation.orders}
    assert set(orders) == {"QQQ", "SPY"}
    for asset, quantity in expected_quantities.items():
        assert orders[asset].quantity == pytest.approx(quantity, rel=1e-12)

    fills = [e for e in result.fills if e.session_date == _FILL_DAY]
    assert [e.fill.asset for e in fills] == ["QQQ", "SPY"]
    # Fill price = the 08-01 open = the 07-31 close (fixture identity); total cost
    # 800,000 x 1.0005 = 800,400 < 1,000,000, so nothing scales; cash lands at 199,600.
    for event in fills:
        assert event.fill.price == pytest.approx(
            fixture_close(event.fill.asset, _EVAL_INDEX), rel=1e-12
        )
        assert not event.fill.scaled
    total_spend = -sum(e.fill.cash_delta for e in fills)
    assert total_spend == pytest.approx(800_400.0, abs=1e-6)

    # Ending state: the two capped positions plus the deliberate cash remainder.
    final = result.final_state
    assert final.held_assets == ("QQQ", "SPY")
    # The August month-end firing (2025-08-29) is suppressed: its fill session (2025-09-02;
    # 09-01 is a fixture holiday) falls outside the window — so the July rebalance is also the
    # run's last trade, and exactly one evaluation record exists.
    assert len(result.evaluations) == 1
    assert [(n.session_date, n.code) for n in result.notes] == [
        (date(2025, 8, 29), "fill_outside_window")
    ]
    for asset, quantity in expected_quantities.items():
        assert final.quantity_of(asset) == pytest.approx(quantity, rel=1e-12)
    assert final.cash == pytest.approx(199_600.0, abs=1e-6)


def test_cap_overflow_repeated_run_identical(result: BacktestResult) -> None:
    again = run_backtest(
        _capped_momentum_strategy(),
        catalog=build_core_catalog(),
        market_data=build_market_fixture(),
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        first_session=_EVAL_DAY,
        last_session=date(2025, 8, 31),
    )
    assert again == result
