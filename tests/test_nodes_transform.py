"""M3: transform-node behavior — trailing return, moving average, latest, rank."""

from __future__ import annotations

from datetime import date

import pytest

from quantize.nodes.transform import LATEST, MOVING_AVERAGE, RANK, TRAILING_RETURN
from quantize.runtime.values import CrossSectionValue, TimeSeriesValue
from tests.node_harness import business_days, invoke, make_view

_DAYS = business_days(5)
_D1, _D2, _D3, _D4, _D5 = _DAYS


def _series(closes: dict[str, dict[date, float]]) -> TimeSeriesValue:
    return TimeSeriesValue.of(
        {asset: sorted(asset_closes.items()) for asset, asset_closes in closes.items()}
    )


def _view(closes: dict[str, dict[date, float]], at: date | None = None) -> object:
    return make_view(_DAYS, closes, at=at)


# --- transform.trailing_return -----------------------------------------------------------------


def test_trailing_return_hand_computed() -> None:
    closes = {"SPY": {_D1: 100.0, _D2: 110.0, _D3: 121.0}}
    view = make_view(_DAYS[:3], closes)
    outputs, events = invoke(
        TRAILING_RETURN,
        view=view,
        params={"lookback_sessions": 2},
        inputs={"series": _series(closes)},
    )
    values = outputs["values"]
    assert isinstance(values, CrossSectionValue)
    assert values.as_dict() == {"SPY": pytest.approx(0.21)}  # 121/100 - 1
    assert events == [("transform.computed", {"v": 1, "computed": ["SPY"]})]


def test_trailing_return_smallest_lookback() -> None:
    closes = {"SPY": {_D1: 100.0, _D2: 110.0}}
    view = make_view(_DAYS[:2], closes)
    outputs, _ = invoke(
        TRAILING_RETURN,
        view=view,
        params={"lookback_sessions": 1},
        inputs={"series": _series(closes)},
    )
    values = outputs["values"]
    assert isinstance(values, CrossSectionValue)
    assert values.as_dict() == {"SPY": pytest.approx(0.10)}


def test_trailing_return_excludes_insufficient_history() -> None:
    closes = {"SPY": {_D1: 100.0, _D2: 110.0, _D3: 121.0}, "AGG": {_D3: 50.0}}
    view = make_view(_DAYS[:3], closes)
    outputs, events = invoke(
        TRAILING_RETURN,
        view=view,
        params={"lookback_sessions": 2},
        inputs={"series": _series(closes)},
    )
    values = outputs["values"]
    assert isinstance(values, CrossSectionValue)
    assert values.present_assets == ("SPY",)
    assert values.missing_assets == ("AGG",)  # excluded but still in the domain
    assert (
        "transform.excluded",
        {"v": 1, "asset": "AGG", "reason": "missing_anchor_close"},
    ) in events


def test_trailing_return_excludes_missing_current_close() -> None:
    closes = {"SPY": {_D1: 100.0, _D2: 110.0}}  # no D3 close
    view = make_view(_DAYS[:3], {"SPY": {_D1: 100.0, _D2: 110.0}, "X": {_D3: 1.0}})
    outputs, events = invoke(
        TRAILING_RETURN,
        view=view,
        params={"lookback_sessions": 1},
        inputs={"series": _series(closes)},
    )
    values = outputs["values"]
    assert isinstance(values, CrossSectionValue)
    assert values.present_assets == ()  # stale D2 close is NOT reused for D3
    assert (
        "transform.excluded",
        {"v": 1, "asset": "SPY", "reason": "missing_current_close"},
    ) in events


def test_trailing_return_excludes_all_when_calendar_too_short() -> None:
    closes = {"SPY": {_D1: 100.0, _D2: 110.0}}
    view = make_view(_DAYS[:2], closes)
    outputs, events = invoke(
        TRAILING_RETURN,
        view=view,
        params={"lookback_sessions": 2},
        inputs={"series": _series(closes)},
    )
    values = outputs["values"]
    assert isinstance(values, CrossSectionValue)
    assert values.present_assets == ()
    assert (
        "transform.excluded",
        {"v": 1, "asset": "SPY", "reason": "insufficient_sessions"},
    ) in events


