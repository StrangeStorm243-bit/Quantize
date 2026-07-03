"""Typed runtime values — the executable counterparts of the ``PortType`` lattice.

Every value that flows over an edge at evaluation time is one of these frozen, canonical-order
value objects. Construction is strict: assets are canonically ordered (ascending ticker, the
ratified v0 order), numbers are finite (NaN/Infinity rejected — mirroring the persisted-JSON
policy), and ``PortfolioTargetsValue`` enforces the portfolio invariants (weights finite, >= 0,
sum <= 1 within ``WEIGHT_TOLERANCE``; cash is the remainder). A node therefore cannot emit an
out-of-contract value without failing loudly at construction.

``CrossSectionValue`` and ``TimeSeriesValue`` carry the **bound asset domain** explicitly: an
asset excluded by a node's documented missing-data rule stays in ``domain`` but has no entry in
``values``/an empty history — exclusion is visible, never a silent drop.

``OrderList`` is deliberately absent: it is engine-owned (M4) and never a graph value.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Literal

from quantize.schema.types import (
    AssetSetType,
    CrossSectionType,
    PortfolioTargetsType,
    PortType,
    ScalarType,
    TimeSeriesType,
)

# Absolute tolerance for portfolio-weight sums (STRATEGY_LANGUAGE.md §3, standing default).
WEIGHT_TOLERANCE = 1e-9


def _canonical_assets(assets: Iterable[str], label: str) -> tuple[str, ...]:
    ordered = tuple(sorted(assets))
    for asset in ordered:
        if not isinstance(asset, str) or not asset:
            raise ValueError(f"{label} must contain non-empty asset identifiers")
    for first, second in zip(ordered, ordered[1:], strict=False):
        if first == second:
            raise ValueError(f"{label} contains duplicate asset {first!r}")
    return ordered


def _finite_number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number, got {type(value).__name__}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite (no NaN/Infinity)")
    return number


@dataclass(frozen=True)
class ScalarValue:
    """A single typed scalar."""

    dtype: Literal["Number", "Integer", "Boolean"]
    value: float | int | bool

    def __post_init__(self) -> None:
        if self.dtype == "Boolean":
            if not isinstance(self.value, bool):
                raise ValueError("Scalar[Boolean] requires a bool value")
        elif self.dtype == "Integer":
            if isinstance(self.value, bool) or not isinstance(self.value, int):
                raise ValueError("Scalar[Integer] requires an int value")
        else:  # Number
            object.__setattr__(self, "value", _finite_number(self.value, "Scalar[Number] value"))

    @property
    def port_type(self) -> PortType:
        return ScalarType(kind="Scalar", dtype=self.dtype)


@dataclass(frozen=True)
class AssetSetValue:
    """An ordered set of asset ids in canonical (ascending ticker) order."""

    assets: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "assets", _canonical_assets(self.assets, "AssetSet"))

    @classmethod
    def of(cls, assets: Iterable[str]) -> AssetSetValue:
        return cls(assets=tuple(assets))

    @property
    def port_type(self) -> PortType:
        return AssetSetType(kind="AssetSet")


@dataclass(frozen=True)
class CrossSectionValue:
    """One value per asset at the evaluation instant, over an explicit bound domain.

    ``values`` holds only the assets the producing node could compute (its documented
    missing-data rule decides the rest); ``domain`` always holds the full bound universe.
    """

    dtype: Literal["Number", "Boolean"]
    domain: tuple[str, ...]
    values: tuple[tuple[str, float | bool], ...]

    def __post_init__(self) -> None:
        domain = _canonical_assets(self.domain, "CrossSection domain")
        object.__setattr__(self, "domain", domain)
        domain_set = set(domain)
        normalized: list[tuple[str, float | bool]] = []
        for asset, raw in sorted(self.values):
            if asset not in domain_set:
                raise ValueError(f"CrossSection value for {asset!r} is outside its domain")
            if self.dtype == "Boolean":
                if not isinstance(raw, bool):
                    raise ValueError(f"CrossSection[Boolean] value for {asset!r} must be a bool")
                normalized.append((asset, raw))
            else:
                normalized.append((asset, _finite_number(raw, f"CrossSection value for {asset!r}")))
        for (first, _), (second, _) in zip(normalized, normalized[1:], strict=False):
            if first == second:
                raise ValueError(f"CrossSection has duplicate values for asset {first!r}")
        object.__setattr__(self, "values", tuple(normalized))

    @classmethod
    def numbers(cls, domain: Iterable[str], values: Mapping[str, float]) -> CrossSectionValue:
        return cls(dtype="Number", domain=tuple(domain), values=tuple(values.items()))

    @classmethod
    def booleans(cls, domain: Iterable[str], values: Mapping[str, bool]) -> CrossSectionValue:
        return cls(dtype="Boolean", domain=tuple(domain), values=tuple(values.items()))

    def as_dict(self) -> dict[str, float | bool]:
        return dict(self.values)

    @property
    def present_assets(self) -> tuple[str, ...]:
        return tuple(asset for asset, _ in self.values)

    @property
    def missing_assets(self) -> tuple[str, ...]:
        present = {asset for asset, _ in self.values}
        return tuple(asset for asset in self.domain if asset not in present)

    @property
    def port_type(self) -> PortType:
        return CrossSectionType(kind="CrossSection", dtype=self.dtype)


@dataclass(frozen=True)
class TimeSeriesValue:
    """Per-asset date-indexed history. Every domain asset has an entry (possibly empty)."""

    series: tuple[tuple[str, tuple[tuple[date, float], ...]], ...]

    def __post_init__(self) -> None:
        assets = _canonical_assets((asset for asset, _ in self.series), "TimeSeries domain")
        by_asset = dict(self.series)
        normalized: list[tuple[str, tuple[tuple[date, float], ...]]] = []
        for asset in assets:
            history: list[tuple[date, float]] = []
            previous: date | None = None
            for day, raw in by_asset[asset]:
                if not isinstance(day, date):
                    raise ValueError(f"TimeSeries dates for {asset!r} must be dates")
                if previous is not None and not previous < day:
                    raise ValueError(f"TimeSeries dates for {asset!r} must be strictly increasing")
                history.append((day, _finite_number(raw, f"TimeSeries value for {asset!r}")))
                previous = day
            normalized.append((asset, tuple(history)))
        object.__setattr__(self, "series", tuple(normalized))

    @classmethod
    def of(cls, series: Mapping[str, Sequence[tuple[date, float]]]) -> TimeSeriesValue:
        return cls(series=tuple((asset, tuple(history)) for asset, history in series.items()))

    @classmethod
    def from_view_history(
        cls, series: Mapping[str, Sequence[tuple[date, float]]]
    ) -> TimeSeriesValue:
        """Construction for histories read VERBATIM from an availability-gated ``DataView``
        (pre-M9 C3): the dataset already enforced strictly-increasing dates and positive-finite
        prices at construction, so re-checking every point here is pure duplicate work at
        O(points) per evaluation. The domain is still canonicalized and validated (cheap);
        ONLY the per-point checks are skipped. Callers must pass unmodified ``close_history``
        tuples — computed values must use ``of`` (their arithmetic can overflow)."""
        assets = _canonical_assets(series.keys(), "TimeSeries domain")
        normalized = tuple((asset, tuple(series[asset])) for asset in assets)
        value = object.__new__(cls)
        object.__setattr__(value, "series", normalized)
        return value

    def history(self, asset: str) -> tuple[tuple[date, float], ...]:
        for candidate, series in self.series:
            if candidate == asset:
                return series
        raise KeyError(asset)

    @property
    def assets(self) -> tuple[str, ...]:
        return tuple(asset for asset, _ in self.series)

    @property
    def port_type(self) -> PortType:
        return TimeSeriesType(kind="TimeSeries", dtype="Number")


@dataclass(frozen=True)
class PortfolioTargetsValue:
    """Desired allocation: asset -> target weight; cash is the explicit remainder ``1 - sum``."""

    weights: tuple[tuple[str, float], ...]

    def __post_init__(self) -> None:
        _canonical_assets((asset for asset, _ in self.weights), "PortfolioTargets")
        normalized: list[tuple[str, float]] = []
        total = 0.0
        for asset, raw in sorted(self.weights):
            weight = _finite_number(raw, f"weight for {asset!r}")
            if weight < 0.0:
                raise ValueError(f"weight for {asset!r} must be >= 0, got {weight!r}")
            normalized.append((asset, weight))
            total += weight
        if total > 1.0 + WEIGHT_TOLERANCE:
            raise ValueError(f"portfolio weights sum to {total!r}, exceeding 1")
        object.__setattr__(self, "weights", tuple(normalized))

    @classmethod
    def of(cls, weights: Mapping[str, float]) -> PortfolioTargetsValue:
        return cls(weights=tuple(weights.items()))

    def as_dict(self) -> dict[str, float]:
        return dict(self.weights)

    @property
    def invested_weight(self) -> float:
        return sum(weight for _, weight in self.weights)

    @property
    def cash_weight(self) -> float:
        return max(0.0, 1.0 - self.invested_weight)

    @property
    def port_type(self) -> PortType:
        return PortfolioTargetsType(kind="PortfolioTargets")


RuntimeValue = (
    ScalarValue | AssetSetValue | CrossSectionValue | TimeSeriesValue | PortfolioTargetsValue
)
