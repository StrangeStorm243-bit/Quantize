"""Frozen run-record value objects for one deterministic engine run (M4).

In-memory contracts only — durable persistence is M7. No wall-clock values, machine paths, or
raw exception objects appear here; every timestamp is one of the separately-modeled instants
(evaluation/signal, order-creation = evaluation, scheduled fill, actual fill = the open in v0,
valuation = the close). A failed run (``ok=False``) carries diagnostics plus the partial
artifacts up to the last consistent transition — never a contradictory "success".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime

from quantize.engine.orders import Fill
from quantize.engine.reconcile import ReconciliationOutcome
from quantize.engine.state import PortfolioState
from quantize.market.calendar import ExchangeCalendar
from quantize.runtime.diagnostics import RuntimeDiagnostic
from quantize.tracing.events import TraceEvent


@dataclass(frozen=True)
class FillEvent:
    """One executed fill with its actual-fill instant (the fill session's open, v0)."""

    session_date: date
    actual_fill_instant: datetime
    fill: Fill


@dataclass(frozen=True)
class SessionNote:
    """A structured, non-fatal engine note tied to a session (e.g. why no evaluation ran)."""

    session_date: date
    code: str
    message: str


@dataclass(frozen=True)
class StaleMark:
    """A valuation mark carried from an earlier session (documented carry rule, never silent)."""

    session_date: date
    asset: str
    mark_date: date


@dataclass(frozen=True)
class EvaluationRecord:
    """One scheduled evaluation: targets, reconciliation, and its scheduled fill."""

    session_date: date
    evaluation_instant: datetime  # also the signal + order-creation instant (v0)
    target_weights: tuple[tuple[str, float], ...]
    reconciliation: ReconciliationOutcome
    fill_session: date | None
    scheduled_fill_instant: datetime | None


@dataclass(frozen=True)
class BacktestResult:
    """The immutable record of one historical run (the Storage seam holds this in memory)."""

    ok: bool
    run_id: str
    # The run record preserves the exchange calendar and timezone actually used (MVP_PLAN §M4),
    # so session boundaries — and therefore weekly/monthly evaluation instants — are
    # reproducible from the record alone.
    calendar: ExchangeCalendar
    first_session: date | None
    last_session: date | None
    valuations: tuple[tuple[date, float], ...]
    stale_marks: tuple[StaleMark, ...]
    evaluations: tuple[EvaluationRecord, ...]
    fills: tuple[FillEvent, ...]  # in application order
    returns: tuple[float, ...]
    total_return: float
    max_drawdown: float
    final_state: PortfolioState
    notes: tuple[SessionNote, ...]
    diagnostics: tuple[RuntimeDiagnostic, ...] = ()
    trace: tuple[TraceEvent, ...] = field(default=(), repr=False)

    @property
    def exchange(self) -> str:
        return self.calendar.exchange

    @property
    def timezone(self) -> str:
        return self.calendar.timezone
