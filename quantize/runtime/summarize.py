"""Server-side summarization of a node's output value (M14.1b) — the NUMBERS, in core.

This module digests ``RuntimeValue`` instances and belongs beside ``quantize/runtime/values.py``:
it maps one ``RuntimeValue`` to a frozen, JSON-plain domain summary. It stays deliberately light —
it imports only ``dataclasses``/``datetime``/``typing`` and ``quantize.runtime.values`` — so the
wire DTO layer can depend on it without pulling in the evaluator/engine/persistence stack.

All numeric digests the Node Value Tap serves are computed HERE, never in the frontend (invariant 5)
and never in the wire layer: ``quantize/api/dto/values.py`` re-shapes this summary to the wire
without adding any number. Digests deliberately stop at the frozen contract's own vocabulary —
count / min / max, weight sum + cash, true/false tallies — no mean/std/other statistics (that is M15
vocabulary).

``series_preview`` is bounded to the most-recent ``SERIES_PREVIEW_CAP`` points PER ASSET so an
unbounded history never crosses the API boundary (invariant 6). All asset ordering is the value
classes' canonical ascending order, which the summaries preserve.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal

from quantize.runtime.values import (
    AssetSetValue,
    CrossSectionValue,
    PortfolioTargetsValue,
    RuntimeValue,
    ScalarValue,
    TimeSeriesValue,
)

# The most-recent points served per asset in a TimeSeries preview. A committed constant: changing
# it is a reviewed diff, not a tweak.
SERIES_PREVIEW_CAP = 64


@dataclass(frozen=True)
class ScalarSummary:
    kind: Literal["scalar"]
    dtype: Literal["Number", "Integer", "Boolean"]
    value: float | int | bool


@dataclass(frozen=True)
class AssetSetSummary:
    kind: Literal["asset_set"]
    count: int
    members: tuple[str, ...]


@dataclass(frozen=True)
class CrossSectionSummary:
    kind: Literal["cross_section"]
    dtype: Literal["Number", "Boolean"]
    domain_count: int
    present_count: int
    missing: tuple[str, ...]
    # dtype-appropriate digest: min/max for Number, true/false tallies for Boolean.
    min: float | None
    max: float | None
    true_count: int | None
    false_count: int | None
    asset_values: tuple[tuple[str, float | bool], ...]


@dataclass(frozen=True)
class TimeSeriesSummary:
    kind: Literal["time_series"]
    asset_count: int
    total_points: int
    # first_date/last_date describe the FULL history span of the value (across all assets), NOT the
    # span of series_preview. series_preview is capped to the most-recent SERIES_PREVIEW_CAP points
    # per asset, so its coverage can be narrower; a renderer must read the preview's own span from
    # its points' endpoints and never assume it reaches first_date.
    first_date: date | None
    last_date: date | None
    series_preview: tuple[tuple[str, tuple[tuple[date, float], ...]], ...]


@dataclass(frozen=True)
class PortfolioTargetsSummary:
    kind: Literal["portfolio_targets"]
    count: int
    weight_sum: float
    cash: float
    asset_values: tuple[tuple[str, float], ...]


ValueSummary = (
    ScalarSummary
    | AssetSetSummary
    | CrossSectionSummary
    | TimeSeriesSummary
    | PortfolioTargetsSummary
)


def summarize(value: RuntimeValue) -> ValueSummary:
    """Digest one node-output ``RuntimeValue`` into a server-computed, JSON-plain summary."""
    if isinstance(value, ScalarValue):
        return ScalarSummary(kind="scalar", dtype=value.dtype, value=value.value)
    if isinstance(value, AssetSetValue):
        return AssetSetSummary(kind="asset_set", count=len(value.assets), members=value.assets)
    if isinstance(value, CrossSectionValue):
        return _cross_section(value)
    if isinstance(value, TimeSeriesValue):
        return _time_series(value)
    if isinstance(value, PortfolioTargetsValue):
        return PortfolioTargetsSummary(
            kind="portfolio_targets",
            count=len(value.weights),
            weight_sum=value.invested_weight,
            cash=value.cash_weight,  # the explicit 1 - Σ remainder, server-computed
            asset_values=value.weights,
        )
    raise TypeError(f"unsummarizable runtime value: {type(value).__name__}")  # pragma: no cover


def _cross_section(value: CrossSectionValue) -> CrossSectionSummary:
    present = value.values  # canonical ascending order, present assets only
    minimum: float | None = None
    maximum: float | None = None
    true_count: int | None = None
    false_count: int | None = None
    if value.dtype == "Number":
        numbers = [float(v) for _, v in present]
        if numbers:
            minimum = min(numbers)
            maximum = max(numbers)
    else:  # Boolean — a true/false tally is meaningful where min/max is not
        true_count = sum(1 for _, v in present if v is True)
        false_count = len(present) - true_count
    return CrossSectionSummary(
        kind="cross_section",
        dtype=value.dtype,
        domain_count=len(value.domain),
        present_count=len(present),
        missing=value.missing_assets,
        min=minimum,
        max=maximum,
        true_count=true_count,
        false_count=false_count,
        asset_values=present,
    )


def _time_series(value: TimeSeriesValue) -> TimeSeriesSummary:
    total_points = 0
    first_date: date | None = None
    last_date: date | None = None
    preview: list[tuple[str, tuple[tuple[date, float], ...]]] = []
    for asset, history in value.series:  # canonical ascending asset order
        total_points += len(history)
        if history:
            # first_date/last_date span the FULL history across assets; series_preview below is
            # capped and may not reach these endpoints.
            first_date = history[0][0] if first_date is None else min(first_date, history[0][0])
            last_date = history[-1][0] if last_date is None else max(last_date, history[-1][0])
        # Most-recent points per asset; an empty history stays present with no points.
        preview.append((asset, history[-SERIES_PREVIEW_CAP:]))
    return TimeSeriesSummary(
        kind="time_series",
        asset_count=len(value.series),
        total_points=total_points,
        first_date=first_date,
        last_date=last_date,
        series_preview=tuple(preview),
    )
