"""The deterministic market dataset and the availability-gated as-of ``DataView`` (M3-PRE).

Fixture data contract (docs/ARCHITECTURE.md §6): a dataset carries an exchange calendar, per-asset
open/close prices aligned to that calendar's sessions, and an explicit **availability timestamp**
per observed price. Construction enforces the contract loudly:

* every observation's date is a valid calendar session date, strictly increasing per asset;
* prices are finite and positive (no corporate actions, unambiguous prices);
* an open/close price is never *available* before its session opens/closes (data cannot be
  knowable before it exists) — delayed availability (vendor lag) is permitted.

``MarketDataSet.as_of(instant)`` is the ONLY way to read prices at evaluation time. It constructs
a ``DataView`` containing exactly the observations whose availability is <= the instant, so a node
holding a view is *structurally* unable to read the future through it. This constrains — but does
not categorically eliminate — look-ahead (a wrong availability timestamp still lies), which is why
the gating itself is tested.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime

from quantize.market.calendar import ExchangeCalendar, require_aware_utc


def _require_positive_finite(value: float, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number")
    value = float(value)
    if not math.isfinite(value) or value <= 0.0:
        raise ValueError(f"{label} must be finite and positive, got {value!r}")
    return value


@dataclass(frozen=True)
class PriceObservation:
    """One session's open/close prices for one asset, with explicit availability instants."""

    session_date: date
    open_price: float
    close_price: float
    open_available_at: datetime
    close_available_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "open_price", _require_positive_finite(self.open_price, "open_price")
        )
        object.__setattr__(
            self, "close_price", _require_positive_finite(self.close_price, "close_price")
        )
        object.__setattr__(
            self,
            "open_available_at",
            require_aware_utc(self.open_available_at, "open_available_at"),
        )
        object.__setattr__(
            self,
            "close_available_at",
            require_aware_utc(self.close_available_at, "close_available_at"),
        )


@dataclass(frozen=True)
class MarketDataSet:
    """An immutable calendar-aligned price dataset; read at evaluation time via ``as_of``."""

    calendar: ExchangeCalendar
    observations: Mapping[str, Sequence[PriceObservation]]

    def __post_init__(self) -> None:
        if not self.calendar.sessions:
            raise ValueError("a market dataset must contain at least one session")
        sessions_by_date = {s.session_date: s for s in self.calendar.sessions}
        normalized: dict[str, tuple[PriceObservation, ...]] = {}
        for asset in sorted(self.observations):
            if not asset:
                raise ValueError("asset identifiers must be non-empty")
            series = tuple(self.observations[asset])
            previous: date | None = None
            for observation in series:
                session = sessions_by_date.get(observation.session_date)
                if session is None:
                    raise ValueError(
                        f"asset {asset!r} has an observation on "
                        f"{observation.session_date.isoformat()}, which is not a calendar session"
                    )
                if previous is not None and not previous < observation.session_date:
                    raise ValueError(f"asset {asset!r} observations must be strictly increasing")
                if observation.open_available_at < session.open_at:
                    raise ValueError(
                        f"asset {asset!r} open on {observation.session_date.isoformat()} would be"
                        " available before the session opens"
                    )
                if observation.close_available_at < session.close_at:
                    raise ValueError(
                        f"asset {asset!r} close on {observation.session_date.isoformat()} would be"
                        " available before the session closes"
                    )
                previous = observation.session_date
            normalized[asset] = series
        # Freeze a canonical (sorted-key) copy so later caller mutation cannot reach us.
        object.__setattr__(self, "observations", normalized)

    @property
    def assets(self) -> tuple[str, ...]:
        return tuple(self.observations)  # construction sorted the keys

    def as_of(self, instant: datetime) -> DataView:
        """Build the availability-gated view of this dataset at *instant* (aware datetime)."""
        cutoff = require_aware_utc(instant, "instant")
        visible_sessions = tuple(
            session.session_date for session in self.calendar.sessions_closed_by(cutoff)
        )
        closes = tuple(
            (
                asset,
                tuple(
                    (observation.session_date, observation.close_price)
                    for observation in series
                    if observation.close_available_at <= cutoff
                ),
            )
            for asset, series in self.observations.items()
        )
        opens = tuple(
            (
                asset,
                tuple(
                    (observation.session_date, observation.open_price)
                    for observation in series
                    if observation.open_available_at <= cutoff
                ),
            )
            for asset, series in self.observations.items()
        )
        return DataView(
            instant=cutoff, session_dates=visible_sessions, _closes=closes, _opens=opens
        )


