"""Deterministic forward/paper replay (M8): the SAME engine core, one session at a time.

Forward/paper in the MVP means deterministic incremental replay over local fixture/uploaded
data — no network, live feed, or broker (ARCHITECTURE §3; those are deferred adapters). The
driver feeds sessions to ``SessionEngine.step`` — the exact loop body ``run_backtest`` uses —
so the modes CANNOT diverge in behavior, only in who advances the clock.

**Bounded replay (v0 contract):** ``last_session`` is REQUIRED. The engine's window-tail rule
(an evaluation whose fill would land beyond the window is suppressed with a
``fill_outside_window`` note) needs a known end; an open-ended driver would instead queue a
pending order that dangles at the stopping point — a genuinely different tail semantics,
explicitly deferred with the live-data adapter. Bounded, exhausted replay over the same window
is field-for-field EQUAL to the backtest (the M8 consistency battery).

A failed ``step`` is terminal: the failing ``advance()`` reports it and every later ``advance()``
returns ``None``. ``result()`` may be called at any point — it assembles the facts accumulated
so far (window bounds are the run's definition, as in a failed backtest).

Checkpoint/resume: ``snapshot()`` captures the run's replayable state (cursor, portfolio state,
pending overnight orders — they legitimately span an ``advance()`` boundary — and the
accumulated record tails, which ``finish`` needs for metrics over the full valuation series).
``resume`` rebuilds a driver that continues deterministically. Checkpoints are immutable value
objects; durable checkpoint STORAGE is deferred (a completed run persists via M7 ``save_run``).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from quantize.components.resolve import ComponentCatalog
from quantize.engine.backtest import SessionEngine
from quantize.engine.orders import Fill, OrderList
from quantize.engine.records import (
    BacktestResult,
    EvaluationRecord,
    FillEvent,
    SessionNote,
    StaleMark,
)
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.runtime.binding import ImplementationCatalog
from quantize.runtime.diagnostics import RuntimeDiagnostic
from quantize.schema.document import StrategyDocument
from quantize.tracing.events import TraceEvent


@dataclass(frozen=True)
class SessionAdvance:
    """What one ``advance()`` did: the session fed, and the step's observable outcome."""

    session_date: date
    ok: bool  # False = this step failed terminally (result() carries the diagnostics)
    evaluated: bool  # an evaluation record was produced at this session's close
    fills: tuple[Fill, ...]  # fills applied at this session's open
    portfolio_value: float | None  # the close valuation (None only on a failed step)


@dataclass(frozen=True)
class ForwardCheckpoint:
    """The replayable state of a forward run at a session boundary. Immutable."""

    run_id: str
    cursor: int
    state: PortfolioState
    pending: tuple[OrderList, date] | None
    valuations: tuple[tuple[date, float], ...]
    stale_marks: tuple[StaleMark, ...]
    evaluations: tuple[EvaluationRecord, ...]
    fills: tuple[FillEvent, ...]
    notes: tuple[SessionNote, ...]
    trace: tuple[TraceEvent, ...]
    failure: tuple[RuntimeDiagnostic, ...] | None  # a terminal run resumes as terminal


