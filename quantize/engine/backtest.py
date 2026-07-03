"""The session engine — one loop body for BOTH modes (ARCHITECTURE §3; M8 extraction).

Per session in the run window: (1) at the OPEN, apply any fills queued by the previous
evaluation (availability-gated open reads at that instant — the Broker(sim) seam, served by the
run's incremental cursor, property-tested equal to the as-of view);
(2) at the CLOSE (valuation instant), mark the portfolio; (3) at the CLOSE (evaluation instant),
if the schedule fires, the warm-up gate passes, and the scheduled fill session exists inside the
window: evaluate the graph via M3, reconcile per ADR-0005, and queue the orders for the next
valid session. The order queue is therefore always empty at every evaluation instant (ADR-0005
R16 holds structurally).

``SessionEngine`` is that lifecycle as a stepwise core (M8): ``run_backtest`` drives it over the
whole window; the forward driver (``quantize/engine/forward.py``) drives the SAME ``step`` one
session at a time. The modes differ ONLY in who feeds sessions (the Clock seam) — never in what
happens within one. Never add a second implementation of any step behavior.

Adapter seams, named: Clock = the pure ``run_window`` session sequence (the forward driver feeds
the same shape one session at a time); MarketData = ``MarketDataSet.as_of`` at evaluation
instants plus the equivalent ``MarketDataCursor`` point reads for per-session valuation,
planning, and fills; Broker(sim) = ``fills.apply_orders``; Storage = the returned in-memory
``BacktestResult`` (durable storage is M7).

Valuation carry rule (documented here, per CLAUDE.md invariant 10 — not silent): a held asset is
marked at its most recent VISIBLE close ≤ the valuation instant; a non-current mark is recorded
as a ``StaleMark`` on the result; a held asset with no visible close at all fails the run
(``missing_valuation_price``). The carry NEVER reaches trading — reconciliation requires strict
same-session closes and fails atomically without them (ADR-0005 D8).

Failure policy (mirrors M3): expected data/document faults return ``ok=False`` with structured
diagnostics and the partial artifacts up to the last consistent transition; programmer errors
raise. A failed ``step`` is TERMINAL: the run ends and no further session may be fed.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime

from quantize.components.resolve import ComponentCatalog, resolve_strategy_components
from quantize.engine.errors import (
    EVALUATION_FAILED,
    INVALID_TRANSACTION_COSTS,
    MISSING_VALUATION_PRICE,
    NOTE_FILL_OUTSIDE_WINDOW,
    NOTE_NO_NEXT_SESSION,
    NOTE_WARMUP_NOT_SATISFIED,
    RECONCILIATION_FAILED,
)
from quantize.engine.fills import apply_orders
from quantize.engine.metrics import max_drawdown, simple_returns, total_return
from quantize.engine.orders import OrderList
from quantize.engine.reconcile import reconcile
from quantize.engine.records import (
    BacktestResult,
    EvaluationRecord,
    FillEvent,
    SessionNote,
    StaleMark,
)
from quantize.engine.schedule import scheduled_sessions
from quantize.engine.state import PortfolioState
from quantize.evaluator.evaluate import evaluate_strategy
from quantize.evaluator.plan import resolve_warmup
from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataCursor, MarketDataSet
from quantize.runtime.binding import EvaluationMemo, ImplementationCatalog
from quantize.runtime.diagnostics import RuntimeDiagnostic
from quantize.schema.document import StrategyDocument
from quantize.schema.primitives import JsonValue
from quantize.tracing.events import TraceEvent


def run_window(
    calendar: ExchangeCalendar,
    first_session: date | None,
    last_session: date | None,
) -> tuple[MarketSession, ...]:
    """The Clock seam: the contiguous session sequence of the run, pure and deterministic."""
    return tuple(
        session
        for session in calendar.sessions
        if (first_session is None or session.session_date >= first_session)
        and (last_session is None or session.session_date <= last_session)
    )


def _mark_to_market(
    state: PortfolioState, cursor: MarketDataCursor, instant: datetime, session_date: date
) -> tuple[float, tuple[StaleMark, ...], tuple[RuntimeDiagnostic, ...]]:
    """Valuation at the close (see the module docstring's carry rule).

    Reads the latest VISIBLE close through the run's cursor — exactly what
    ``as_of(instant).close_history(asset)[-1]`` exposes (property-tested equivalence), without
    materializing the full view per session.
    """
    value = state.cash
    marks: list[StaleMark] = []
    for asset, quantity in state.positions:  # canonical fold order
        latest = cursor.latest_close(asset, instant)
        if latest is None:
            return (
                0.0,
                (),
                (
                    RuntimeDiagnostic(
                        MISSING_VALUATION_PRICE,
                        f"held asset {asset!r} has no visible close at or before "
                        f"{session_date.isoformat()}",
                        subject=asset,
                    ),
                ),
            )
        mark_date, price = latest
        value += quantity * price
        if mark_date != session_date:
            marks.append(StaleMark(session_date=session_date, asset=asset, mark_date=mark_date))
    return value, tuple(marks), ()


def _closes_at(
    cursor: MarketDataCursor, instant: datetime, session_date: date, assets: tuple[str, ...]
) -> dict[str, float]:
    """Session-D closes for *assets* (ADR-0005 D3: the close AT session D exactly, or absent)."""
    prices: dict[str, float] = {}
    for asset in assets:
        price = cursor.session_close(asset, session_date, instant)
        if price is not None:
            prices[asset] = price
    return prices


@dataclass(frozen=True)
class _OpenPricesAt:
    """Cursor-backed ``OpenPriceSource`` for one fill instant (the Broker(sim) read)."""

    cursor: MarketDataCursor
    instant: datetime

    def open_price(self, asset: str, session_date: date) -> float | None:
        return self.cursor.open_price(asset, session_date, self.instant)


class SessionEngine:
    """The mode-agnostic engine core: config, accumulators, one ``step``, one ``finish``.

    Internal to the engine package — constructed only by ``run_backtest`` and the M8 forward
    driver. The loop body in ``step`` is the M4–M7 behavior verbatim; the extraction gate is
    the full existing suite passing untouched.
    """

    def __init__(
        self,
        document: StrategyDocument,
        *,
        catalog: ImplementationCatalog,
        market_data: MarketDataSet,
        run_id: str,
        initial_state: PortfolioState,
        components: ComponentCatalog | None,
        first_session: date | None,
        last_session: date | None,
        collect_trace: bool,
    ) -> None:
        self.document = document
        self.catalog = catalog
        self.market_data = market_data
        self.run_id = str(uuid.UUID(run_id))
        self.components = components
        self.collect_trace = collect_trace
        self.calendar = market_data.calendar
        self.sessions = run_window(self.calendar, first_session, last_session)
        self.last_session = last_session
        self.fires = set(scheduled_sessions(document.schedule, self.calendar))
        self.cost_bps = document.execution_policy.transaction_costs.bps
        self.calendar_index = {day: index for index, day in enumerate(self.calendar.session_dates)}
        self.warmup_total = 0  # set by preflight

        self.valuations: list[tuple[date, float]] = []
        self.stale_marks: list[StaleMark] = []
        self.evaluations: list[EvaluationRecord] = []
        self.all_fills: list[FillEvent] = []
        self.notes: list[SessionNote] = []
        self.trace: list[TraceEvent] = []
        self.state = initial_state
        self.pending: tuple[OrderList, date] | None = None
        # The run's speed-only reuse channel: one memo per run, fed strictly ascending
        # evaluation instants by the session loop. Bit-exactness with memo=None is proven by
        # the C1 battery (tests/test_evaluation_memo.py).
        self.memo: EvaluationMemo | None = EvaluationMemo()
        # The run's incremental visibility cursor (pre-M9 C2): valuation marks, planning
        # closes, and fill opens read through it instead of a per-session full as_of view;
        # its answers are property-tested equal to as_of (tests/test_market_cursor.py).
        self.data_cursor = MarketDataCursor(market_data)

    # --- assembly ---------------------------------------------------------------------------

    def _engine_event(
        self, timestamp: datetime, event_type: str, payload: dict[str, JsonValue]
    ) -> None:
        # Engine events reuse the envelope with node_id="engine" and the reserved "engine."
        # event-type namespace (quantize/engine/trace.py). Facts come from production objects.
        if self.collect_trace:
            self.trace.append(
                TraceEvent(
                    run_id=self.run_id,
                    timestamp=timestamp,
                    node_id="engine",
                    component_path=(),
                    event_type=event_type,
                    payload=payload,
                )
            )

    def _note(self, session: MarketSession, code: str, message: str) -> None:
        note = SessionNote(session.session_date, code, message)
        self.notes.append(note)
        self._engine_event(
            session.close_at,
            "engine.note",
            {
                "v": 1,
                "session": session.session_date.isoformat(),
                "code": note.code,
                "message": note.message,
            },
        )

    def finish(self, ok: bool, diagnostics: tuple[RuntimeDiagnostic, ...] = ()) -> BacktestResult:
        values = tuple(value for _, value in self.valuations)
        return BacktestResult(
            ok=ok,
            run_id=self.run_id,
            calendar=self.calendar,
            first_session=self.sessions[0].session_date if self.sessions else None,
            last_session=self.sessions[-1].session_date if self.sessions else None,
            valuations=tuple(self.valuations),
            stale_marks=tuple(self.stale_marks),
            evaluations=tuple(self.evaluations),
            fills=tuple(self.all_fills),
            returns=simple_returns(values),
            total_return=total_return(values),
            max_drawdown=max_drawdown(values),
            final_state=self.state,
            notes=tuple(self.notes),
            diagnostics=diagnostics,
            trace=tuple(self.trace),
        )

    # --- lifecycle --------------------------------------------------------------------------

    def preflight(self) -> tuple[RuntimeDiagnostic, ...] | None:
        """Run-entry validation (component resolution feeds the warm-up gate; unsupported cost
        models fail before any session runs). ``None`` = ready; diagnostics = terminal."""
        resolution = resolve_strategy_components(
            self.document, self.components or ComponentCatalog(), self.catalog.descriptor_registry
        )
        if not resolution.ok:
            return resolution.diagnostics
        self.warmup_total = resolve_warmup(self.document, self.catalog, resolution).total
        if not 0.0 <= self.cost_bps < 10_000.0:
            return (
                RuntimeDiagnostic(
                    INVALID_TRANSACTION_COSTS,
                    f"transaction cost of {self.cost_bps!r} bps is outside the "
                    "engine-supported range [0, 10000)",
                    subject="bps",
                ),
            )
        return None

    def step(self, session: MarketSession) -> tuple[RuntimeDiagnostic, ...] | None:
        """One session of the lifecycle. ``None`` = advanced; diagnostics = TERMINAL failure
        (the run is over; feeding further sessions is a caller error)."""
        day = session.session_date

        # 1. OPEN — apply fills queued for this session (Broker(sim) seam), reading opens
        # through the availability-gated cursor at the open instant.
        if self.pending is not None and self.pending[1] == day:
            orders, _ = self.pending
            opens_at_fill = _OpenPricesAt(self.data_cursor, session.open_at)
            state_after, event_fills, fill_diags = apply_orders(
                self.state, orders, opens_at_fill, day, self.cost_bps
            )
            if fill_diags:
                return fill_diags
            self._engine_event(
                session.open_at,
                "engine.orders_filled",
                {
                    "v": 1,
                    "session": day.isoformat(),
                    "fills": [
                        [f.side, f.asset, f.quantity, f.price, f.cost, f.cash_delta, f.scaled]
                        for f in event_fills
                    ],
                },
            )
            self._engine_event(
                session.open_at,
                "engine.state_transition",
                {
                    "v": 1,
                    "session": day.isoformat(),
                    "cash_before": self.state.cash,
                    "cash_after": state_after.cash,
                    "positions_before": [[a, q] for a, q in self.state.positions],
                    "positions_after": [[a, q] for a, q in state_after.positions],
                },
            )
            self.state = state_after
            self.all_fills.extend(
                FillEvent(session_date=day, actual_fill_instant=session.open_at, fill=fill)
                for fill in event_fills
            )
            self.pending = None

        # 2. CLOSE — valuation instant.
        value, marks, valuation_diags = _mark_to_market(
            self.state, self.data_cursor, session.close_at, day
        )
        if valuation_diags:
            return valuation_diags
        self.valuations.append((day, value))
        self.stale_marks.extend(marks)

        # 3. CLOSE — evaluation instant (only when the schedule fires).
        if day not in self.fires:
            return None
        visible = self.calendar_index[day] + 1  # history depth is calendar-wide, not window
        if visible <= self.warmup_total:
            self._note(
                session,
                NOTE_WARMUP_NOT_SATISFIED,
                f"warm-up requires more than {self.warmup_total} sessions; only {visible} visible",
            )
            return None
        next_session = self.calendar.next_session_after(day)
        if next_session is None:
            self._note(session, NOTE_NO_NEXT_SESSION, "no next valid session in the calendar")
            return None
        if self.last_session is not None and next_session.session_date > self.last_session:
            self._note(
                session,
                NOTE_FILL_OUTSIDE_WINDOW,
                f"scheduled fill session {next_session.session_date.isoformat()} falls "
                "outside the run window",
            )
            return None

        outcome = evaluate_strategy(
            self.document,
            catalog=self.catalog,
            market_data=self.market_data,
            run_id=self.run_id,
            evaluation_instant=session.close_at,
            components=self.components,
            collect_trace=self.collect_trace,
            memo=self.memo,
        )
        self.trace.extend(outcome.trace)
        if not outcome.ok or outcome.targets is None:
            return (
                RuntimeDiagnostic(
                    EVALUATION_FAILED,
                    f"graph evaluation failed at {day.isoformat()}",
                    subject=day.isoformat(),
                ),
                *outcome.diagnostics,
            )

        targeted = tuple(asset for asset, weight in outcome.targets.weights if weight > 0.0)
        union = tuple(sorted(set(self.state.held_assets) | set(targeted)))
        reconciliation = reconcile(
            self.state,
            outcome.targets,
            _closes_at(self.data_cursor, session.close_at, day, union),
        )
        self.evaluations.append(
            EvaluationRecord(
                session_date=day,
                evaluation_instant=session.close_at,
                target_weights=outcome.targets.weights,
                reconciliation=reconciliation,
                fill_session=next_session.session_date,
                scheduled_fill_instant=next_session.open_at,
            )
        )
        if reconciliation.ok:
            assert reconciliation.portfolio_value is not None
            assert reconciliation.target_cash is not None
            assert reconciliation.projected_cash is not None
            self._engine_event(
                session.close_at,
                "engine.orders_proposed",
                {
                    "v": 1,
                    "session": day.isoformat(),
                    "portfolio_value": reconciliation.portfolio_value,
                    "target_cash": reconciliation.target_cash,
                    "projected_cash": reconciliation.projected_cash,
                    "orders": [[o.side, o.asset, o.quantity] for o in reconciliation.orders],
                    # Planning-layer reasons an order did not fire: dust/hold plan rows.
                    "omitted": [
                        [plan.asset, plan.action, plan.delta_quantity]
                        for plan in reconciliation.plans
                        if plan.action in ("dust", "hold")
                    ],
                },
            )
        if not reconciliation.ok:
            return (
                RuntimeDiagnostic(
                    RECONCILIATION_FAILED,
                    f"reconciliation failed at {day.isoformat()}",
                    subject=day.isoformat(),
                ),
                *reconciliation.diagnostics,
            )
        if reconciliation.orders:
            self.pending = (reconciliation.orders, next_session.session_date)
        return None


def run_backtest(
    document: StrategyDocument,
    *,
    catalog: ImplementationCatalog,
    market_data: MarketDataSet,
    run_id: str,
    initial_state: PortfolioState,
    components: ComponentCatalog | None = None,
    first_session: date | None = None,
    last_session: date | None = None,
    collect_trace: bool = True,
) -> BacktestResult:
    """Run *document* historically over *market_data* (see module docstring for the lifecycle)."""
    engine = SessionEngine(
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
    failure = engine.preflight()
    if failure is not None:
        return engine.finish(False, failure)
    for session in engine.sessions:
        failure = engine.step(session)
        if failure is not None:
            return engine.finish(False, failure)
    return engine.finish(True)