@dataclass(frozen=True)
class DataView:
    """Everything knowable from a dataset at one instant — and nothing more.

    ``session_dates`` are the calendar sessions whose close is <= the instant (the sessions a
    close-based signal may reason over); ``close_history`` returns only close observations whose
    availability is <= the instant. Constructed exclusively by ``MarketDataSet.as_of``.
    """

    instant: datetime
    session_dates: tuple[date, ...]
    _closes: tuple[tuple[str, tuple[tuple[date, float], ...]], ...] = field(repr=False)
    # Availability-gated opens (M4): visible iff open_available_at <= instant. A view taken AT a
    # session's open therefore exposes that session's open but not its close.
    _opens: tuple[tuple[str, tuple[tuple[date, float], ...]], ...] = field(repr=False, default=())

    @property
    def latest_session_date(self) -> date | None:
        """The most recent close-visible session date, or ``None`` before the first close."""
        return self.session_dates[-1] if self.session_dates else None

    @property
    def assets(self) -> tuple[str, ...]:
        """Assets the underlying dataset carries (sorted), regardless of visible history."""
        return tuple(asset for asset, _ in self._closes)

    def close_history(self, asset: str) -> tuple[tuple[date, float], ...]:
        """The visible (date, close) history for *asset*, ascending; ``()`` if none/unknown."""
        for candidate, series in self._closes:
            if candidate == asset:
                return series
        return ()

    def open_price(self, asset: str, session_date: date) -> float | None:
        """The visible open for *asset* AT exactly *session_date*, or ``None``.

        Answers only for the exact (asset, session) requested — a missing or not-yet-available
        open is ``None``, never a stale or prior-session substitute.
        """
        for candidate, series in self._opens:
            if candidate == asset:
                for day, price in series:
                    if day == session_date:
                        return price
                return None
        return None


class MarketDataCursor:
    """Runner-local incremental visibility over ONE dataset for ascending instants (pre-M9 C2).

    The engine's per-session needs are three point queries — the latest visible close
    (valuation marks), the session-D close (planning prices), and the session-D open (fills).
    Building the full all-asset ``as_of`` view per session just to answer them is
    O(observations) per call; this cursor answers them incrementally by pre-sorting every
    observation by its availability instant and incorporating arrivals once as the cutoff
    advances.

    Exactness contract: every answer equals what ``dataset.as_of(instant)`` would expose —
    property-tested against ``as_of`` (tests/test_market_cursor.py), never re-derived
    divergently. The data contract permits arbitrary vendor lag, so arrivals may be OUT of
    session order: the latest close tracks the maximum session date over the VISIBLE set, not
    the most recent arrival. A strictly earlier (backward) instant falls back to a fresh
    ``as_of`` view — exactness over speed. The cursor never mutates the dataset, holds no
    global state, and one instance serves one runner.
    """

    def __init__(self, dataset: MarketDataSet) -> None:
        self._dataset = dataset
        close_arrivals: list[tuple[datetime, str, date, float]] = []
        open_arrivals: list[tuple[datetime, str, date, float]] = []
        for asset, series in dataset.observations.items():
            for observation in series:
                close_arrivals.append(
                    (
                        observation.close_available_at,
                        asset,
                        observation.session_date,
                        observation.close_price,
                    )
                )
                open_arrivals.append(
                    (
                        observation.open_available_at,
                        asset,
                        observation.session_date,
                        observation.open_price,
                    )
                )
        close_arrivals.sort()
        open_arrivals.sort()
        self._close_arrivals = close_arrivals
        self._open_arrivals = open_arrivals
        self._close_cursor = 0
        self._open_cursor = 0
        self._latest_close: dict[str, tuple[date, float]] = {}
        self._visible_opens: dict[str, dict[date, float]] = {}
        self._high_water: datetime | None = None

    def _advance(self, cutoff: datetime) -> None:
        """Incorporate every observation whose availability is <= *cutoff* (inclusive — the
        same boundary ``as_of`` applies)."""
        self._high_water = cutoff
        arrivals = self._close_arrivals
        index = self._close_cursor
        while index < len(arrivals) and arrivals[index][0] <= cutoff:
            _, asset, day, price = arrivals[index]
            index += 1
            latest = self._latest_close.get(asset)
            if latest is None or day > latest[0]:
                self._latest_close[asset] = (day, price)
        self._close_cursor = index
        arrivals = self._open_arrivals
        index = self._open_cursor
        while index < len(arrivals) and arrivals[index][0] <= cutoff:
            _, asset, day, price = arrivals[index]
            index += 1
            self._visible_opens.setdefault(asset, {})[day] = price
        self._open_cursor = index

    def _is_backward(self, cutoff: datetime) -> bool:
        return self._high_water is not None and cutoff < self._high_water

    def latest_close(self, asset: str, instant: datetime) -> tuple[date, float] | None:
        """``as_of(instant).close_history(asset)[-1]`` — or ``None`` with no visible close."""
        cutoff = require_aware_utc(instant, "instant")
        if self._is_backward(cutoff):
            history = self._dataset.as_of(cutoff).close_history(asset)
            return history[-1] if history else None
        self._advance(cutoff)
        return self._latest_close.get(asset)

    def session_close(self, asset: str, session_date: date, instant: datetime) -> float | None:
        """The close AT exactly *session_date* IF it is the latest visible close — the
        engine's planning-price predicate (``history[-1][0] == session_date``) verbatim."""
        latest = self.latest_close(asset, instant)
        return latest[1] if latest is not None and latest[0] == session_date else None

    def open_price(self, asset: str, session_date: date, instant: datetime) -> float | None:
        """``as_of(instant).open_price(asset, session_date)`` — exact session only, never a
        stale substitute."""
        cutoff = require_aware_utc(instant, "instant")
        if self._is_backward(cutoff):
            return self._dataset.as_of(cutoff).open_price(asset, session_date)
        self._advance(cutoff)
        return self._visible_opens.get(asset, {}).get(session_date)
