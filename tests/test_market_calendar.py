"""M3-PRE: exchange calendar and market-session invariants."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from quantize.market.calendar import ExchangeCalendar, MarketSession
from tests.market_fixture import build_fixture_calendar


def _session(day: date, open_hour: int = 14, close_hour: int = 21) -> MarketSession:
    return MarketSession(
        session_date=day,
        open_at=datetime(day.year, day.month, day.day, open_hour, 30, tzinfo=UTC),
        close_at=datetime(day.year, day.month, day.day, close_hour, 0, tzinfo=UTC),
    )


def test_session_rejects_naive_instants() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        MarketSession(
            session_date=date(2026, 1, 5),
            open_at=datetime(2026, 1, 5, 14, 30),
            close_at=datetime(2026, 1, 5, 21, 0, tzinfo=UTC),
        )


def test_session_normalizes_instants_to_utc() -> None:
    from datetime import timezone

    eastern = timezone(timedelta(hours=-5))
    session = MarketSession(
        session_date=date(2026, 1, 5),
        open_at=datetime(2026, 1, 5, 9, 30, tzinfo=eastern),
        close_at=datetime(2026, 1, 5, 16, 0, tzinfo=eastern),
    )
    assert session.open_at == datetime(2026, 1, 5, 14, 30, tzinfo=UTC)
    assert session.close_at == datetime(2026, 1, 5, 21, 0, tzinfo=UTC)


def test_session_must_open_before_close() -> None:
    with pytest.raises(ValueError, match="open before it closes"):
        MarketSession(
            session_date=date(2026, 1, 5),
            open_at=datetime(2026, 1, 5, 21, 0, tzinfo=UTC),
            close_at=datetime(2026, 1, 5, 14, 30, tzinfo=UTC),
        )


def test_calendar_rejects_non_increasing_dates() -> None:
    with pytest.raises(ValueError, match="strictly increasing"):
        ExchangeCalendar(
            exchange="QSE",
            timezone="UTC-05:00",
            sessions=(_session(date(2026, 1, 6)), _session(date(2026, 1, 6))),
        )


def test_calendar_rejects_overlapping_sessions() -> None:
    # First session closes after the second opens (crossing midnight into 2026-01-06).
    spilling = MarketSession(
        session_date=date(2026, 1, 5),
        open_at=datetime(2026, 1, 5, 14, 30, tzinfo=UTC),
        close_at=datetime(2026, 1, 6, 15, 0, tzinfo=UTC),
    )
    with pytest.raises(ValueError, match="overlap"):
        ExchangeCalendar(
            exchange="QSE",
            timezone="UTC-05:00",
            sessions=(spilling, _session(date(2026, 1, 6))),
        )


def test_sessions_closed_by_is_inclusive_at_the_close_instant() -> None:
    calendar = ExchangeCalendar(
        exchange="QSE", timezone="UTC-05:00", sessions=(_session(date(2026, 1, 5)),)
    )
    close = datetime(2026, 1, 5, 21, 0, tzinfo=UTC)
    assert calendar.sessions_closed_by(close - timedelta(seconds=1)) == ()
    assert [s.session_date for s in calendar.sessions_closed_by(close)] == [date(2026, 1, 5)]


def test_last_closed_session_none_before_first_close() -> None:
    calendar = ExchangeCalendar(
        exchange="QSE", timezone="UTC-05:00", sessions=(_session(date(2026, 1, 5)),)
    )
    assert calendar.last_closed_session(datetime(2026, 1, 5, 15, 0, tzinfo=UTC)) is None


# --- the committed fixture calendar -----------------------------------------------------------


def test_fixture_calendar_skips_weekends() -> None:
    calendar = build_fixture_calendar()
    assert all(s.session_date.weekday() < 5 for s in calendar.sessions)
    # Friday 2026-05-08 is followed by Monday 2026-05-11 (weekend gap).
    dates = calendar.session_dates
    index = dates.index(date(2026, 5, 8))
    assert dates[index + 1] == date(2026, 5, 11)


def test_fixture_calendar_skips_holidays() -> None:
    dates = build_fixture_calendar().session_dates
    assert date(2026, 4, 3) not in dates  # Good Friday closure
    index = dates.index(date(2026, 4, 2))  # Thursday before
    assert dates[index + 1] == date(2026, 4, 6)  # next valid session is Monday


def test_fixture_calendar_has_warmup_depth() -> None:
    # Strategy B needs a 200-session moving-average window; the fixture must exceed it well
    # before its end so single-instant evaluations in 2026 are warm.
    calendar = build_fixture_calendar()
    assert len(calendar.sessions) > 300


def test_fixture_calendar_session_instants() -> None:
    session = build_fixture_calendar().sessions[0]
    assert session.session_date == date(2025, 1, 2)
    assert session.open_at == datetime(2025, 1, 2, 14, 30, tzinfo=UTC)  # 09:30 UTC-05:00
    assert session.close_at == datetime(2025, 1, 2, 21, 0, tzinfo=UTC)  # 16:00 UTC-05:00
