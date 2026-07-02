"""M3: ``universe.fixed_list`` and ``data.price`` behavior."""

from __future__ import annotations

from datetime import date

from quantize.nodes.data import PRICE
from quantize.nodes.universe import FIXED_LIST
from quantize.runtime.values import AssetSetValue, TimeSeriesValue
from tests.node_harness import business_days, invoke, make_dataset, make_view

_DAYS = business_days(3)
_D1, _D2, _D3 = _DAYS


def _closes() -> dict[str, dict[date, float]]:
    return {
        "SPY": {_D1: 100.0, _D2: 101.0, _D3: 102.0},
        "AGG": {_D2: 50.0, _D3: 51.0},  # starts late
    }


# --- universe.fixed_list -----------------------------------------------------------------------


def test_fixed_list_emits_canonical_order() -> None:
    view = make_view(_DAYS, _closes())
    outputs, events = invoke(FIXED_LIST, view=view, params={"tickers": ["SPY", "AGG", "QQQ"]})
    assets = outputs["assets"]
    assert isinstance(assets, AssetSetValue)
    assert assets.assets == ("AGG", "QQQ", "SPY")
    assert events == [("universe.selected", {"v": 1, "assets": ["AGG", "QQQ", "SPY"]})]


def test_fixed_list_single_ticker() -> None:
    view = make_view(_DAYS, _closes())
    outputs, _ = invoke(FIXED_LIST, view=view, params={"tickers": ["SPY"]})
    assets = outputs["assets"]
    assert isinstance(assets, AssetSetValue)
    assert assets.assets == ("SPY",)


# --- data.price --------------------------------------------------------------------------------


def test_price_emits_visible_history_per_asset() -> None:
    view = make_view(_DAYS, _closes())
    outputs, events = invoke(PRICE, view=view, inputs={"assets": AssetSetValue.of(["SPY", "AGG"])})
    series = outputs["series"]
    assert isinstance(series, TimeSeriesValue)
    assert series.assets == ("AGG", "SPY")
    assert series.history("SPY") == ((_D1, 100.0), (_D2, 101.0), (_D3, 102.0))
    assert series.history("AGG") == ((_D2, 50.0), (_D3, 51.0))
    # Inputs observed, bounded: per-asset counts + endpoint dates, never the series.
    assert events == [
        (
            "data.observed",
            {
                "v": 1,
                "per_asset": [
                    {
                        "asset": "AGG",
                        "observations": 2,
                        "first": _D2.isoformat(),
                        "last": _D3.isoformat(),
                    },
                    {
                        "asset": "SPY",
                        "observations": 3,
                        "first": _D1.isoformat(),
                        "last": _D3.isoformat(),
                    },
                ],
            },
        )
    ]


def test_price_lookahead_safety_view_truncates_history() -> None:
    view = make_view(_DAYS, _closes(), at=_D2)  # as of D2's close
    outputs, _ = invoke(PRICE, view=view, inputs={"assets": AssetSetValue.of(["SPY"])})
    series = outputs["series"]
    assert isinstance(series, TimeSeriesValue)
    assert series.history("SPY") == ((_D1, 100.0), (_D2, 101.0))  # D3 invisible


def test_price_unknown_asset_gets_empty_history_and_trace() -> None:
    view = make_view(_DAYS, _closes())
    outputs, events = invoke(
        PRICE, view=view, inputs={"assets": AssetSetValue.of(["SPY", "GHOST"])}
    )
    series = outputs["series"]
    assert isinstance(series, TimeSeriesValue)
    assert series.assets == ("GHOST", "SPY")  # domain preserved
    assert series.history("GHOST") == ()
    assert [e for e in events if e[0] == "data.missing_asset"] == [
        ("data.missing_asset", {"v": 1, "asset": "GHOST"})
    ]
    assert [e[0] for e in events] == ["data.missing_asset", "data.observed"]


def test_price_empty_universe_yields_empty_series() -> None:
    view = make_view(_DAYS, _closes())
    outputs, _ = invoke(PRICE, view=view, inputs={"assets": AssetSetValue.of([])})
    series = outputs["series"]
    assert isinstance(series, TimeSeriesValue)
    assert series.assets == ()


def test_price_respects_delayed_availability() -> None:
    # SPY's D3 close becomes available only after D3's close instant (vendor delay): a view AT
    # the close must not contain it, and no earlier value is substituted.
    dataset = make_dataset(_DAYS, {"SPY": {_D1: 100.0, _D2: 101.0, _D3: 102.0}})
    delayed = dataset.observations["SPY"]
    from quantize.market.data import MarketDataSet, PriceObservation

    rebuilt = MarketDataSet(
        calendar=dataset.calendar,
        observations={
            "SPY": [
                obs
                if obs.session_date != _D3
                else PriceObservation(
                    session_date=obs.session_date,
                    open_price=obs.open_price,
                    close_price=obs.close_price,
                    open_available_at=obs.open_available_at,
                    close_available_at=obs.close_available_at.replace(hour=23),
                )
                for obs in delayed
            ]
        },
    )
    view = rebuilt.as_of(dataset.calendar.sessions[-1].close_at)
    outputs, _ = invoke(PRICE, view=view, inputs={"assets": AssetSetValue.of(["SPY"])})
    series = outputs["series"]
    assert isinstance(series, TimeSeriesValue)
    assert series.history("SPY") == ((_D1, 100.0), (_D2, 101.0))
