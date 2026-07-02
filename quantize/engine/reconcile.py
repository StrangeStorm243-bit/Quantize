"""Order reconciliation — the accepted ADR-0005 contract, implemented verbatim.

``reconcile(state, targets, prices)`` is a pure planning function (R1): given the settled
portfolio snapshot, the M3 terminal ``PortfolioTargets``, and the session-D close planning
prices, it returns the proposed ``OrderList`` plus the per-asset explanation table. It never
mutates its inputs, asserts nothing about fills (planning prices are NOT expected fill prices —
D3), and fails atomically when any held or targeted asset lacks a valid price (D8).

Key ADR anchors implemented here: pinned left-to-right canonical PV fold seeded with cash (D4);
asset set = held(qty>0) ∪ targeted(weight>0), zero-weight-unheld entries dropped at ingestion
(D5/D7); dust rule ``|Δq|·price > max(PV,1)·DUST_RATIO`` with the full-liquidation exemption
(D9/R6/R9); sells-first canonical output (D10/R10); mathematical target cash vs
post-emitted-orders projected cash, both reported (D7/R7).
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from quantize.engine.errors import (
    INVALID_RECONCILIATION_PRICE,
    MISSING_RECONCILIATION_PRICE,
)
from quantize.engine.orders import Order, OrderList
from quantize.engine.state import PortfolioState
from quantize.runtime.diagnostics import RuntimeDiagnostic, sort_runtime_diagnostics
from quantize.runtime.values import PortfolioTargetsValue

# The single centralized dust ratio (ADR-0005 D9) — deliberately the ratified WEIGHT_TOLERANCE.
DUST_RATIO = 1e-9


@dataclass(frozen=True)
class AssetPlan:
    """One explanation row (ADR-0005 D14): how an asset's delta was derived and what happened."""

    asset: str
    price: float
    current_quantity: float
    target_weight: float
    target_notional: float
    target_quantity: float
    delta_quantity: float
    action: Literal["buy", "sell", "hold", "dust"]


@dataclass(frozen=True)
class ReconciliationOutcome:
    """The structured result. ``ok=False`` ⇒ ``orders=()`` and the derived floats are ``None``."""

    ok: bool
    orders: OrderList
    diagnostics: tuple[RuntimeDiagnostic, ...]
    portfolio_value: float | None
    target_cash: float | None
    projected_cash: float | None
    plans: tuple[AssetPlan, ...]


def _valid_price(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(float(value))
        and float(value) > 0.0
    )


def reconcile(
    state: PortfolioState,
    targets: PortfolioTargetsValue,
    prices: Mapping[str, float],
) -> ReconciliationOutcome:
    """Plan the trades that move *state* to *targets* at the given planning prices."""
    # D5 ingestion: explicit zero-weight entries are identical to absence and are dropped.
    weights = {asset: weight for asset, weight in targets.weights if weight > 0.0}
    # D7: the reconciliation asset set, canonical.
    assets = tuple(sorted(set(state.held_assets) | set(weights)))

    # D8: atomic price validation over the whole set before any arithmetic.
    diagnostics: list[RuntimeDiagnostic] = []
    for asset in assets:
        price = prices.get(asset)
        if price is None:
            diagnostics.append(
                RuntimeDiagnostic(
                    MISSING_RECONCILIATION_PRICE,
                    f"no session-D close available for {asset!r} at the reconciliation instant",
                    subject=asset,
                )
            )
        elif not _valid_price(price):
            diagnostics.append(
                RuntimeDiagnostic(
                    INVALID_RECONCILIATION_PRICE,
                    f"close for {asset!r} is not a positive finite number: {price!r}",
                    subject=asset,
                )
            )
    if diagnostics:
        return ReconciliationOutcome(
            ok=False,
            orders=(),
            diagnostics=sort_runtime_diagnostics(diagnostics),
            portfolio_value=None,
            target_cash=None,
            projected_cash=None,
            plans=(),
        )

    # D4: PV — left-to-right fold over held assets in canonical order, seeded with settled cash.
    portfolio_value = state.cash
    for asset, quantity in state.positions:  # positions are canonical by construction
        portfolio_value += quantity * float(prices[asset])

    dust_threshold = max(portfolio_value, 1.0) * DUST_RATIO
    sells: list[Order] = []
    buys: list[Order] = []
    plans: list[AssetPlan] = []
    emitted_cash_flow = 0.0  # + for sells, − for buys, at planning prices

    for asset in assets:
        price = float(prices[asset])
        current = state.quantity_of(asset)
        weight = weights.get(asset, 0.0)
        if weight > 0.0:
            target_notional = weight * portfolio_value
            target_quantity = target_notional / price
        else:  # zero-target: exact liquidation arithmetic (no float residue)
            target_notional = 0.0
            target_quantity = 0.0
        delta = target_quantity - current
        if delta == 0.0:
            delta = 0.0  # canonicalize -0.0

        liquidation = weight == 0.0 and current > 0.0
        emit = liquidation or abs(delta) * price > dust_threshold  # D9 + R6 exemption

        action: Literal["buy", "sell", "hold", "dust"]
        if delta > 0.0 and emit:
            action = "buy"
            buys.append(Order(side="buy", asset=asset, quantity=delta))
            emitted_cash_flow -= delta * price
        elif delta < 0.0 and emit:
            action = "sell"
            quantity = min(-delta, current)  # defensive; equality is exact for liquidations
            sells.append(Order(side="sell", asset=asset, quantity=quantity))
            emitted_cash_flow += quantity * price
        elif delta != 0.0:
            action = "dust"
        else:
            action = "hold"
        plans.append(
            AssetPlan(
                asset=asset,
                price=price,
                current_quantity=current,
                target_weight=weight,
                target_notional=target_notional,
                target_quantity=target_quantity,
                delta_quantity=delta,
                action=action,
            )
        )

    total_weight = sum(weight for _, weight in sorted(weights.items()))
    return ReconciliationOutcome(
        ok=True,
        orders=(*sells, *buys),  # canonical within each side (assets iterated sorted)
        diagnostics=(),
        portfolio_value=portfolio_value,
        target_cash=(1.0 - total_weight) * portfolio_value,
        projected_cash=state.cash + emitted_cash_flow,
        plans=tuple(plans),
    )