def test_trailing_return_zero_denominator_is_excluded() -> None:
    # A zero anchor can only arise in a derived series (raw prices are positive by contract).
    derived = TimeSeriesValue.of({"SPY": [(_D1, 0.0), (_D2, 1.0), (_D3, 2.0)]})
    view = make_view(_DAYS[:3], {"SPY": {_D1: 1.0, _D2: 1.0, _D3: 1.0}})
    outputs, events = invoke(
        TRAILING_RETURN,
        view=view,
        params={"lookback_sessions": 2},
        inputs={"series": derived},
    )
    values = outputs["values"]
    assert isinstance(values, CrossSectionValue)
    assert values.present_assets == ()
    assert ("transform.excluded", {"v": 1, "asset": "SPY", "reason": "zero_denominator"}) in events


def test_trailing_return_anchors_to_the_view_not_its_input() -> None:
    # The node's "current session" comes from the as-of view (D3), NOT from its input series —
    # even when the series carries observations beyond the view, they are ignored.
    closes = {"SPY": {day: 100.0 + index for index, day in enumerate(_DAYS)}}
    view = make_view(_DAYS, closes, at=_D3)
    full_series = _series(closes)  # includes D4 and D5 — beyond the view
    outputs, _ = invoke(
        TRAILING_RETURN,
        view=view,
        params={"lookback_sessions": 2},
        inputs={"series": full_series},
    )
    values = outputs["values"]
    assert isinstance(values, CrossSectionValue)
    assert values.as_dict() == {"SPY": pytest.approx(102.0 / 100.0 - 1.0)}  # D3/D1, never D5


# --- transform.moving_average ------------------------------------------------------------------


def test_moving_average_hand_computed() -> None:
    closes = {"SPY": {_D1: 1.0, _D2: 2.0, _D3: 3.0, _D4: 4.0}}
    view = make_view(_DAYS[:4], closes)
    outputs, _ = invoke(
        MOVING_AVERAGE, view=view, params={"window": 2}, inputs={"series": _series(closes)}
    )
    series = outputs["series"]
    assert isinstance(series, TimeSeriesValue)
    assert series.history("SPY") == ((_D2, 1.5), (_D3, 2.5), (_D4, 3.5))


def test_moving_average_window_one_is_identity() -> None:
    closes = {"SPY": {_D1: 1.0, _D2: 2.0}}
    view = make_view(_DAYS[:2], closes)
    outputs, _ = invoke(
        MOVING_AVERAGE, view=view, params={"window": 1}, inputs={"series": _series(closes)}
    )
    series = outputs["series"]
    assert isinstance(series, TimeSeriesValue)
    assert series.history("SPY") == ((_D1, 1.0), (_D2, 2.0))


def test_moving_average_gap_produces_no_points_no_fill() -> None:
    closes = {"SPY": {_D1: 1.0, _D2: 2.0, _D4: 4.0}}  # D3 missing
    view = make_view(_DAYS[:4], closes)
    outputs, _ = invoke(
        MOVING_AVERAGE, view=view, params={"window": 2}, inputs={"series": _series(closes)}
    )
    series = outputs["series"]
    assert isinstance(series, TimeSeriesValue)
    # D2 has (D1, D2); D3 needs D3 (missing); D4 needs D3 (missing): NO forward fill.
    assert series.history("SPY") == ((_D2, 1.5),)


def test_moving_average_warmup_unmet_is_traced() -> None:
    closes = {"SPY": {_D1: 1.0, _D2: 2.0}}
    view = make_view(_DAYS[:2], closes)
    outputs, events = invoke(
        MOVING_AVERAGE, view=view, params={"window": 3}, inputs={"series": _series(closes)}
    )
    series = outputs["series"]
    assert isinstance(series, TimeSeriesValue)
    assert series.history("SPY") == ()
    assert ("transform.excluded", {"v": 1, "asset": "SPY", "reason": "warmup_unmet"}) in events


