"""M14.1b — server-side value summarization + wire DTO shaping.

Digest correctness lives in ``quantize/runtime/summarize.py`` (the numbers, in core); the wire
DTO (``quantize/api/dto/values.py``) only re-shapes. These tests assert the numeric digests
(dtype-aware min/max vs. true/false tally, weight sum + cash, per-asset preview cap) and that the
DTO lifts ``asset_values``/``series_preview`` to the right siblings, JSON-plainly.
"""

from __future__ import annotations

import json
from datetime import date, timedelta

import pytest

from quantize.api.dto.values import (
    AssetSetSummaryDto,
    CrossSectionSummaryDto,
    NodeValueResponse,
    PortfolioTargetsSummaryDto,
    ScalarSummaryDto,
    TimeSeriesSummaryDto,
    node_value_dto,
)
from quantize.runtime.summarize import (
    SERIES_PREVIEW_CAP,
    AssetSetSummary,
    CrossSectionSummary,
    PortfolioTargetsSummary,
    ScalarSummary,
    TimeSeriesSummary,
    summarize,
)
from quantize.runtime.values import (
    AssetSetValue,
    CrossSectionValue,
    PortfolioTargetsValue,
    RuntimeValue,
    ScalarValue,
    TimeSeriesValue,
)


def _response(value: RuntimeValue) -> NodeValueResponse:
    """Wrap a runtime value with fixed request metadata (the tests assert only the value parts)."""
    return node_value_dto(
        summarize(value),
        node_id="ret",
        component_path=(),
        session_date=date(2025, 6, 30),
        output_port="values",
        run_id="99999999-9999-9999-9999-999999999999",
        dataset_fingerprint="a" * 64,
        captured=False,
    )


# --- scalar ---------------------------------------------------------------------------------------


def test_scalar_number_and_boolean_dtype_round_trip() -> None:
    number = summarize(ScalarValue(dtype="Number", value=1.5))
    assert number == ScalarSummary(kind="scalar", dtype="Number", value=1.5)
    integer = summarize(ScalarValue(dtype="Integer", value=3))
    assert integer == ScalarSummary(kind="scalar", dtype="Integer", value=3)
    boolean = summarize(ScalarValue(dtype="Boolean", value=True))
    assert boolean == ScalarSummary(kind="scalar", dtype="Boolean", value=True)


def test_integer_scalar_stays_int_on_the_wire() -> None:
    # An Integer scalar must serialize as an int (3), never a widened float (3.0).
    response = _response(ScalarValue(dtype="Integer", value=3))
    assert isinstance(response.value_summary, ScalarSummaryDto)
    assert response.value_summary.value == 3
    dumped = response.model_dump(mode="json")
    assert dumped["value_summary"]["value"] == 3
    assert not isinstance(dumped["value_summary"]["value"], float)


def test_boolean_scalar_stays_bool_on_the_wire() -> None:
    response = _response(ScalarValue(dtype="Boolean", value=True))
    assert isinstance(response.value_summary, ScalarSummaryDto)
    assert response.value_summary.value is True
    dumped = response.model_dump(mode="json")
    assert dumped["value_summary"]["value"] is True


# --- asset set ------------------------------------------------------------------------------------


def test_asset_set_counts_members_in_canonical_order() -> None:
    summary = summarize(AssetSetValue.of(["QQQ", "AGG", "SPY"]))
    assert summary == AssetSetSummary(kind="asset_set", count=3, members=("AGG", "QQQ", "SPY"))


# --- cross section (dtype-aware digest) -----------------------------------------------------------


def test_cross_section_number_uses_min_max_and_missing() -> None:
    value = CrossSectionValue.numbers(["AGG", "QQQ", "SPY"], {"AGG": 0.1, "QQQ": 0.3})
    summary = summarize(value)
    assert isinstance(summary, CrossSectionSummary)
    assert summary.dtype == "Number"
    assert summary.domain_count == 3
    assert summary.present_count == 2
    assert summary.missing == ("SPY",)
    assert summary.min == 0.1
    assert summary.max == 0.3
    assert summary.true_count is None and summary.false_count is None
    assert summary.asset_values == (("AGG", 0.1), ("QQQ", 0.3))  # canonical ascending


def test_cross_section_boolean_uses_true_false_tally_not_min_max() -> None:
    value = CrossSectionValue.booleans(
        ["AGG", "QQQ", "SPY"], {"AGG": True, "QQQ": False, "SPY": True}
    )
    summary = summarize(value)
    assert isinstance(summary, CrossSectionSummary)
    assert summary.dtype == "Boolean"
    assert summary.true_count == 2
    assert summary.false_count == 1
    assert summary.min is None and summary.max is None


def test_cross_section_all_missing_has_no_min_max() -> None:
    value = CrossSectionValue.numbers(["AGG", "QQQ"], {})
    summary = summarize(value)
    assert isinstance(summary, CrossSectionSummary)
    assert summary.present_count == 0
    assert summary.min is None and summary.max is None
    assert summary.missing == ("AGG", "QQQ")


