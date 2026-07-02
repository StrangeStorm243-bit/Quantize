"""M4.3: availability-gated open-price access on the as-of DataView."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataSet, PriceObservation

_D1 = date(2026, 1, 5)
_D2 = date(2026, 1, 6)


def _session(day: date) -> MarketSession:
    return MarketSession(
        session_date=day,
        open_at=datetime(day.year, day.month, day.day, 14, 30, tzinfo=UTC),
        close_at=datetime(day.year, day.month, day.day, 21, 0, tzinfo=UTC),
    )


_CAL = ExchangeCalendar(
    exchange="QSE", timezone="UTC-05:00", sessions=(_session(_D1), _session(_D2))
)


def _obs(
    day: date,
    open_price: float,
    close_price: float,
    open_available_at: datetime | None = None,
) -> PriceObservation:
    session = _CAL.session_on(day)
    assert session is not None
    return PriceObservation(
        session_date=day,
        open_price=open_price,
        close_price=close_price,
        open_available_at=open_available_at or session.open_at,
        close_available_at=session.close_at,
    )


def _dataset() -> MarketDataSet:
    return MarketDataSet(
        calendar=_CAL,
        observations={"SPY": [_obs(_D1, 100.0, 101.0), _obs(_D2, 102.0, 103.0)]},
    )


_D2_OPEN = datetime(2026, 1, 6, 14, 30, tzinfo=UTC)


def test_open_visible_exactly_at_open_available_at() -> None:
    view = _dataset().as_of(_D2_OPEN)
    assert view.open_price("SPY", _D2) == 102.0


def test_open_hidden_one_second_before_availability() -> None:
    view = _dataset().as_of(_D2_OPEN - timedelta(seconds=1))
    assert view.open_price("SPY", _D2) is None


def test_view_at_open_hides_that_sessions_close() -> None:
    view = _dataset().as_of(_D2_OPEN)
    # D2's open is visible; D2's close is not (close_at > open instant); D1's close is.
    assert view.open_price("SPY", _D2) == 102.0
    assert view.close_history("SPY") == ((_D1, 101.0),)
    assert view.latest_session_date == _D1  # D2 has not CLOSED yet


def test_delayed_open_availability_gates_correctly() -> None:
    late = datetime(2026, 1, 6, 15, 0, tzinfo=UTC)  # 30 minutes after the open
    dataset = MarketDataSet(
        calendar=_CAL,
        observations={"SPY": [_obs(_D2, 102.0, 103.0, open_available_at=late)]},
    )
    assert dataset.as_of(_D2_OPEN).open_price("SPY", _D2) is None
    assert dataset.as_of(late).open_price("SPY", _D2) == 102.0


def test_missing_open_is_none_never_a_substitute() -> None:
    view = _dataset().as_of(datetime(2026, 1, 6, 21, 0, tzinfo=UTC))
    assert view.open_price("SPY", date(2026, 1, 7)) is None  # not a session
    assert view.open_price("QQQ", _D2) is None  # unknown asset
    # exact-session semantics: asking for D2 never returns D1's open
    dataset = MarketDataSet(calendar=_CAL, observations={"SPY": [_obs(_D1, 100.0, 101.0)]})
    assert dataset.as_of(_D2_OPEN).open_price("SPY", _D2) is None


def test_future_session_open_inaccessible() -> None:
    view = _dataset().as_of(datetime(2026, 1, 5, 21, 0, tzinfo=UTC))  # D1 close
    assert view.open_price("SPY", _D2) is None


def test_open_access_preserves_canonical_asset_ordering() -> None:
    dataset = MarketDataSet(
        calendar=_CAL,
        observations={
            "SPY": [_obs(_D1, 100.0, 101.0)],
            "AGG": [_obs(_D1, 50.0, 51.0)],
        },
    )
    view = dataset.as_of(datetime(2026, 1, 5, 21, 0, tzinfo=UTC))
    assert view.assets == ("AGG", "SPY")
    assert view.open_price("AGG", _D1) == 50.0
    assert view.open_price("SPY", _D1) == 100.0


def test_close_gating_unchanged_by_open_extension() -> None:
    # Regression guard: the M3 close boundary is untouched by the opens extension.
    view = _dataset().as_of(datetime(2026, 1, 5, 20, 59, tzinfo=UTC))
    assert view.close_history("SPY") == ()
    assert view.session_dates == ()


@pytest.mark.parametrize("day", [_D1, _D2])
def test_open_matches_observation(day: date) -> None:
    view = _dataset().as_of(datetime(2026, 1, 6, 21, 0, tzinfo=UTC))
    expected = {_D1: 100.0, _D2: 102.0}[day]
    assert view.open_price("SPY", day) == expected
