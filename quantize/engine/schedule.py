"""Pure schedule firing over an exchange calendar (STRATEGY_LANGUAGE.md §6).

``daily`` fires at every valid session; ``weekly`` at the LAST calendar session within each ISO
Monday–Sunday week; ``monthly`` at the LAST calendar session within each calendar month. "Last
valid session of the period" is defined relative to the calendar's session set — the calendar is
the authority on valid sessions, so truncated coverage makes the final partial period fire on its
last covered session (a fixture-authoring concern, pinned by tests).

Pure functions of (schedule, calendar): no wall clock, no state, no duplicate firing.
"""

from __future__ import annotations

from datetime import date

from quantize.market.calendar import ExchangeCalendar
from quantize.schema.schedule import Schedule, ScheduleDaily, ScheduleWeekly


def _period_key(schedule: Schedule, day: date) -> tuple[int, int]:
    if isinstance(schedule, ScheduleWeekly):
        iso = day.isocalendar()
        return (iso.year, iso.week)
    return (day.year, day.month)  # monthly


def scheduled_sessions(schedule: Schedule, calendar: ExchangeCalendar) -> tuple[date, ...]:
    """The session dates on which *schedule* fires, ascending."""
    dates = calendar.session_dates
    if isinstance(schedule, ScheduleDaily):
        return dates
    firing: list[date] = []
    for index, day in enumerate(dates):
        is_last_of_period = index + 1 == len(dates) or _period_key(
            schedule, dates[index + 1]
        ) != _period_key(schedule, day)
        if is_last_of_period:
            firing.append(day)
    return tuple(firing)


def schedule_fires(schedule: Schedule, session_date: date, calendar: ExchangeCalendar) -> bool:
    """Whether *schedule* fires at the close of *session_date* (False for non-session dates)."""
    if calendar.session_on(session_date) is None:
        return False
    if isinstance(schedule, ScheduleDaily):
        return True
    return session_date in scheduled_sessions(schedule, calendar)
