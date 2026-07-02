"""M3: typed runtime values — canonical order, domain bookkeeping, and strict construction."""

from __future__ import annotations

from datetime import date

import pytest

from quantize.runtime.values import (
    WEIGHT_TOLERANCE,
    AssetSetValue,
    CrossSectionValue,
    PortfolioTargetsValue,
    ScalarValue,
    TimeSeriesValue,
)
from quantize.schema.types import (
    AssetSetType,
    CrossSectionType,
    PortfolioTargetsType,
    ScalarType,
    TimeSeriesType,
)

# --- AssetSetValue -----------------------------------------------------------------------------


def test_asset_set_canonicalizes_order() -> None:
    value = AssetSetValue.of(["SPY", "AGG", "QQQ"])
    assert value.assets == ("AGG", "QQQ", "SPY")
    assert value.port_type == AssetSetType(kind="AssetSet")


def test_asset_set_rejects_duplicates() -> None:
    with pytest.raises(ValueError, match="duplicate asset"):
        AssetSetValue.of(["SPY", "SPY"])


def test_asset_set_rejects_empty_identifier() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        AssetSetValue.of([""])


def test_empty_asset_set_is_valid() -> None:
    assert AssetSetValue.of([]).assets == ()


# --- ScalarValue -------------------------------------------------------------------------------


def test_scalar_number_accepts_int_and_normalizes_to_float() -> None:
    value = ScalarValue(dtype="Number", value=3)
    assert value.value == 3.0 and isinstance(value.value, float)
    assert value.port_type == ScalarType(kind="Scalar", dtype="Number")


def test_scalar_integer_rejects_bool() -> None:
    with pytest.raises(ValueError, match="int"):
        ScalarValue(dtype="Integer", value=True)


def test_scalar_number_rejects_nan() -> None:
    with pytest.raises(ValueError, match="finite"):
        ScalarValue(dtype="Number", value=float("nan"))


# --- CrossSectionValue -------------------------------------------------------------------------


def test_cross_section_tracks_domain_and_missing_assets() -> None:
    value = CrossSectionValue.numbers(["SPY", "AGG", "QQQ"], {"SPY": 1.0, "AGG": 2.0})
    assert value.domain == ("AGG", "QQQ", "SPY")
    assert value.present_assets == ("AGG", "SPY")
    assert value.missing_assets == ("QQQ",)
    assert value.as_dict() == {"AGG": 2.0, "SPY": 1.0}
    assert value.port_type == CrossSectionType(kind="CrossSection", dtype="Number")


def test_cross_section_rejects_value_outside_domain() -> None:
    with pytest.raises(ValueError, match="outside its domain"):
        CrossSectionValue.numbers(["AGG"], {"SPY": 1.0})


def test_cross_section_boolean_requires_bools() -> None:
    with pytest.raises(ValueError, match="bool"):
        CrossSectionValue(dtype="Boolean", domain=("SPY",), values=(("SPY", 1.0),))
    mask = CrossSectionValue.booleans(["SPY"], {"SPY": True})
    assert mask.port_type == CrossSectionType(kind="CrossSection", dtype="Boolean")


def test_cross_section_rejects_non_finite_numbers() -> None:
    with pytest.raises(ValueError, match="finite"):
        CrossSectionValue.numbers(["SPY"], {"SPY": float("inf")})


# --- TimeSeriesValue ---------------------------------------------------------------------------


def test_time_series_orders_assets_and_allows_empty_histories() -> None:
    value = TimeSeriesValue.of(
        {
            "SPY": [(date(2026, 1, 5), 100.0), (date(2026, 1, 6), 101.0)],
            "AGG": [],
        }
    )
    assert value.assets == ("AGG", "SPY")
    assert value.history("AGG") == ()
    assert value.history("SPY") == ((date(2026, 1, 5), 100.0), (date(2026, 1, 6), 101.0))
    assert value.port_type == TimeSeriesType(kind="TimeSeries", dtype="Number")


def test_time_series_rejects_non_increasing_dates() -> None:
    with pytest.raises(ValueError, match="strictly increasing"):
        TimeSeriesValue.of({"SPY": [(date(2026, 1, 6), 100.0), (date(2026, 1, 5), 99.0)]})


def test_time_series_unknown_asset_raises() -> None:
    with pytest.raises(KeyError):
        TimeSeriesValue.of({"SPY": []}).history("QQQ")


# --- PortfolioTargetsValue ---------------------------------------------------------------------


def test_targets_cash_is_the_remainder() -> None:
    targets = PortfolioTargetsValue.of({"SPY": 0.25, "AGG": 0.25, "EFA": 0.25})
    assert targets.weights == (("AGG", 0.25), ("EFA", 0.25), ("SPY", 0.25))
    assert targets.invested_weight == pytest.approx(0.75)
    assert targets.cash_weight == pytest.approx(0.25)
    assert targets.port_type == PortfolioTargetsType(kind="PortfolioTargets")


def test_empty_targets_are_all_cash() -> None:
    targets = PortfolioTargetsValue.of({})
    assert targets.invested_weight == 0.0
    assert targets.cash_weight == 1.0


def test_targets_reject_negative_weight() -> None:
    with pytest.raises(ValueError, match=">= 0"):
        PortfolioTargetsValue.of({"SPY": -0.1})


def test_targets_reject_sum_above_one_beyond_tolerance() -> None:
    with pytest.raises(ValueError, match="exceeding 1"):
        PortfolioTargetsValue.of({"SPY": 0.6, "AGG": 0.4 + 1e-6})


def test_targets_accept_sum_within_tolerance() -> None:
    targets = PortfolioTargetsValue.of({"SPY": 0.5, "AGG": 0.5 + WEIGHT_TOLERANCE / 2})
    assert targets.invested_weight == pytest.approx(1.0, abs=1e-8)
