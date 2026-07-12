"""Node Value Tap response DTOs (M14.1b) — the wire mirror of ``quantize/runtime/summarize.py``.

A pure re-shape: ``node_value_dto`` maps a server-computed domain ``ValueSummary`` (the numbers,
computed in core) plus the resolved address/provenance to the frozen ``GET /v1/runs/{id}/values``
contract. No number is derived here. ``value_summary`` is a discriminated union on ``kind``
(mirroring the five ``RuntimeValue`` shapes); ``asset_values`` and ``series_preview`` are siblings
of the summary (per the contract), lifted out of the domain summary. ``asset_values`` /
``series_preview`` default to ``None`` so they generate as OPTIONAL TypeScript fields; every other
field is required.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from pydantic import Field

from quantize.api.dto.common import _Dto
from quantize.runtime.summarize import (
    AssetSetSummary,
    CrossSectionSummary,
    ScalarSummary,
    TimeSeriesSummary,
    ValueSummary,
)


class ScalarSummaryDto(_Dto):
    kind: Literal["scalar"]
    dtype: Literal["Number", "Integer", "Boolean"]
    # int arm first so an Integer scalar (e.g. 3) round-trips as an int on the wire, not 3.0; bool
    # is handled distinctly by pydantic strict, so True/False never fall into the int arm.
    value: int | float | bool


class AssetSetSummaryDto(_Dto):
    kind: Literal["asset_set"]
    count: int
    members: tuple[str, ...]


class CrossSectionSummaryDto(_Dto):
    kind: Literal["cross_section"]
    dtype: Literal["Number", "Boolean"]
    domain_count: int
    present_count: int
    missing: tuple[str, ...]
    min: float | None = None  # Number only
    max: float | None = None  # Number only
    true_count: int | None = None  # Boolean only
    false_count: int | None = None  # Boolean only


class WindowDto(_Dto):
    # The FULL history span of the value (across all assets), NOT the span of series_preview. The
    # preview is capped to the most-recent points per asset, so its coverage can be narrower than
    # [first_date, last_date]; a renderer must read the preview's own span from its points.
    first_date: date
    last_date: date


class TimeSeriesSummaryDto(_Dto):
    kind: Literal["time_series"]
    asset_count: int
    total_points: int
    # window spans the value's FULL history; series_preview (a sibling of this summary) is capped to
    # the most-recent points per asset and may not reach window.first_date — never assume it does.
    window: WindowDto | None = None  # None when no asset has any point


class PortfolioTargetsSummaryDto(_Dto):
    kind: Literal["portfolio_targets"]
    count: int
    weight_sum: float
    cash: float  # the explicit 1 - Σ remainder (server-computed; never derived by the client)


# The five summary shapes, spelled exactly once. Both the discriminated ``ValueSummaryDto`` and
# ``_shape``'s return type reuse it so the member list never drifts out of sync.
type _SummaryDtoUnion = (
    ScalarSummaryDto
    | AssetSetSummaryDto
    | CrossSectionSummaryDto
    | TimeSeriesSummaryDto
    | PortfolioTargetsSummaryDto
)

ValueSummaryDto = Annotated[_SummaryDtoUnion, Field(discriminator="kind")]


class AssetValueDto(_Dto):
    asset: str
    value: float | bool


class SeriesPreviewDto(_Dto):
    asset: str
    points: tuple[tuple[date, float], ...]


class ProvenanceDto(_Dto):
    run_id: str
    dataset_fingerprint: str
    captured: bool  # always False in M14 (recomputed on demand, not read from a run-time artifact)


class NodeValueResponse(_Dto):
    """The value a node's output port produced at a session (``GET /v1/runs/{id}/values``)."""

    node_id: str
    component_path: tuple[str, ...]
    session_date: date
    output_port: str
    value_summary: ValueSummaryDto
    asset_values: tuple[AssetValueDto, ...] | None = None
    series_preview: tuple[SeriesPreviewDto, ...] | None = None
    provenance: ProvenanceDto


def node_value_dto(
    summary: ValueSummary,
    *,
    node_id: str,
    component_path: tuple[str, ...],
    session_date: date,
    output_port: str,
    run_id: str,
    dataset_fingerprint: str,
    captured: bool,
) -> NodeValueResponse:
    """Re-shape a domain summary + resolved address into the wire response. Pure; adds no number."""
    value_summary, asset_values, series_preview = _shape(summary)
    return NodeValueResponse(
        node_id=node_id,
        component_path=component_path,
        session_date=session_date,
        output_port=output_port,
        value_summary=value_summary,
        asset_values=asset_values,
        series_preview=series_preview,
        provenance=ProvenanceDto(
            run_id=run_id, dataset_fingerprint=dataset_fingerprint, captured=captured
        ),
    )


def _shape(
    summary: ValueSummary,
) -> tuple[
    _SummaryDtoUnion,
    tuple[AssetValueDto, ...] | None,
    tuple[SeriesPreviewDto, ...] | None,
]:
    """Split a domain summary into (wire summary, sibling asset_values?, series_preview?)."""
    if isinstance(summary, ScalarSummary):
        scalar = ScalarSummaryDto(kind="scalar", dtype=summary.dtype, value=summary.value)
        return scalar, None, None
    if isinstance(summary, AssetSetSummary):
        return (
            AssetSetSummaryDto(kind="asset_set", count=summary.count, members=summary.members),
            None,
            None,
        )
    if isinstance(summary, CrossSectionSummary):
        return (
            CrossSectionSummaryDto(
                kind="cross_section",
                dtype=summary.dtype,
                domain_count=summary.domain_count,
                present_count=summary.present_count,
                missing=summary.missing,
                min=summary.min,
                max=summary.max,
                true_count=summary.true_count,
                false_count=summary.false_count,
            ),
            tuple(AssetValueDto(asset=a, value=v) for a, v in summary.asset_values),
            None,
        )
    if isinstance(summary, TimeSeriesSummary):
        window = (
            WindowDto(first_date=summary.first_date, last_date=summary.last_date)
            if summary.first_date is not None and summary.last_date is not None
            else None
        )
        return (
            TimeSeriesSummaryDto(
                kind="time_series",
                asset_count=summary.asset_count,
                total_points=summary.total_points,
                window=window,
            ),
            None,
            tuple(SeriesPreviewDto(asset=a, points=pts) for a, pts in summary.series_preview),
        )
    return (
        PortfolioTargetsSummaryDto(
            kind="portfolio_targets",
            count=summary.count,
            weight_sum=summary.weight_sum,
            cash=summary.cash,
        ),
        tuple(AssetValueDto(asset=a, value=v) for a, v in summary.asset_values),
        None,
    )
