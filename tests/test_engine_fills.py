"""M4.6: deterministic fill application — accounting, sequencing, cash floor, atomic failure."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from quantize.engine.fills import apply_orders
from quantize.engine.orders import Order
from quantize.engine.state import PortfolioState
from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import DataView, MarketDataSet, PriceObservation

_DAY = date(2026, 1, 6)
_SESSION = MarketSession(
    session_date=_DAY,
    open_at=datetime(2026, 1, 6, 14, 30, tzinfo=UTC),
    close_at=datetime(2026, 1, 6, 21, 0, tzinfo=UTC),
)
_CAL = ExchangeCalendar(exchange="QSE", timezone="UTC-05:00", sessions=(_SESSION,))


def _view(opens: dict[str, float]) -> DataView:
    observations = {
        asset: [
            PriceObservation(
                session_date=_DAY,
                open_price=price,
                close_price=price,  # closes irrelevant to fills
                open_available_at=_SESSION.open_at,
                close_available_at=_SESSION.close_at,
            )
        ]
        for asset, price in opens.items()
    }
    return MarketDataSet(calendar=_CAL, observations=observations).as_of(_SESSION.open_at)


def test_sell_updates_position_and_cash_with_bps_cost() -> None:
    state = PortfolioState.of(cash=10.0, positions={"AAA": 5.0})
    view = _view({"AAA": 20.0})
    new_state, fills, diags = apply_orders(
        state, (Order(side="sell", asset="AAA", quantity=2.0),), view, _DAY, cost_bps=5.0
    )
    assert diags == ()
    # gross 40, cost 40*0.0005 = 0.02, proceeds 39.98
    assert new_state.cash == pytest.approx(49.98)
    assert new_state.quantity_of("AAA") == pytest.approx(3.0)
    assert fills[0].cost == pytest.approx(0.02)
    assert fills[0].cash_delta == pytest.approx(39.98)


def test_buy_updates_position_and_cash_with_bps_cost() -> None:
    state = PortfolioState.of(cash=100.0)
    view = _view({"BBB": 10.0})
    new_state, fills, diags = apply_orders(
        state, (Order(side="buy", asset="BBB", quantity=4.0),), view, _DAY, cost_bps=5.0
    )
    assert diags == ()
    # spend 4*10*1.0005 = 40.02
    assert new_state.cash == pytest.approx(59.98)
    assert new_state.quantity_of("BBB") == pytest.approx(4.0)
    assert not fills[0].scaled


def test_sells_fund_buys_within_one_event() -> None:
    # ADR Example F at the fill layer: zero starting cash, sell proceeds fund the buy.
    state = PortfolioState.of(cash=0.0, positions={"AAA": 10.0})
    view = _view({"AAA": 10.0, "BBB": 10.0})
    orders = (
        Order(side="sell", asset="AAA", quantity=10.0),
        Order(side="buy", asset="BBB", quantity=9.0),
    )
    new_state, fills, diags = apply_orders(state, orders, view, _DAY, cost_bps=0.0)
    assert diags == ()
    assert new_state.quantity_of("AAA") == 0.0
    assert new_state.quantity_of("BBB") == pytest.approx(9.0)
    assert new_state.cash == pytest.approx(10.0)
    assert [f.side for f in fills] == ["sell", "buy"]  # sells applied first


def test_insufficient_cash_scales_later_buys_deterministically() -> None:
    state = PortfolioState.of(cash=100.0)
    view = _view({"AAA": 10.0, "BBB": 10.0})
    orders = (
        Order(side="buy", asset="AAA", quantity=6.0),  # canonical first: fully funded (60)
        Order(side="buy", asset="BBB", quantity=6.0),  # only 40 remains -> scaled to 4
    )
    new_state, fills, diags = apply_orders(state, orders, view, _DAY, cost_bps=0.0)
    assert diags == ()
    assert new_state.quantity_of("AAA") == pytest.approx(6.0)
    assert new_state.quantity_of("BBB") == pytest.approx(4.0)
    assert new_state.cash == 0.0  # exactly zero after the clamp
    assert not fills[0].scaled and fills[1].scaled


def test_buy_scaled_to_zero_is_still_recorded() -> None:
    state = PortfolioState.of(cash=100.0)
    view = _view({"AAA": 10.0, "BBB": 10.0})
    orders = (
        Order(side="buy", asset="AAA", quantity=10.0),  # consumes all cash
        Order(side="buy", asset="BBB", quantity=1.0),  # scaled to zero
    )
    new_state, fills, diags = apply_orders(state, orders, view, _DAY, cost_bps=0.0)
    assert diags == ()
    assert new_state.quantity_of("BBB") == 0.0
    zero_fill = fills[1]
    assert zero_fill.asset == "BBB" and zero_fill.quantity == 0.0 and zero_fill.scaled
    assert new_state.cash == 0.0


def test_oversell_fails_atomically_before_any_state_change() -> None:
    state = PortfolioState.of(cash=0.0, positions={"AAA": 1.0})
    view = _view({"AAA": 10.0, "BBB": 10.0})
    orders = (
        Order(side="sell", asset="AAA", quantity=2.0),  # oversell
        Order(side="buy", asset="BBB", quantity=1.0),
    )
    new_state, fills, diags = apply_orders(state, orders, view, _DAY, cost_bps=0.0)
    assert new_state is state and fills == ()
    assert [d.code for d in diags] == ["invalid_order"]


def test_missing_open_fails_atomically() -> None:
    state = PortfolioState.of(cash=100.0, positions={"AAA": 1.0})
    view = _view({"AAA": 10.0})  # no BBB observation
    orders = (
        Order(side="sell", asset="AAA", quantity=1.0),
        Order(side="buy", asset="BBB", quantity=1.0),
    )
    new_state, fills, diags = apply_orders(state, orders, view, _DAY, cost_bps=0.0)
    assert new_state is state and fills == ()
    assert [d.code for d in diags] == ["missing_open_price"]
    assert diags[0].subject == "BBB"


def test_duplicate_side_asset_orders_rejected() -> None:
    state = PortfolioState.of(cash=100.0)
    view = _view({"AAA": 10.0})
    orders = (
        Order(side="buy", asset="AAA", quantity=1.0),
        Order(side="buy", asset="AAA", quantity=2.0),
    )
    _, _, diags = apply_orders(state, orders, view, _DAY, cost_bps=0.0)
    assert any(d.code == "invalid_order" for d in diags)


def test_full_liquidation_removes_the_position_exactly() -> None:
    state = PortfolioState.of(cash=0.0, positions={"AAA": 3.75})
    view = _view({"AAA": 20.0})
    new_state, _, diags = apply_orders(
        state, (Order(side="sell", asset="AAA", quantity=3.75),), view, _DAY, cost_bps=5.0
    )
    assert diags == ()
    assert new_state.positions == ()  # no residual dust position


def test_inputs_not_mutated_and_repeated_application_identical() -> None:
    state = PortfolioState.of(cash=100.0, positions={"AAA": 2.0})
    view = _view({"AAA": 10.0, "BBB": 10.0})
    orders = (
        Order(side="sell", asset="AAA", quantity=1.0),
        Order(side="buy", asset="BBB", quantity=3.0),
    )
    first = apply_orders(state, orders, view, _DAY, cost_bps=5.0)
    second = apply_orders(state, orders, view, _DAY, cost_bps=5.0)
    assert state == PortfolioState.of(cash=100.0, positions={"AAA": 2.0})
    assert first == second  # deterministic, no hidden state


def test_engine_unsupported_bps_fails_structured_not_raising() -> None:
    # Regression (Codex finding): a schema-valid bps >= 10000 makes the cost factor >= 1, so a
    # sell's proceeds would be non-positive and cash could go NEGATIVE — previously an unhandled
    # ValueError out of state construction. Now a structured atomic failure, state untouched.
    state = PortfolioState.of(cash=0.0, positions={"AAA": 1.0})
    view = _view({"AAA": 10.0})
    orders = (Order(side="sell", asset="AAA", quantity=1.0),)
    new_state, fills, diags = apply_orders(state, orders, view, _DAY, cost_bps=20_000.0)
    assert new_state is state and fills == ()
    assert [d.code for d in diags] == ["invalid_transaction_costs"]
    # Boundary: factor exactly 1 (bps == 10000) is also rejected; just below is accepted.
    _, _, at_bound = apply_orders(state, orders, view, _DAY, cost_bps=10_000.0)
    assert [d.code for d in at_bound] == ["invalid_transaction_costs"]
    _, _, below = apply_orders(state, orders, view, _DAY, cost_bps=9_999.0)
    assert below == ()


def test_cash_floor_clamp_boundary() -> None:
    # A scaling division whose replay overshoots cash by ~1 ULP: (0.1/5.5)*5.5 > 0.1 in float64.
    # The clamp band absorbs the residue and cash lands at exactly 0.0 (never negative, never a
    # PortfolioState construction error). The raise branch (a residue beyond the band) is
    # unreachable through the public API by the scaling algebra — defensive only.
    assert (0.1 / 5.5) * 5.5 > 0.1  # the ULP overshoot this test exists to exercise
    state = PortfolioState.of(cash=0.1)
    view = _view({"AAA": 5.5})
    new_state, fills, diags = apply_orders(
        state, (Order(side="buy", asset="AAA", quantity=1.0),), view, _DAY, cost_bps=0.0
    )
    assert diags == ()
    assert fills[0].scaled
    assert new_state.cash == 0.0  # clamped exactly, not a tiny negative


def test_oversell_tolerance_edge() -> None:
    held = 1.0
    state = PortfolioState.of(cash=0.0, positions={"AAA": held})
    view = _view({"AAA": 10.0})
    # Just inside the 1e-9 tolerance: accepted and clamped to the held quantity.
    ok_state, ok_fills, ok_diags = apply_orders(
        state,
        (Order(side="sell", asset="AAA", quantity=held + 5e-10),),
        view,
        _DAY,
        cost_bps=0.0,
    )
    assert ok_diags == ()
    assert ok_fills[0].quantity == held  # clamped
    assert ok_state.positions == ()
    # Just beyond the tolerance: rejected atomically.
    _, _, bad_diags = apply_orders(
        state,
        (Order(side="sell", asset="AAA", quantity=held + 2e-9),),
        view,
        _DAY,
        cost_bps=0.0,
    )
    assert [d.code for d in bad_diags] == ["invalid_order"]


def test_planning_vs_fill_price_drift_is_visible() -> None:
    # A synthetic open that genuinely differs from the planning close: a 1/3-weight order sized
    # at close 10 (qty 4) fills at open 12 and costs more cash than planned.
    state = PortfolioState.of(cash=120.0)
    view = _view({"AAA": 12.0})
    new_state, fills, diags = apply_orders(
        state, (Order(side="buy", asset="AAA", quantity=4.0),), view, _DAY, cost_bps=0.0
    )
    assert diags == ()
    assert fills[0].price == 12.0  # NOT the planning price
    assert new_state.cash == pytest.approx(120.0 - 48.0)
