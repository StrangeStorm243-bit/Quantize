"""M4.8: reference strategies through the full engine over the deterministic fixture.

Hand-computable anchors: fixture closes are ``100·GROWTH**index`` and each session's open equals
the PREVIOUS session's close (``open_i = close_{i-1}``), so the D+1 fill price equals the D
planning price exactly — the bps cost drag is the only planning-vs-fill deviation.
"""

from __future__ import annotations

from datetime import date

import pytest

from quantize.engine.backtest import run_backtest
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.schema.document import StrategyDocument
from tests.golden_utils import assert_matches_golden, backtest_summary, golden_bytes
from tests.helpers import load_fixture
from tests.market_fixture import IWM_MISSING_DATE, build_market_fixture, fixture_close

RUN_ID = "99999999-9999-9999-9999-999999999999"
INITIAL_CASH = 1_000_000.0

_FIRST_A_EVALUATION = date(2025, 7, 31)  # first month-end with visible sessions > 126
_FIRST_A_FILL = date(2025, 8, 1)


@pytest.fixture(scope="module")
def market() -> MarketDataSet:
    return build_market_fixture()


def _load(name: str) -> StrategyDocument:
    return StrategyDocument.model_validate(load_fixture(name))


def _run(document: StrategyDocument, market: MarketDataSet) -> BacktestResult:
    return run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
    )


@pytest.fixture(scope="module")
def strategy_a_result(market: MarketDataSet) -> BacktestResult:
    return _run(_load("strategy_a"), market)


@pytest.fixture(scope="module")
def strategy_b_result(market: MarketDataSet) -> BacktestResult:
    return _run(_load("strategy_b"), market)


# --- Strategy A ----------------------------------------------------------------------------------


def test_strategy_a_completes_over_the_full_fixture(strategy_a_result: BacktestResult) -> None:
    result = strategy_a_result
    assert result.ok, result.diagnostics
    assert result.first_session == date(2025, 1, 2)
    assert result.last_session == date(2026, 6, 30)
    assert len(result.valuations) == 374  # every session valued


def test_strategy_a_warmup_gates_early_month_ends(strategy_a_result: BacktestResult) -> None:
    # Monthly firings Jan-Jun 2025 are warm-up-skipped (123 sessions by 06-30 <= 126);
    # the first real evaluation is the July 2025 month-end.
    warmup_days = [
        n.session_date for n in strategy_a_result.notes if n.code == "warmup_not_satisfied"
    ]
    assert warmup_days == [
        date(2025, 1, 31),
        date(2025, 2, 28),
        date(2025, 3, 31),
        date(2025, 4, 30),
        date(2025, 5, 30),  # Friday; 05-31 is a Saturday
        date(2025, 6, 30),
    ]
    assert strategy_a_result.evaluations[0].session_date == _FIRST_A_EVALUATION


def test_strategy_a_first_rebalance_hand_computed(strategy_a_result: BacktestResult) -> None:
    first = strategy_a_result.evaluations[0]
    # Top-3 by 126-session trailing return = growth ordering: QQQ > SPY > IWM (GLD is
    # warm-up-excluded at this instant but ranks below anyway). Equal weight 1/3 each.
    assert dict(first.target_weights) == {
        "IWM": pytest.approx(1 / 3),
        "QQQ": pytest.approx(1 / 3),
        "SPY": pytest.approx(1 / 3),
    }
    assert first.reconciliation.portfolio_value == INITIAL_CASH  # all cash at first evaluation
    assert first.fill_session == _FIRST_A_FILL

    # Order quantities: (PV/3) / close(2025-07-31); session index of 07-31 is 144.
    index = build_market_fixture().calendar.session_dates.index(_FIRST_A_EVALUATION)
    assert index == 144
    expected = {
        asset: (INITIAL_CASH / 3) / fixture_close(asset, index) for asset in ("IWM", "QQQ", "SPY")
    }
    orders = {o.asset: o for o in first.reconciliation.orders}
    assert all(o.side == "buy" for o in orders.values())
    for asset, quantity in expected.items():
        assert orders[asset].quantity == pytest.approx(quantity, rel=1e-12)

    # Fills at the 08-01 open == the 07-31 close (fixture identity). Canonical last buy (SPY)
    # is scaled by the 5 bps drag; IWM and QQQ fill in full.
    first_fills = {
        e.fill.asset: e.fill for e in strategy_a_result.fills if e.session_date == _FIRST_A_FILL
    }
    assert set(first_fills) == {"IWM", "QQQ", "SPY"}
    for asset in ("IWM", "QQQ"):
        assert first_fills[asset].price == pytest.approx(fixture_close(asset, index), rel=1e-12)
        assert first_fills[asset].quantity == pytest.approx(expected[asset], rel=1e-12)
        assert not first_fills[asset].scaled
    assert first_fills["SPY"].scaled
    assert first_fills["SPY"].quantity < expected["SPY"]
    # Cost drag: scaled SPY spend = remaining cash; total spend = full initial cash.
    total_spend = -sum(f.cash_delta for f in first_fills.values())
    assert total_spend == pytest.approx(INITIAL_CASH, abs=1e-6)


