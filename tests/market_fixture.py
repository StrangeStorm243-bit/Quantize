"""The deterministic synthetic market-data fixture (M3-PRE).

One synthetic exchange ("QSE") with a fixed UTC-05:00 offset (no DST — deliberately synthetic so
the fixture is deterministic on every platform with no tz-database dependency): sessions open
09:30 local (14:30Z) and close 16:00 local (21:00Z) on every weekday that is not a listed holiday,
from 2025-01-02 through 2026-06-30. The calendar therefore contains weekend gaps and several
holiday boundaries (e.g. Good Friday 2026-04-03).

Prices are exact geometric paths so every derived number is hand-computable: asset ``a`` closes at
``100 * GROWTH[a] ** i`` on the session with calendar index ``i`` (opens are the prior session's
close level, ``close / GROWTH[a]``). Availability is honest: an open is available at the session
open instant, a close at the session close instant.

Two deliberate data irregularities exercise missing-data rules:

* ``GLD`` lists late — its first observation is calendar session index ``GLD_START_INDEX`` (60);
  before ``60 + lookback`` sessions of history exist, warm-up-sensitive nodes must exclude it.
* ``IWM`` has NO observation on 2026-05-15 (one missing session mid-history); nodes must exclude
  it at that session rather than reuse a stale price.

Trailing-return ordering is fixed by construction (return over L sessions = ``GROWTH**L - 1``):
QQQ > SPY > IWM > EFA > GLD > AGG > TLT > VNQ. Rising assets (growth > 1) close above their
200-session moving average; falling ones (TLT, VNQ) close below it.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta

from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataSet, PriceObservation

FIXTURE_EXCHANGE = "QSE"
FIXTURE_TIMEZONE = "UTC-05:00"  # synthetic fixed offset; documented above
_UTC_OFFSET = timedelta(hours=-5)
_LOCAL_OPEN = time(9, 30)
_LOCAL_CLOSE = time(16, 0)

FIXTURE_START = date(2025, 1, 2)
FIXTURE_END = date(2026, 6, 30)

# Explicit holiday list (synthetic exchange; chosen to include mid-week and Friday closures).
FIXTURE_HOLIDAYS: frozenset[date] = frozenset(
    {
        date(2025, 1, 20),  # Monday
        date(2025, 2, 17),  # Monday
        date(2025, 4, 18),  # Friday (Good Friday)
        date(2025, 5, 26),  # Monday
        date(2025, 6, 19),  # Thursday
        date(2025, 7, 4),  # Friday
        date(2025, 9, 1),  # Monday
        date(2025, 11, 27),  # Thursday
        date(2025, 12, 25),  # Thursday
        date(2026, 1, 1),  # Thursday
        date(2026, 1, 19),  # Monday
        date(2026, 2, 16),  # Monday
        date(2026, 4, 3),  # Friday (Good Friday)
        date(2026, 5, 25),  # Monday
        date(2026, 6, 19),  # Friday
    }
)

BASE_PRICE = 100.0
# Per-session geometric growth factors. Distinct per asset so rankings are strict.
GROWTH: dict[str, float] = {
    "AGG": 1.0001,
    "EFA": 1.0004,
    "GLD": 1.0002,
    "IWM": 1.0008,
    "QQQ": 1.0016,
    "SPY": 1.0012,
    "TLT": 0.9996,
    "VNQ": 0.9992,
}

GLD_START_INDEX = 60  # GLD's first observed calendar session index (late listing)
IWM_MISSING_DATE = date(2026, 5, 15)  # IWM has no observation this session (a Friday)


def _local_instant(day: date, local: time) -> datetime:
    """The UTC instant of a fixture-exchange local wall time on *day*."""
    return datetime.combine(day, local).replace(tzinfo=UTC) - _UTC_OFFSET


def build_fixture_calendar(
    start: date = FIXTURE_START, end: date = FIXTURE_END
) -> ExchangeCalendar:
    """Every weekday in [start, end] that is not a fixture holiday, as a market session."""
    sessions: list[MarketSession] = []
    day = start
    while day <= end:
        if day.weekday() < 5 and day not in FIXTURE_HOLIDAYS:
            sessions.append(
                MarketSession(
                    session_date=day,
                    open_at=_local_instant(day, _LOCAL_OPEN),
                    close_at=_local_instant(day, _LOCAL_CLOSE),
                )
            )
        day += timedelta(days=1)
    return ExchangeCalendar(
        exchange=FIXTURE_EXCHANGE, timezone=FIXTURE_TIMEZONE, sessions=tuple(sessions)
    )


def fixture_close(asset: str, calendar_index: int) -> float:
    """The exact fixture close for *asset* at calendar session index *calendar_index*."""
    return BASE_PRICE * GROWTH[asset] ** calendar_index


def build_market_fixture() -> MarketDataSet:
    """The full deterministic dataset (see module docstring for its irregularities)."""
    calendar = build_fixture_calendar()
    observations: dict[str, list[PriceObservation]] = {}
    for asset, growth in GROWTH.items():
        series: list[PriceObservation] = []
        for index, session in enumerate(calendar.sessions):
            if asset == "GLD" and index < GLD_START_INDEX:
                continue
            if asset == "IWM" and session.session_date == IWM_MISSING_DATE:
                continue
            close = fixture_close(asset, index)
            series.append(
                PriceObservation(
                    session_date=session.session_date,
                    open_price=close / growth,
                    close_price=close,
                    open_available_at=session.open_at,
                    close_available_at=session.close_at,
                )
            )
        observations[asset] = series
    return MarketDataSet(calendar=calendar, observations=observations)