# --- time series (bounded preview) ----------------------------------------------------------------


def _series(asset: str, count: int) -> tuple[tuple[date, float], ...]:
    start = date(2025, 1, 1)
    return tuple((start + timedelta(days=i), float(i)) for i in range(count))


def test_time_series_preview_capped_to_most_recent_per_asset() -> None:
    long_history = _series("QQQ", SERIES_PREVIEW_CAP + 36)
    value = TimeSeriesValue.of({"QQQ": long_history, "AGG": []})  # AGG has an empty history
    summary = summarize(value)
    assert isinstance(summary, TimeSeriesSummary)
    assert summary.asset_count == 2
    assert summary.total_points == SERIES_PREVIEW_CAP + 36
    assert summary.first_date == long_history[0][0]
    assert summary.last_date == long_history[-1][0]
    preview = dict(summary.series_preview)
    assert len(preview["QQQ"]) == SERIES_PREVIEW_CAP  # capped
    assert preview["QQQ"][-1] == long_history[-1]  # keeps the MOST RECENT points
    assert preview["QQQ"][0] == long_history[-SERIES_PREVIEW_CAP]
    assert preview["AGG"] == ()  # empty-history asset stays present, no points


def test_time_series_with_no_points_has_no_window() -> None:
    summary = summarize(TimeSeriesValue.of({"AGG": [], "QQQ": []}))
    assert isinstance(summary, TimeSeriesSummary)
    assert summary.total_points == 0
    assert summary.first_date is None and summary.last_date is None


# --- portfolio targets (cash = 1 - Σ, server-side) ------------------------------------------------


def test_portfolio_targets_reports_weight_sum_and_cash_remainder() -> None:
    value = PortfolioTargetsValue.of({"QQQ": 0.4, "SPY": 0.3})
    summary = summarize(value)
    assert isinstance(summary, PortfolioTargetsSummary)
    assert summary.count == 2
    assert summary.weight_sum == pytest.approx(0.7)
    assert summary.cash == pytest.approx(0.3)  # the explicit remainder, never left to the client
    assert summary.asset_values == (("QQQ", 0.4), ("SPY", 0.3))


# --- wire DTO shaping: siblings + discriminator + JSON-plainness ----------------------------------


def test_cross_section_response_lifts_asset_values_sibling() -> None:
    response = _response(CrossSectionValue.numbers(["AGG", "QQQ"], {"AGG": 0.1, "QQQ": 0.3}))
    assert isinstance(response.value_summary, CrossSectionSummaryDto)
    assert response.series_preview is None
    assert response.asset_values is not None
    assert [(a.asset, a.value) for a in response.asset_values] == [("AGG", 0.1), ("QQQ", 0.3)]
    assert response.provenance.captured is False


def test_portfolio_targets_response_carries_cash_in_summary() -> None:
    response = _response(PortfolioTargetsValue.of({"QQQ": 0.4, "SPY": 0.3}))
    assert isinstance(response.value_summary, PortfolioTargetsSummaryDto)
    assert response.value_summary.cash == pytest.approx(0.3)
    assert response.asset_values is not None and len(response.asset_values) == 2


def test_time_series_response_lifts_series_preview_sibling() -> None:
    response = _response(TimeSeriesValue.of({"QQQ": _series("QQQ", 3)}))
    assert isinstance(response.value_summary, TimeSeriesSummaryDto)
    assert response.asset_values is None
    assert response.series_preview is not None
    assert response.series_preview[0].asset == "QQQ"


def test_scalar_and_asset_set_responses_have_no_siblings() -> None:
    scalar = _response(ScalarValue(dtype="Number", value=2.0))
    assert isinstance(scalar.value_summary, ScalarSummaryDto)
    assert scalar.asset_values is None and scalar.series_preview is None
    asset_set = _response(AssetSetValue.of(["QQQ", "AGG"]))
    assert isinstance(asset_set.value_summary, AssetSetSummaryDto)
    assert asset_set.value_summary.members == ("AGG", "QQQ")
    assert asset_set.asset_values is None and asset_set.series_preview is None


def test_response_is_json_plain_and_carries_kind_discriminator() -> None:
    response = _response(CrossSectionValue.numbers(["AGG", "QQQ"], {"AGG": 0.1, "QQQ": 0.3}))
    dumped = response.model_dump(mode="json")
    json.dumps(dumped)  # must not raise — plain JSON only, no Python objects across the boundary
    assert dumped["value_summary"]["kind"] == "cross_section"  # discriminator on the wire
    assert dumped["asset_values"] == [
        {"asset": "AGG", "value": 0.1},
        {"asset": "QQQ", "value": 0.3},
    ]
    assert dumped["series_preview"] is None