def test_strategy_a_holds_the_momentum_trio_throughout(
    strategy_a_result: BacktestResult,
) -> None:
    assert strategy_a_result.final_state.held_assets == ("IWM", "QQQ", "SPY")
    # The trio never changes (growth ordering is constant): every order after the first
    # rebalance is a small cost-drift correction, never a rotation.
    for record in strategy_a_result.evaluations[1:]:
        assert set(dict(record.target_weights)) == {"IWM", "QQQ", "SPY"}


def test_strategy_a_stale_mark_on_the_iwm_missing_session(
    strategy_a_result: BacktestResult,
) -> None:
    marks = [(m.session_date, m.asset, m.mark_date) for m in strategy_a_result.stale_marks]
    assert marks == [(IWM_MISSING_DATE, "IWM", date(2026, 5, 14))]
    # Valuation continuity: the 05-15 value used IWM's 05-14 close (documented carry),
    # and trading was untouched (no evaluation fired that day — A is monthly).
    assert IWM_MISSING_DATE not in {e.session_date for e in strategy_a_result.evaluations}


def test_strategy_a_metrics_are_hand_plausible(strategy_a_result: BacktestResult) -> None:
    values = [value for _, value in strategy_a_result.valuations]
    # Pre-first-trade the portfolio is pure cash: flat at exactly 1,000,000.
    assert values[0] == INITIAL_CASH
    index_first_fill = [d for d, _ in strategy_a_result.valuations].index(_FIRST_A_FILL)
    assert all(v == INITIAL_CASH for v in values[:index_first_fill])
    # After investment the trio grows every session (all growth factors > 1): the final value
    # exceeds cash-only, and drawdown reflects only the one-off 5 bps entry drag.
    assert strategy_a_result.total_return > 0.10  # trio compounds ~11 months
    assert -1e-3 < strategy_a_result.max_drawdown <= 0.0
    assert strategy_a_result.final_state.cash < 1.0  # fully invested (scaled residue ~0)


def test_strategy_a_no_next_session_note_at_coverage_end(
    strategy_a_result: BacktestResult,
) -> None:
    notes = [(n.session_date, n.code) for n in strategy_a_result.notes]
    assert (date(2026, 6, 30), "no_next_session") in notes  # June month-end cannot fill


def test_strategy_a_repeated_run_identical_and_golden(
    strategy_a_result: BacktestResult, market: MarketDataSet, update_goldens: bool
) -> None:
    again = _run(_load("strategy_a"), market)
    assert again == strategy_a_result  # full value-object equality, incl. trace
    assert golden_bytes(backtest_summary(again)) == golden_bytes(
        backtest_summary(strategy_a_result)
    )
    assert_matches_golden("strategy_a_backtest", strategy_a_result, update_goldens)


# --- Strategy B ----------------------------------------------------------------------------------


def test_strategy_b_sleeves_and_cash(strategy_b_result: BacktestResult) -> None:
    result = strategy_b_result
    assert result.ok, result.diagnostics
    # Rising AGG/EFA/SPY keep 0.25 sleeves; falling VNQ is masked to zero and never bought.
    assert result.final_state.held_assets == ("AGG", "EFA", "SPY")
    assert all(event.fill.asset != "VNQ" for event in result.fills)
    # Residual cash stays the intended ~25% of portfolio value (cost drag only).
    final_value = result.valuations[-1][1]
    cash_fraction = result.final_state.cash / final_value
    assert 0.24 < cash_fraction < 0.26
    # Sleeves are equal-valued within cost asymmetry at the final valuation.
    closes = {
        asset: dict(market_history)[result.valuations[-1][0]]
        for asset, market_history in (
            (
                a,
                build_market_fixture()
                .as_of(  # value each sleeve at the final session close
                    build_market_fixture().calendar.sessions[-1].close_at
                )
                .close_history(a),
            )
            for a in ("AGG", "EFA", "SPY")
        )
    }
    sleeve_values = [
        result.final_state.quantity_of(asset) * closes[asset] for asset in ("AGG", "EFA", "SPY")
    ]
    for value in sleeve_values:
        assert value == pytest.approx(0.25 * final_value, rel=2e-3)


def test_strategy_b_first_evaluation_after_200_session_warmup(
    strategy_b_result: BacktestResult,
) -> None:
    first = strategy_b_result.evaluations[0].session_date
    calendar = build_market_fixture().calendar
    index = calendar.session_dates.index(first)
    assert index + 1 > 200  # warm-up gate: visible sessions strictly exceed 200
    previous_friday_firings = [
        n.session_date for n in strategy_b_result.notes if n.code == "warmup_not_satisfied"
    ]
    assert previous_friday_firings  # weekly firings before warm-up were skipped, visibly
    assert max(previous_friday_firings) < first


def test_strategy_b_no_renormalization(strategy_b_result: BacktestResult) -> None:
    # Every evaluation's targets: three 0.25 sleeves + VNQ at 0.0 — never 1/3 each.
    for record in strategy_b_result.evaluations:
        weights = dict(record.target_weights)
        assert weights["AGG"] == weights["EFA"] == weights["SPY"] == 0.25
        assert weights.get("VNQ", 0.0) == 0.0


def test_strategy_b_repeated_run_identical(
    strategy_b_result: BacktestResult, market: MarketDataSet
) -> None:
    assert _run(_load("strategy_b"), market) == strategy_b_result
