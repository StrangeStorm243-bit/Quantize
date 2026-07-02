"""M4.4: PortfolioState / Order / Fill value-object contracts."""

from __future__ import annotations

import dataclasses

import pytest

from quantize.engine.orders import Fill, Order
from quantize.engine.state import PortfolioState, union_assets

# --- PortfolioState ------------------------------------------------------------------------------


def test_valid_empty_portfolio() -> None:
    state = PortfolioState.of(cash=0.0)
    assert state.cash == 0.0 and state.positions == ()


def test_valid_holdings_and_cash_canonical_order() -> None:
    state = PortfolioState.of(cash=100.0, positions={"SPY": 2.0, "AGG": 1.0})
    assert state.positions == (("AGG", 1.0), ("SPY", 2.0))
    assert state.quantity_of("SPY") == 2.0
    assert state.quantity_of("GHOST") == 0.0
    assert state.held_assets == ("AGG", "SPY")


def test_zero_quantity_positions_canonicalized_away() -> None:
    state = PortfolioState.of(cash=1.0, positions={"SPY": 0.0, "AGG": 1.0})
    assert state.positions == (("AGG", 1.0),)


@pytest.mark.parametrize("cash", [-0.01, float("nan"), float("inf"), True])
def test_invalid_cash_rejected(cash: float) -> None:
    with pytest.raises(ValueError):
        PortfolioState.of(cash=cash)


@pytest.mark.parametrize("quantity", [-1.0, float("nan"), float("inf"), True])
def test_invalid_quantity_rejected(quantity: float) -> None:
    with pytest.raises(ValueError):
        PortfolioState.of(cash=0.0, positions={"SPY": quantity})


def test_duplicate_position_rejected() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        PortfolioState(cash=0.0, positions=(("SPY", 1.0), ("SPY", 2.0)))


def test_state_is_frozen() -> None:
    state = PortfolioState.of(cash=1.0)
    with pytest.raises(dataclasses.FrozenInstanceError):
        state.cash = 2.0  # type: ignore[misc]


def test_union_assets_is_canonical() -> None:
    state = PortfolioState.of(cash=0.0, positions={"SPY": 1.0})
    assert union_assets(state, ["AGG", "QQQ"]) == ("AGG", "QQQ", "SPY")


# --- Order / Fill --------------------------------------------------------------------------------


def test_order_requires_positive_quantity_and_valid_side() -> None:
    Order(side="buy", asset="SPY", quantity=1.5)
    with pytest.raises(ValueError):
        Order(side="buy", asset="SPY", quantity=0.0)
    with pytest.raises(ValueError):
        Order(side="buy", asset="SPY", quantity=float("nan"))
    with pytest.raises(ValueError):
        Order(side="hold", asset="SPY", quantity=1.0)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        Order(side="buy", asset="", quantity=1.0)


def test_order_has_no_price_field() -> None:
    order = Order(side="sell", asset="SPY", quantity=1.0)
    assert not hasattr(order, "price")  # ADR-0005 R11


def test_fill_permits_zero_quantity_scaled_record() -> None:
    fill = Fill(
        side="buy", asset="SPY", quantity=0.0, price=10.0, cost=0.0, cash_delta=0.0, scaled=True
    )
    assert fill.scaled and fill.quantity == 0.0


def test_fill_rejects_invalid_numbers() -> None:
    with pytest.raises(ValueError):
        Fill(side="buy", asset="SPY", quantity=-1.0, price=10.0, cost=0.0, cash_delta=0.0)
    with pytest.raises(ValueError):
        Fill(side="buy", asset="SPY", quantity=1.0, price=0.0, cost=0.0, cash_delta=0.0)
    with pytest.raises(ValueError):
        Fill(
            side="buy",
            asset="SPY",
            quantity=1.0,
            price=float("nan"),
            cost=0.0,
            cash_delta=0.0,
        )