# --- transform.latest ---------------------------------------------------------------------------


def test_latest_takes_the_value_at_the_latest_session() -> None:
    closes = {"SPY": {_D1: 100.0, _D2: 110.0}, "AGG": {_D1: 50.0, _D2: 51.0}}
    view = make_view(_DAYS[:2], closes)
    outputs, events = invoke(LATEST, view=view, inputs={"series": _series(closes)})
    values = outputs["values"]
    assert isinstance(values, CrossSectionValue)
    assert values.as_dict() == {"SPY": 110.0, "AGG": 51.0}
    assert events == [("transform.computed", {"v": 1, "computed": ["AGG", "SPY"]})]


def test_latest_never_reuses_a_stale_observation() -> None:
    closes = {"SPY": {_D1: 100.0}}  # nothing at D2
    view = make_view(_DAYS[:2], {"SPY": {_D1: 100.0}, "X": {_D2: 1.0}})
    outputs, events = invoke(LATEST, view=view, inputs={"series": _series(closes)})
    values = outputs["values"]
    assert isinstance(values, CrossSectionValue)
    assert values.present_assets == ()
    assert values.domain == ("SPY",)
    assert (
        "transform.excluded",
        {"v": 1, "asset": "SPY", "reason": "missing_current_observation"},
    ) in events


def test_latest_empty_history_is_excluded() -> None:
    view = make_view(_DAYS[:2], {"X": {_D2: 1.0}})
    outputs, events = invoke(LATEST, view=view, inputs={"series": TimeSeriesValue.of({"SPY": []})})
    values = outputs["values"]
    assert isinstance(values, CrossSectionValue)
    assert values.present_assets == ()
    assert [e[0] for e in events] == ["transform.excluded", "transform.computed"]


# --- transform.rank -----------------------------------------------------------------------------


def _rank(values: dict[str, float], **params: bool) -> tuple[dict[str, float | bool], list[str]]:
    view = make_view(_DAYS[:1], {"X": {_D1: 1.0}})
    cross_section = CrossSectionValue.numbers(sorted(values), values)
    outputs, events = invoke(RANK, view=view, params=dict(params), inputs={"values": cross_section})
    ranked = outputs["values"]
    assert isinstance(ranked, CrossSectionValue)
    return ranked.as_dict(), [event_type for event_type, _ in events]


def test_rank_descending_by_default() -> None:
    ranks, _ = _rank({"EFA": 0.2, "QQQ": 0.5, "SPY": 0.3})
    assert ranks == {"QQQ": 1.0, "SPY": 2.0, "EFA": 3.0}


def test_rank_ascending_when_requested() -> None:
    ranks, _ = _rank({"EFA": 0.2, "QQQ": 0.5, "SPY": 0.3}, descending=False)
    assert ranks == {"EFA": 1.0, "SPY": 2.0, "QQQ": 3.0}


def test_rank_ties_break_by_canonical_ticker() -> None:
    ranks, events = _rank({"GLD": 0.2, "EFA": 0.2, "QQQ": 0.5})
    assert ranks == {"QQQ": 1.0, "EFA": 2.0, "GLD": 3.0}  # EFA < GLD alphabetically
    assert "rank.tie_broken" in events


def test_rank_preserves_domain_and_skips_excluded_assets() -> None:
    view = make_view(_DAYS[:1], {"X": {_D1: 1.0}})
    cross_section = CrossSectionValue.numbers(["EFA", "GLD", "QQQ"], {"EFA": 0.1, "QQQ": 0.4})
    outputs, _ = invoke(RANK, view=view, inputs={"values": cross_section})
    ranked = outputs["values"]
    assert isinstance(ranked, CrossSectionValue)
    assert ranked.as_dict() == {"QQQ": 1.0, "EFA": 2.0}
    assert ranked.missing_assets == ("GLD",)  # not ranked, still in the domain


def test_rank_empty_input_is_empty() -> None:
    ranks, events = _rank({})
    assert ranks == {}
    assert events == ["rank.assigned"]
