"""Pre-M9 C2: MarketDataCursor — incremental visibility, EXACTLY equal to ``as_of``.

The cursor answers the engine's per-session point queries (latest visible close; session-D
close; session-D open) without materializing the full all-asset view each session. Its gating
must never re-derive the availability rule divergently: every test here compares the cursor's
answer against the ``MarketDataSet.as_of`` view — the single authoritative implementation —
including under vendor-lagged, out-of-session-order availability, exact-boundary instants,
repeated cutoffs, missing observations, and backward queries (which fall back to a fresh view).
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from quantize.engine.backtest import run_backtest
from quantize.engine.state import PortfolioState
from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import DataView, MarketDataCursor, MarketDataSet, PriceObservation
from quantize.nodes import build_core_catalog
from quantize.schema.document import StrategyDocument
from tests.helpers import load_fixture
from tests.market_fixture import build_market_fixture


def _sessions(count: int) -> tuple[MarketSession, ...]:
    days = [date(2026, 2, 2) + timedelta(days=i) for i in range(count)]
    return tuple(
        MarketSession(
            session_date=day,
            open_at=datetime(day.year, day.month, day.day, 14, 30, tzinfo=UTC),
            close_at=datetime(day.year, day.month, day.day, 21, 0, tzinfo=UTC),
        )
        for day in days
    )


def _adversarial_dataset() -> MarketDataSet:
    """Five sessions, three assets, deliberately hostile availability:

    - AAA: normal availability (open at open, close at close).
    - BBB: vendor-lagged CLOSES arriving OUT of session order — session 1's close arrives at
      session 4's close, session 2's close at session 3's close (so the visible set's max
      session date is NOT the last-arrived observation); session 3 has NO observation at all.
    - CCC: an asset with zero observations (in the calendar's universe but never prints).
    """
    sessions = _sessions(5)
    s = sessions

    def obs(i: int, price: float, *, close_avail: datetime | None = None) -> PriceObservation:
        return PriceObservation(
            session_date=s[i].session_date,
            open_price=price,
            close_price=price + 0.5,
            open_available_at=s[i].open_at,
            close_available_at=close_avail or s[i].close_at,
        )

    calendar = ExchangeCalendar(exchange="QSE", timezone="UTC-05:00", sessions=sessions)
    return MarketDataSet(
        calendar=calendar,
        observations={
            "AAA": [obs(0, 10.0), obs(1, 11.0), obs(2, 12.0), obs(3, 13.0), obs(4, 14.0)],
            "BBB": [
                obs(0, 20.0),
                obs(1, 19.0, close_avail=s[3].close_at),  # arrives AFTER session 2's close
                obs(2, 18.0, close_avail=s[2].close_at + timedelta(hours=1)),
                # session 3: no observation (gap)
                obs(4, 16.0),
            ],
            "CCC": [],
        },
    )


def _reference_answers(
    view: DataView, asset: str, day: date
) -> tuple[tuple[date, float] | None, float | None, float | None]:
    """The three engine predicates, computed the way the ENGINE computes them from a view."""
    history = view.close_history(asset)
    latest = history[-1] if history else None
    session_close = history[-1][1] if history and history[-1][0] == day else None
    open_price = view.open_price(asset, day)
    return latest, session_close, open_price


def test_cursor_equals_as_of_at_every_session_boundary_instant() -> None:
    dataset = _adversarial_dataset()
    cursor = MarketDataCursor(dataset)
    assets = ("AAA", "BBB", "CCC")
    for session in dataset.calendar.sessions:
        for instant in (session.open_at, session.close_at):
            view = dataset.as_of(instant)
            for asset in assets:
                latest, session_close, open_price = _reference_answers(
                    view, asset, session.session_date
                )
                assert cursor.latest_close(asset, instant) == latest, (asset, instant)
                assert (
                    cursor.session_close(asset, session.session_date, instant) == session_close
                ), (asset, instant)
                assert cursor.open_price(asset, session.session_date, instant) == open_price, (
                    asset,
                    instant,
                )


def test_cursor_handles_exact_boundary_and_repeated_cutoffs() -> None:
    dataset = _adversarial_dataset()
    cursor = MarketDataCursor(dataset)
    s = dataset.calendar.sessions
    # BBB session-2 close is available at close+1h: invisible AT the close (inclusive <=
    # boundary), visible exactly at the availability instant.
    at_close = s[2].close_at
    at_avail = s[2].close_at + timedelta(hours=1)
    assert cursor.latest_close("BBB", at_close) == (s[0].session_date, 20.5)
    for _ in range(3):  # repeated equal cutoffs are idempotent
        assert cursor.latest_close("BBB", at_avail) == (s[2].session_date, 18.5)
    # Out-of-order late arrival: session 1's close lands at session 3's close and must NOT
    # displace the newer session-2 close as the latest (max session date, not last arrival).
    assert cursor.latest_close("BBB", s[3].close_at) == (s[2].session_date, 18.5)


def test_cursor_backward_query_falls_back_to_exact_view_semantics() -> None:
    dataset = _adversarial_dataset()
    cursor = MarketDataCursor(dataset)
    s = dataset.calendar.sessions
    cursor.latest_close("AAA", s[4].close_at)  # drive the cursor forward first
    for session in dataset.calendar.sessions:  # then query strictly backward
        for instant in (session.open_at, session.close_at):
            view = dataset.as_of(instant)
            for asset in ("AAA", "BBB", "CCC"):
                latest, session_close, open_price = _reference_answers(
                    view, asset, session.session_date
                )
                assert cursor.latest_close(asset, instant) == latest
                assert cursor.session_close(asset, session.session_date, instant) == session_close
                assert cursor.open_price(asset, session.session_date, instant) == open_price


def test_independent_cursors_do_not_share_state() -> None:
    dataset = _adversarial_dataset()
    first = MarketDataCursor(dataset)
    second = MarketDataCursor(dataset)
    s = dataset.calendar.sessions
    first.latest_close("AAA", s[4].close_at)
    # The second cursor's visibility is its own: an early query is unaffected by the first's
    # position (and both still exactly match as_of).
    view = dataset.as_of(s[0].close_at)
    assert second.latest_close("AAA", s[0].close_at) == view.close_history("AAA")[-1]


def test_engine_builds_full_views_only_at_evaluation_instants() -> None:
    """The C2 mechanism assertion: a backtest constructs DataViews ONLY for evaluations
    (the evaluator's as_of), never per session — valuation, planning prices, and fills read
    through the run's cursor."""
    import quantize.market.data as market_data_module

    calls = {"n": 0}
    original = market_data_module.MarketDataSet.as_of

    def counting(self: MarketDataSet, instant: datetime) -> DataView:
        calls["n"] += 1
        return original(self, instant)

    market_data_module.MarketDataSet.as_of = counting  # type: ignore[method-assign]
    try:
        document = StrategyDocument.model_validate(load_fixture("strategy_b"))
        result = run_backtest(
            document,
            catalog=build_core_catalog(),
            market_data=build_market_fixture(),
            run_id="3b000000-0000-0000-0000-000000000002",
            initial_state=PortfolioState(cash=1_000_000.0),
        )
    finally:
        market_data_module.MarketDataSet.as_of = original  # type: ignore[method-assign]
    assert result.ok
    assert calls["n"] == len(result.evaluations)  # 37 — not 448 (one per session + extras)
