"""Exchange calendar and market sessions — the deterministic temporal backbone (M3-PRE).

A ``MarketSession`` is one valid trading session: its exchange-local trading date plus its open and
close instants (timezone-aware, normalized to UTC). An ``ExchangeCalendar`` is the ordered set of
valid sessions for one exchange; weekends/holidays simply have no session. "D+1" (the next valid
session) is calendar arithmetic over this structure — never "next calendar day".

These are frozen runtime value objects (like ``NodeResolution``), not persisted IR.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime


def require_aware_utc(instant: datetime, label: str) -> datetime:
    """Normalize an aware datetime to UTC; reject naive datetimes loudly."""
    if instant.tzinfo is None or instant.tzinfo.utcoffset(instant) is None:
        raise ValueError(f"{label} must be timezone-aware")
    return instant.astimezone(UTC)


@dataclass(frozen=True)
class MarketSession:
    """One valid trading session: the exchange-local trading date and its open/close instants."""

    session_date: date
    open_at: datetime
    close_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "open_at", require_aware_utc(self.open_at, "open_at"))
        object.__setattr__(self, "close_at", require_aware_utc(self.close_at, "close_at"))
        if not self.open_at < self.close_at:
            raise ValueError(f"session {self.session_date.isoformat()} must open before it closes")


@dataclass(frozen=True)
class ExchangeCalendar:
    """The ordered valid sessions of one exchange, with the timezone that defines local dates.

    ``timezone`` is recorded for run reproducibility (the run record preserves calendar +
    timezone); session instants are already normalized to UTC, so no tz database lookup is
    performed at runtime.
    """

    exchange: str
    timezone: str
    sessions: tuple[MarketSession, ...]

    def __post_init__(self) -> None:
        if not self.exchange:
            raise ValueError("exchange must be non-empty")
        if not self.timezone:
            raise ValueError("timezone must be non-empty")
        previous: MarketSession | None = None
        for session in self.sessions:
            if previous is not None:
                if not previous.session_date < session.session_date:
                    raise ValueError("session dates must be strictly increasing")
                if not previous.close_at <= session.open_at:
                    raise ValueError("sessions must not overlap in time")
            previous = session

    @property
    def session_dates(self) -> tuple[date, ...]:
        return tuple(session.session_date for session in self.sessions)

    def sessions_closed_by(self, instant: datetime) -> tuple[MarketSession, ...]:
        """All sessions whose close instant is <= *instant* (the close-visible sessions)."""
        cutoff = require_aware_utc(instant, "instant")
        return tuple(session for session in self.sessions if session.close_at <= cutoff)

    def last_closed_session(self, instant: datetime) -> MarketSession | None:
        """The most recent session whose close is <= *instant*, or ``None`` before the first."""
        closed = self.sessions_closed_by(instant)
        return closed[-1] if closed else None

    def session_on(self, session_date: date) -> MarketSession | None:
        """The session trading on *session_date*, or ``None`` if that date has no session."""
        for session in self.sessions:
            if session.session_date == session_date:
                return session
        return None

    def next_session_after(self, session_date: date) -> MarketSession | None:
        """The first session STRICTLY after *session_date* ("D+1" = next valid session).

        Weekends/holidays are skipped by construction (they are simply not sessions). Returns
        ``None`` beyond calendar coverage — the calendar is never silently extended.
        """
        for session in self.sessions:
            if session.session_date > session_date:
                return session
        return None
