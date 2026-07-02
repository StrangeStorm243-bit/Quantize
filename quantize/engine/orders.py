"""Engine-owned order and fill value objects (ADR-0005 D10; ARCHITECTURE §3).

``Order`` is a PROPOSAL: side + asset + positive fractional quantity, and deliberately NO price
(a price on the order would masquerade as an expected fill price — ADR-0005 R11). ``OrderList``
ordering is canonical presentation (sells ascending, then buys ascending), never execution
semantics. ``Fill`` is the executed record produced by the fill layer. None of these are graph
port types — ``OrderList`` never enters the strategy IR (R2).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Order:
    """One proposed trade: positive quantity; the side carries the sign."""

    side: Literal["buy", "sell"]
    asset: str
    quantity: float

    def __post_init__(self) -> None:
        if self.side not in ("buy", "sell"):
            raise ValueError(f"side must be 'buy' or 'sell', got {self.side!r}")
        if not isinstance(self.asset, str) or not self.asset:
            raise ValueError("asset must be a non-empty identifier")
        if (
            isinstance(self.quantity, bool)
            or not isinstance(self.quantity, (int, float))
            or not math.isfinite(float(self.quantity))
            or float(self.quantity) <= 0.0
        ):
            raise ValueError(f"quantity must be a finite number > 0, got {self.quantity!r}")
        object.__setattr__(self, "quantity", float(self.quantity))


OrderList = tuple[Order, ...]


@dataclass(frozen=True)
class Fill:
    """One executed (or scaled) order at the fill session's open.

    ``cash_delta`` is the signed cash movement including the bps cost (positive for sells,
    negative for buys). ``scaled=True`` marks a cash-floor-scaled buy; a buy scaled all the way
    to zero is still recorded (quantity 0.0) so the reason an order did not fire is visible.
    """

    side: Literal["buy", "sell"]
    asset: str
    quantity: float
    price: float
    cost: float
    cash_delta: float
    scaled: bool = False

    def __post_init__(self) -> None:
        for label, value in (
            ("quantity", self.quantity),
            ("price", self.price),
            ("cost", self.cost),
            ("cash_delta", self.cash_delta),
        ):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
            ):
                raise ValueError(f"{label} must be a finite number, got {value!r}")
        if self.quantity < 0.0 or self.price <= 0.0 or self.cost < 0.0:
            raise ValueError("fill quantity must be >= 0, price > 0, cost >= 0")
