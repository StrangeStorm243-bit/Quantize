"""Harness for invoking real node implementations directly with hand-built inputs."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta

from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import DataView, MarketDataSet, PriceObservation
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import RuntimeValue
from quantize.schema.primitives import JsonValue

TraceLog = list[tuple[str, Mapping[str, JsonValue]]]


def business_days(count: int, start: date = date(2026, 1, 5)) -> list[date]:
    """*count* consecutive weekdays starting at *start* (2026-01-05 is a Monday)."""
    days: list[date] = []
    day = start
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return days


def _session(day: date) -> MarketSession:
    return MarketSession(
        session_date=day,
        open_at=datetime(day.year, day.month, day.day, 14, 30, tzinfo=UTC),
        close_at=datetime(day.year, day.month, day.day, 21, 0, tzinfo=UTC),
    )


def make_dataset(
    session_days: list[date], closes: Mapping[str, Mapping[date, float]]
) -> MarketDataSet:
    """A dataset over the given sessions; each asset observes only the dates it lists."""
    sessions = tuple(_session(day) for day in session_days)
    calendar = ExchangeCalendar(exchange="QSE", timezone="UTC-05:00", sessions=sessions)
    by_date = {session.session_date: session for session in sessions}
    observations = {
        asset: [
            PriceObservation(
                session_date=day,
                open_price=asset_closes[day],
                close_price=asset_closes[day],
                open_available_at=by_date[day].open_at,
                close_available_at=by_date[day].close_at,
            )
            for day in sorted(asset_closes)
        ]
        for asset, asset_closes in closes.items()
    }
    return MarketDataSet(calendar=calendar, observations=observations)


def make_view(
    session_days: list[date],
    closes: Mapping[str, Mapping[date, float]],
    *,
    at: date | None = None,
) -> DataView:
    """An as-of view at the close of *at* (default: the last session)."""
    dataset = make_dataset(session_days, closes)
    day = at if at is not None else session_days[-1]
    return dataset.as_of(datetime(day.year, day.month, day.day, 21, 0, tzinfo=UTC))


def invoke(
    implementation: NodeImplementation,
    *,
    view: DataView,
    params: Mapping[str, JsonValue] | None = None,
    inputs: Mapping[str, RuntimeValue] | None = None,
    node_id: str = "n",
) -> tuple[Mapping[str, RuntimeValue], TraceLog]:
    """Invoke one implementation directly; returns (outputs, emitted trace events)."""
    events: TraceLog = []

    def sink(event_type: str, payload: Mapping[str, JsonValue]) -> None:
        events.append((event_type, dict(payload)))

    invocation = NodeInvocation(
        node_id=node_id,
        component_path=(),
        params=params or {},
        inputs=inputs or {},
        view=view,
        trace=sink,
    )
    return implementation.evaluate(invocation), events
