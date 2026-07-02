"""The frozen v0 portfolio state (ADR-0005 D1/D2).

Settled, single-currency, long-only, unlevered: finite cash >= 0 plus canonical-ordered positive
finite quantities. Zero-quantity entries are canonicalized away; transitions produce NEW
instances — engine code never mutates a caller's state.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass


def _finite_nonnegative(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number, got {type(value).__name__}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite")
    if number < 0.0:
        raise ValueError(f"{label} must be >= 0, got {number!r}")
    return number


@dataclass(frozen=True)
class PortfolioState:
    """Settled cash + long positions, canonical (ascending ticker) order, strictly positive."""

    cash: float
    positions: tuple[tuple[str, float], ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "cash", _finite_nonnegative(self.cash, "cash"))
        normalized: list[tuple[str, float]] = []
        previous: str | None = None
        for asset, raw in sorted(self.positions):
            if not isinstance(asset, str) or not asset:
                raise ValueError("position assets must be non-empty identifiers")
            if asset == previous:
                raise ValueError(f"duplicate position for asset {asset!r}")
            quantity = _finite_nonnegative(raw, f"quantity of {asset!r}")
            if quantity > 0.0:  # zero-quantity entries are canonicalized away
                normalized.append((asset, quantity))
            previous = asset
        object.__setattr__(self, "positions", tuple(normalized))

    @classmethod
    def of(cls, cash: float, positions: Mapping[str, float] | None = None) -> PortfolioState:
        return cls(cash=cash, positions=tuple((positions or {}).items()))

    def quantity_of(self, asset: str) -> float:
        for candidate, quantity in self.positions:
            if candidate == asset:
                return quantity
        return 0.0

    @property
    def held_assets(self) -> tuple[str, ...]:
        return tuple(asset for asset, _ in self.positions)

    def as_dict(self) -> dict[str, float]:
        return dict(self.positions)


def union_assets(state: PortfolioState, targeted: Iterable[str]) -> tuple[str, ...]:
    """Canonical ``held(qty>0) ∪ targeted`` (ADR-0005 D7's reconciliation asset set)."""
    return tuple(sorted(set(state.held_assets) | set(targeted)))
