"""M4.2: pure schedule firing and next-session resolution over the fixture calendar."""

from __future__ import annotations

from datetime import date

from quantize.engine.schedule import schedule_fires, scheduled_sessions
from quantize.schema.schedule import ScheduleDaily, ScheduleMonthly, ScheduleWeekly
from tests.market_fixture import build_fixture_calendar

_CAL = build_fixture_calendar()
_DAILY = ScheduleDaily(kind="daily")
_WEEKLY = ScheduleWeekly(kind="weekly")
_MONTHLY = ScheduleMonthly(kind="monthly")


# --- next_session_after ------------------------------------------------------------------------


def test_next_session_is_strictly_after() -> None:
    nxt = _CAL.next_session_after(date(2026, 5, 11))  # a Monday session
    assert nxt is not None and nxt.session_date == date(2026, 5, 12)


def test_next_session_skips_weekends() -> None:
    nxt = _CAL.next_session_after(date(2026, 5, 8))  # Friday
    assert nxt is not None and nxt.session_date == date(2026, 5, 11)  # Monday


def test_next_session_skips_holidays() -> None:
    nxt = _CAL.next_session_after(date(2026, 4, 2))  # Thursday before Good Friday
    assert nxt is not None and nxt.session_date == date(2026, 4, 6)  # Monday


def test_next_session_none_beyond_coverage() -> None:
    assert _CAL.next_session_after(date(2026, 6, 30)) is None  # last coverage session


def test_next_session_works_from_non_session_dates() -> None:
    nxt = _CAL.next_session_after(date(2026, 5, 9))  # a Saturday
    assert nxt is not None and nxt.session_date == date(2026, 5, 11)


# --- daily -------------------------------------------------------------------------------------


def test_daily_fires_every_session_and_only_sessions() -> None:
    assert scheduled_sessions(_DAILY, _CAL) == _CAL.session_dates
    assert schedule_fires(_DAILY, date(2026, 5, 11), _CAL)
    assert not schedule_fires(_DAILY, date(2026, 5, 9), _CAL)  # Saturday
    assert not schedule_fires(_DAILY, date(2026, 4, 3), _CAL)  # Good Friday holiday


# --- weekly ------------------------------------------------------------------------------------


def test_weekly_fires_on_fridays() -> None:
    assert schedule_fires(_WEEKLY, date(2026, 5, 15), _CAL)  # ordinary Friday
    assert not schedule_fires(_WEEKLY, date(2026, 5, 14), _CAL)  # Thursday of a full week


def test_weekly_fires_thursday_in_a_holiday_shortened_week() -> None:
    # Good Friday 2026-04-03 is a holiday: the last session of that ISO week is Thursday 04-02.
    assert schedule_fires(_WEEKLY, date(2026, 4, 2), _CAL)
    assert not schedule_fires(_WEEKLY, date(2026, 4, 3), _CAL)


def test_weekly_fires_on_truncated_final_week() -> None:
    # Coverage ends Tuesday 2026-06-30 (ISO week 27): the truncated week fires on its last
    # covered session — by design (the calendar is the authority; pinned, not incidental).
    assert schedule_fires(_WEEKLY, date(2026, 6, 30), _CAL)


def test_weekly_year_boundary() -> None:
    # 2025-12-31 (Wednesday) and 2026-01-02 (Friday) are in the same ISO week (2026-W01);
    # 2026-01-01 is a holiday. The week fires on Friday 2026-01-02 only.
    assert not schedule_fires(_WEEKLY, date(2025, 12, 31), _CAL)
    assert schedule_fires(_WEEKLY, date(2026, 1, 2), _CAL)


def test_weekly_no_duplicate_firing() -> None:
    firing = scheduled_sessions(_WEEKLY, _CAL)
    assert len(firing) == len(set(firing))
    assert list(firing) == sorted(firing)


# --- monthly -----------------------------------------------------------------------------------


def test_monthly_fires_on_last_session_of_month() -> None:
    assert schedule_fires(_MONTHLY, date(2026, 4, 30), _CAL)  # Thursday, last April session
    assert not schedule_fires(_MONTHLY, date(2026, 4, 29), _CAL)


def test_monthly_last_may_session_is_friday_29th() -> None:
    # 2026-05-30/31 are a weekend; the last May session is Friday 05-29.
    assert schedule_fires(_MONTHLY, date(2026, 5, 29), _CAL)


def test_monthly_year_boundary() -> None:
    assert schedule_fires(_MONTHLY, date(2025, 12, 31), _CAL)  # Wednesday, last 2025 session
    assert not schedule_fires(_MONTHLY, date(2026, 1, 2), _CAL)
    assert schedule_fires(_MONTHLY, date(2026, 1, 30), _CAL)  # Friday, last January session


def test_monthly_fires_on_final_coverage_session() -> None:
    assert schedule_fires(_MONTHLY, date(2026, 6, 30), _CAL)  # genuine June month-end


def test_monthly_count_matches_coverage_months() -> None:
    firing = scheduled_sessions(_MONTHLY, _CAL)
    assert len(firing) == 18  # 2025-01 .. 2026-06 inclusive


def test_first_calendar_session_does_not_fire_monthly() -> None:
    assert not schedule_fires(_MONTHLY, date(2025, 1, 2), _CAL)


def test_schedule_functions_are_deterministic() -> None:
    assert scheduled_sessions(_WEEKLY, _CAL) == scheduled_sessions(_WEEKLY, _CAL)
    assert scheduled_sessions(_MONTHLY, _CAL) == scheduled_sessions(_MONTHLY, _CAL)