class ForwardReplay:
    """Advance a strategy one eligible market session at a time over local data."""

    def __init__(
        self,
        document: StrategyDocument,
        *,
        catalog: ImplementationCatalog,
        market_data: MarketDataSet,
        run_id: str,
        initial_state: PortfolioState,
        last_session: date,
        first_session: date | None = None,
        components: ComponentCatalog | None = None,
        collect_trace: bool = True,
    ) -> None:
        if last_session is None:  # runtime guard: the type says date, callers can lie
            # The bounded-replay contract is load-bearing (window-tail semantics): a None
            # sneaking past the type checker would silently produce the deferred open-ended
            # tail behavior.
            raise ValueError("ForwardReplay requires last_session (bounded replay; see M8 plan)")
        self._engine = SessionEngine(
            document,
            catalog=catalog,
            market_data=market_data,
            run_id=run_id,
            initial_state=initial_state,
            components=components,
            first_session=first_session,
            last_session=last_session,
            collect_trace=collect_trace,
        )
        self._cursor = 0
        self._failure: tuple[RuntimeDiagnostic, ...] | None = self._engine.preflight()

    # --- clock ------------------------------------------------------------------------------

    @property
    def exhausted(self) -> bool:
        return self._failure is not None or self._cursor >= len(self._engine.sessions)

    def advance(self) -> SessionAdvance | None:
        """Feed exactly the next eligible session; ``None`` when exhausted or after a failure
        (idempotently — a terminal run accepts no further sessions)."""
        if self.exhausted:
            return None
        session = self._engine.sessions[self._cursor]
        evaluations_before = len(self._engine.evaluations)
        fills_before = len(self._engine.all_fills)
        failure = self._engine.step(session)
        self._cursor += 1
        if failure is not None:
            self._failure = failure
            return SessionAdvance(
                session_date=session.session_date,
                ok=False,
                evaluated=len(self._engine.evaluations) > evaluations_before,
                fills=tuple(event.fill for event in self._engine.all_fills[fills_before:]),
                portfolio_value=None,
            )
        return SessionAdvance(
            session_date=session.session_date,
            ok=True,
            evaluated=len(self._engine.evaluations) > evaluations_before,
            fills=tuple(event.fill for event in self._engine.all_fills[fills_before:]),
            portfolio_value=self._engine.valuations[-1][1],
        )

    # --- results ----------------------------------------------------------------------------

    def result(self) -> BacktestResult:
        """The run's facts so far (final when exhausted). Same assembly as the backtest.

        A NON-exhausted call is a PEEK: it reports the configured window bounds with only a
        prefix of the facts, and is not a completed run — the M7 repository fails closed on
        persisting one (``save_run`` rejects an ok run whose facts stop short of its window).
        """
        if self._failure is not None:
            return self._engine.finish(False, self._failure)
        return self._engine.finish(True)

    # --- checkpoint/resume --------------------------------------------------------------------

    def snapshot(self) -> ForwardCheckpoint:
        engine = self._engine
        return ForwardCheckpoint(
            run_id=engine.run_id,
            cursor=self._cursor,
            state=engine.state,
            pending=engine.pending,
            valuations=tuple(engine.valuations),
            stale_marks=tuple(engine.stale_marks),
            evaluations=tuple(engine.evaluations),
            fills=tuple(engine.all_fills),
            notes=tuple(engine.notes),
            trace=tuple(engine.trace),
            failure=self._failure,
        )

    @classmethod
    def resume(
        cls,
        checkpoint: ForwardCheckpoint,
        document: StrategyDocument,
        *,
        catalog: ImplementationCatalog,
        market_data: MarketDataSet,
        last_session: date,
        first_session: date | None = None,
        components: ComponentCatalog | None = None,
        collect_trace: bool = True,
    ) -> ForwardReplay:
        """A fresh driver continuing deterministically from *checkpoint*.

        Derived config (schedule, warm-up, costs, calendar) is rebuilt from the inputs — only
        the replayable state is restored. The caller must supply the same document/data/window
        the checkpoint came from; a divergent supply is a caller error, not a recoverable one.
        """
        replay = cls(
            document,
            catalog=catalog,
            market_data=market_data,
            run_id=checkpoint.run_id,
            initial_state=checkpoint.state,
            last_session=last_session,
            first_session=first_session,
            components=components,
            collect_trace=collect_trace,
        )
        engine = replay._engine
        engine.pending = checkpoint.pending
        engine.valuations = list(checkpoint.valuations)
        engine.stale_marks = list(checkpoint.stale_marks)
        engine.evaluations = list(checkpoint.evaluations)
        engine.all_fills = list(checkpoint.fills)
        engine.notes = list(checkpoint.notes)
        engine.trace = list(checkpoint.trace)
        replay._cursor = checkpoint.cursor
        if checkpoint.failure is not None:
            replay._failure = checkpoint.failure  # a dead run stays dead
        return replay
