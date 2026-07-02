"""Deterministic v0 fill application — the Broker(sim) adapter seam (ADR-0005 D11/R13).

Fills execute at the fill session's OPEN, read through the availability-gated as-of view taken
at that open instant (never raw dataset access). The ratified policy: sells apply before buys,
each side in canonical asset order; bps transaction costs apply at fill; settled cash never goes
negative — a buy exceeding remaining cash is scaled down deterministically (later buys bear the
shortfall), and a buy scaled to zero is still recorded so the reason an order did not fire is
visible.

Failure is atomic per fill event: all orders are validated (open prices present and valid, no
oversell, no duplicate side/asset) BEFORE any state arithmetic; a failed event returns the
starting state unchanged with structured diagnostics.
"""

from __future__ import annotations

import math
from datetime import date

from quantize.engine.errors import (
    INVALID_ORDER,
    INVALID_TRANSACTION_COSTS,
    MISSING_OPEN_PRICE,
)
from quantize.engine.orders import Fill, OrderList
from quantize.engine.state import PortfolioState
from quantize.market.data import DataView
from quantize.runtime.diagnostics import RuntimeDiagnostic, sort_runtime_diagnostics

# Oversell guard tolerance (float-noise allowance; a real oversell is a programming error
# upstream because reconciliation guarantees sell <= held).
_OVERSELL_TOLERANCE = 1e-9


def apply_orders(
    state: PortfolioState,
    orders: OrderList,
    view_at_open: DataView,
    fill_session: date,
    cost_bps: float,
) -> tuple[PortfolioState, tuple[Fill, ...], tuple[RuntimeDiagnostic, ...]]:
    """Apply *orders* at *fill_session*'s open. Returns (new_state, fills, diagnostics);
    diagnostics non-empty ⇒ the event failed atomically and ``new_state is state``."""
    # The persisted IR allows any non-negative finite bps; the engine's supported range is
    # [0, 10000): a cost factor >= 1 turns sell proceeds non-positive, which would breach the
    # R13 cash floor. Reject structurally, never by raising out of state arithmetic.
    if (
        isinstance(cost_bps, bool)
        or not isinstance(cost_bps, (int, float))
        or not math.isfinite(float(cost_bps))
        or cost_bps < 0.0
        or cost_bps >= 10_000.0
    ):
        return (
            state,
            (),
            (
                RuntimeDiagnostic(
                    INVALID_TRANSACTION_COSTS,
                    f"transaction cost of {cost_bps!r} bps is outside the engine-supported "
                    "range [0, 10000)",
                    subject="bps",
                ),
            ),
        )
    factor = cost_bps / 10_000.0
    diagnostics: list[RuntimeDiagnostic] = []

    # Atomic pre-validation: prices, duplicates, oversell — all against the STARTING state.
    prices: dict[str, float] = {}
    seen: set[tuple[str, str]] = set()
    for order in orders:
        key = (order.side, order.asset)
        if key in seen:
            diagnostics.append(
                RuntimeDiagnostic(
                    INVALID_ORDER,
                    f"duplicate {order.side} order for {order.asset!r}",
                    subject=order.asset,
                )
            )
        seen.add(key)
        price = view_at_open.open_price(order.asset, fill_session)
        if price is None:
            diagnostics.append(
                RuntimeDiagnostic(
                    MISSING_OPEN_PRICE,
                    f"no open price visible for {order.asset!r} at session "
                    f"{fill_session.isoformat()}",
                    subject=order.asset,
                )
            )
        else:
            prices[order.asset] = price  # dataset contract guarantees positive finite
        if order.side == "sell":
            held = state.quantity_of(order.asset)
            if order.quantity > held + _OVERSELL_TOLERANCE:
                diagnostics.append(
                    RuntimeDiagnostic(
                        INVALID_ORDER,
                        f"sell of {order.quantity!r} {order.asset!r} exceeds held {held!r}",
                        subject=order.asset,
                    )
                )
    if diagnostics:
        return state, (), sort_runtime_diagnostics(diagnostics)

    cash = state.cash
    positions = state.as_dict()
    fills: list[Fill] = []

    # Sells first (canonical), crediting proceeds net of costs.
    for order in sorted((o for o in orders if o.side == "sell"), key=lambda o: o.asset):
        price = prices[order.asset]
        held = positions.get(order.asset, 0.0)
        quantity = min(order.quantity, held)  # defensive clamp within tolerance
        gross = quantity * price
        cost = gross * factor
        delta = gross - cost
        cash += delta
        remaining = held - quantity
        if remaining <= 0.0 or quantity == held:
            positions.pop(order.asset, None)
        else:
            positions[order.asset] = remaining
        fills.append(
            Fill(
                side="sell",
                asset=order.asset,
                quantity=quantity,
                price=price,
                cost=cost,
                cash_delta=delta,
            )
        )

    # Buys second (canonical), against the cash floor; later buys bear any shortfall.
    clamp_tolerance = max(cash, 1.0) * 1e-9  # rounding-residue allowance (plan/ADR R13 guard)
    for order in sorted((o for o in orders if o.side == "buy"), key=lambda o: o.asset):
        price = prices[order.asset]
        unit_cost = price * (1.0 + factor)
        full_cost = order.quantity * unit_cost
        if full_cost <= cash:
            quantity = order.quantity
            scaled = False
        else:
            quantity = max(cash, 0.0) / unit_cost
            scaled = True
        spend = quantity * unit_cost
        cost = quantity * price * factor
        cash -= spend
        if cash < 0.0:
            if cash < -clamp_tolerance:  # not a rounding residue — a programming error
                raise ValueError(f"fill application drove cash negative: {cash!r}")
            cash = 0.0
        if quantity > 0.0:
            positions[order.asset] = positions.get(order.asset, 0.0) + quantity
        fills.append(
            Fill(
                side="buy",
                asset=order.asset,
                quantity=quantity,
                price=price,
                cost=cost,
                cash_delta=-spend,
                scaled=scaled,
            )
        )

    new_state = PortfolioState(cash=cash, positions=tuple(positions.items()))
    return new_state, tuple(fills), ()
