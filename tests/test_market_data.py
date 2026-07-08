"""M3-PRE: dataset contract enforcement and availability-gated as-of views (look-ahead safety)."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataSet, PriceObservation
from tests.market_fixture import (
    GLD_START_INDEX,
    IWM_MISSING_DATE,
    build_market_fixture,
    fixture_close,
)


def _session(day: date) -> MarketSession:
    return MarketSession(
        session_date=day,
        open_at=datetime(day.year, day.month, day.day, 14, 30, tzinfo=UTC),
        close_at=datetime(day.year, day.month, day.day, 21, 0, tzinfo=UTC),
    )


_D1 = date(2026, 1, 5)
_D2 = date(2026, 1, 6)
_CALENDAR = ExchangeCalendar(
    exchange="QSE", timezone="UTC-05:00", sessions=(_session(_D1), _session(_D2))
)


def _observation(
    day: date,
    close: float = 101.0,
    close_available_at: datetime | None = None,
) -> PriceObservation:
    session = _CALENDAR.session_on(day)
    assert session is not None
    return PriceObservation(
        session_date=day,
        open_price=100.0,
        close_price=close,
        open_available_at=session.open_at,
        close_available_at=close_available_at or session.close_at,
    )


# --- dataset construction contract ------------------------------------------------------------


def test_dataset_rejects_empty_calendar() -> None:
    """A market dataset must have at least one session — an empty calendar is not backtestable
    and has no first/last session (M13.1 introspection guard)."""
    empty = ExchangeCalendar(exchange="QSE", timezone="UTC-05:00", sessions=())
    with pytest.raises(ValueError, match="at least one session"):
        MarketDataSet(calendar=empty, observations={})


def test_dataset_rejects_observation_off_calendar() -> None:
    stray = date(2026, 1, 7)
    observation = PriceObservation(
        session_date=stray,
        open_price=100.0,
        close_price=101.0,
        open_available_at=datetime(2026, 1, 7, 14, 30, tzinfo=UTC),
        close_available_at=datetime(2026, 1, 7, 21, 0, tzinfo=UTC),
    )
    with pytest.raises(ValueError, match="not a calendar session"):
        MarketDataSet(calendar=_CALENDAR, observations={"SPY": [observation]})


def test_dataset_rejects_non_increasing_observations() -> None:
    with pytest.raises(ValueError, match="strictly increasing"):
        MarketDataSet(
            calendar=_CALENDAR, observations={"SPY": [_observation(_D1), _observation(_D1)]}
        )


def test_dataset_rejects_close_available_before_the_close() -> None:
    early = datetime(2026, 1, 5, 20, 59, tzinfo=UTC)  # one minute before the session close
    with pytest.raises(ValueError, match="available before the session closes"):
        MarketDataSet(
            calendar=_CALENDAR,
            observations={"SPY": [_observation(_D1, close_available_at=early)]},
        )


@pytest.mark.parametrize("bad_price", [0.0, -1.0, float("nan"), float("inf")])
def test_observation_rejects_non_positive_or_non_finite_prices(bad_price: float) -> None:
    with pytest.raises(ValueError, match="finite and positive"):
        _observation(_D1, close=bad_price)


def test_dataset_assets_are_sorted() -> None:
    dataset = MarketDataSet(
        calendar=_CALENDAR,
        observations={"SPY": [_observation(_D1)], "AGG": [_observation(_D1)]},
    )
    assert dataset.assets == ("AGG", "SPY")


def test_dataset_copies_observations_against_later_mutation() -> None:
    series = [_observation(_D1)]
    dataset = MarketDataSet(calendar=_CALENDAR, observations={"SPY": series})
    series.append(_observation(_D2))
    view = dataset.as_of(datetime(2026, 1, 6, 21, 0, tzinfo=UTC))
    assert len(view.close_history("SPY")) == 1


# --- as-of gating (the temporal boundary) ------------------------------------------------------


def _two_day_dataset() -> MarketDataSet:
    return MarketDataSet(
        calendar=_CALENDAR,
        observations={"SPY": [_observation(_D1, close=101.0), _observation(_D2, close=102.0)]},
    )


def test_view_at_close_includes_that_close_exactly_at_cutoff() -> None:
    view = _two_day_dataset().as_of(datetime(2026, 1, 5, 21, 0, tzinfo=UTC))
    assert view.session_dates == (_D1,)
    assert view.latest_session_date == _D1
    assert view.close_history("SPY") == ((_D1, 101.0),)


def test_view_before_close_excludes_that_session_entirely() -> None:
    view = _two_day_dataset().as_of(datetime(2026, 1, 5, 20, 59, tzinfo=UTC))
    assert view.session_dates == ()
    assert view.latest_session_date is None
    assert view.close_history("SPY") == ()


def test_future_observation_is_inaccessible() -> None:
    view = _two_day_dataset().as_of(datetime(2026, 1, 5, 21, 0, tzinfo=UTC))
    assert all(day <= _D1 for day, _ in view.close_history("SPY"))


def test_gating_uses_availability_not_session_date() -> None:
    # A delayed close (vendor lag): the session has closed, but the observation only becomes
    # available the next day. The session is visible; the observation is not.
    delayed = _observation(_D1, close_available_at=datetime(2026, 1, 6, 9, 0, tzinfo=UTC))
    dataset = MarketDataSet(calendar=_CALENDAR, observations={"SPY": [delayed]})
    at_close = dataset.as_of(datetime(2026, 1, 5, 21, 0, tzinfo=UTC))
    assert at_close.session_dates == (_D1,)
    assert at_close.close_history("SPY") == ()  # no silent substitution — simply absent
    next_day = dataset.as_of(datetime(2026, 1, 6, 9, 0, tzinfo=UTC))
    assert next_day.close_history("SPY") == ((_D1, 101.0),)


def test_view_rejects_naive_instant() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        _two_day_dataset().as_of(datetime(2026, 1, 5, 21, 0))


def test_unknown_asset_has_empty_history() -> None:
    view = _two_day_dataset().as_of(datetime(2026, 1, 6, 21, 0, tzinfo=UTC))
    assert view.close_history("QQQ") == ()


# --- the committed fixture dataset -------------------------------------------------------------


def test_fixture_prices_are_exact_geometric_paths() -> None:
    dataset = build_market_fixture()
    session = dataset.calendar.sessions[10]
    view = dataset.as_of(session.close_at)
    history = dict(view.close_history("QQQ"))
    assert history[session.session_date] == pytest.approx(fixture_close("QQQ", 10), abs=0.0)


def test_fixture_gld_lists_late() -> None:
    dataset = build_market_fixture()
    first_gld = dataset.observations["GLD"][0]
    assert first_gld.session_date == dataset.calendar.sessions[GLD_START_INDEX].session_date


def test_fixture_iwm_has_one_missing_session() -> None:
    dataset = build_market_fixture()
    iwm_dates = {obs.session_date for obs in dataset.observations["IWM"]}
    assert IWM_MISSING_DATE in dataset.calendar.session_dates
    assert IWM_MISSING_DATE not in iwm_dates
    # Neighbouring sessions are present — one missing observation, not a truncated series.
    dates = dataset.calendar.session_dates
    index = dates.index(IWM_MISSING_DATE)
    assert dates[index - 1] in iwm_dates and dates[index + 1] in iwm_dates


def test_fixture_is_deterministic_across_builds() -> None:
    first = build_market_fixture()
    second = build_market_fixture()
    assert first == second
