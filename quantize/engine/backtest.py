"""The historical session driver — one engine over the M3 evaluator (ARCHITECTURE §3).

Per session in the run window: (1) at the OPEN, apply any fills queued by the previous
evaluation (through the availability-gated view taken at that open — the Broker(sim) seam);
(2) at the CLOSE (valuation instant), mark the portfolio; (3) at the CLOSE (evaluation instant),
if the schedule fires, the warm-up gate passes, and the scheduled fill session exists inside the
window: evaluate the graph via M3, reconcile per ADR-0005, and queue the orders for the next
valid session. The order queue is therefore always empty at every evaluation instant (ADR-0005
R16 holds structurally).

Adapter seams, named: Clock = the pure ``run_window`` session sequence (the M8 forward driver
feeds the same shape one session at a time); MarketData = ``MarketDataSet.as_of``; Broker(sim) =
``fills.apply_orders``; Storage = the returned in-memory ``BacktestResult`` (durable storage is
M7).

Valuation carry rule (documented here, per CLAUDE.md invariant 10 — not silent): a held asset is
marked at its most recent VISIBLE close ≤ the valuation instant; a non-current mark is recorded
as a ``StaleMark`` on the result; a held asset with no visible close at all fails the run
(``missing_valuation_price``). The carry NEVER reaches trading — reconciliation requires strict
same-session closes and fails atomically without them (ADR-0005 D8).

Failure policy (mirrors M3): expected data/document faults return ``ok=False`` with structured
diagnostics and the partial artifacts up to the last consistent transition; programmer errors
raise.
"""

from __future__ import annotations

import uuid
from datetime import date

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
from quantize.market.data import DataView, MarketDataSet
from quantize.runtime.binding import ImplementationCatalog
from quantize.runtime.diagnostics import RuntimeDiagnostic
from quantize.schema.document import StrategyDocument
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
    state: PortfolioState, view: DataView, session_date: date
) -> tuple[float, tuple[StaleMark, ...], tuple[RuntimeDiagnostic, ...]]:
    """Valuation at the close (see the module docstring's carry rule)."""
    value = state.cash
    marks: list[StaleMark] = []
    for asset, quantity in state.positions:  # canonical fold order
        history = view.close_history(asset)
        if not history:
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
        mark_date, price = history[-1]
        value += quantity * price
        if mark_date != session_date:
            marks.append(StaleMark(session_date=session_date, asset=asset, mark_date=mark_date))
    return value, tuple(marks), ()


def _closes_at(view: DataView, session_date: date, assets: tuple[str, ...]) -> dict[str, float]:
    """Session-D closes for *assets* (ADR-0005 D3: the close AT session D exactly, or absent)."""
    prices: dict[str, float] = {}
    for asset in assets:
        history = view.close_history(asset)
        if history and history[-1][0] == session_date:
            prices[asset] = history[-1][1]
    return prices


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
) -> BacktestResult:
    """Run *document* historically over *market_data* (see module docstring for the lifecycle)."""
    run_id = str(uuid.UUID(run_id))
    calendar = market_data.calendar
    sessions = run_window(calendar, first_session, last_session)
    fires = set(scheduled_sessions(document.schedule, calendar))
    cost_bps = document.execution_policy.transaction_costs.bps
    calendar_index = {day: index for index, day in enumerate(calendar.session_dates)}

    valuations: list[tuple[date, float]] = []
    stale_marks: list[StaleMark] = []
    evaluations: list[EvaluationRecord] = []
    all_fills: list[FillEvent] = []
    notes: list[SessionNote] = []
    trace: list[TraceEvent] = []
    state = initial_state
    pending: tuple[OrderList, date] | None = None

    def result(ok: bool, diagnostics: tuple[RuntimeDiagnostic, ...] = ()) -> BacktestResult:
        values = tuple(value for _, value in valuations)
        return BacktestResult(
            ok=ok,
            run_id=run_id,
            calendar=calendar,
            first_session=sessions[0].session_date if sessions else None,
            last_session=sessions[-1].session_date if sessions else None,
            valuations=tuple(valuations),
            stale_marks=tuple(stale_marks),
            evaluations=tuple(evaluations),
            fills=tuple(all_fills),
            returns=simple_returns(values),
            total_return=total_return(values),
            max_drawdown=max_drawdown(values),
            final_state=state,
            notes=tuple(notes),
            diagnostics=diagnostics,
            trace=tuple(trace),
        )

    # Pre-flight once (evaluations re-run these defensively): component resolution feeds the
    # warm-up gate; a document the M3 evaluator would reject fails the run up front.
    resolution = resolve_strategy_components(
        document, components or ComponentCatalog(), catalog.descriptor_registry
    )
    if not resolution.ok:
        return result(False, resolution.diagnostics)
    warmup_total = resolve_warmup(document, catalog, resolution).total
    if not 0.0 <= cost_bps < 10_000.0:
        # Schema-valid but engine-unsupported cost model: fail before any session runs.
        return result(
            False,
            (
                RuntimeDiagnostic(
                    INVALID_TRANSACTION_COSTS,
                    f"transaction cost of {cost_bps!r} bps is outside the engine-supported "
                    "range [0, 10000)",
                    subject="bps",
                ),
            ),
        )

    for session in sessions:
        day = session.session_date

        # 1. OPEN — apply fills queued for this session (Broker(sim) seam).
        if pending is not None and pending[1] == day:
            orders, _ = pending
            view_open = market_data.as_of(session.open_at)
            state_after, event_fills, fill_diags = apply_orders(
                state, orders, view_open, day, cost_bps
            )
            if fill_diags:
                return result(False, fill_diags)
            state = state_after
            all_fills.extend(
                FillEvent(session_date=day, actual_fill_instant=session.open_at, fill=fill)
                for fill in event_fills
            )
            pending = None

        # 2. CLOSE — valuation instant.
        view_close = market_data.as_of(session.close_at)
        value, marks, valuation_diags = _mark_to_market(state, view_close, day)
        if valuation_diags:
            return result(False, valuation_diags)
        valuations.append((day, value))
        stale_marks.extend(marks)

        # 3. CLOSE — evaluation instant (only when the schedule fires).
        if day not in fires:
            continue
        visible_sessions = calendar_index[day] + 1  # history depth is calendar-wide, not window
        if visible_sessions <= warmup_total:
            notes.append(
                SessionNote(
                    day,
                    NOTE_WARMUP_NOT_SATISFIED,
                    f"warm-up requires more than {warmup_total} sessions; "
                    f"only {visible_sessions} visible",
                )
            )
            continue
        next_session = calendar.next_session_after(day)
        if next_session is None:
            notes.append(
                SessionNote(day, NOTE_NO_NEXT_SESSION, "no next valid session in the calendar")
            )
            continue
        if last_session is not None and next_session.session_date > last_session:
            notes.append(
                SessionNote(
                    day,
                    NOTE_FILL_OUTSIDE_WINDOW,
                    f"scheduled fill session {next_session.session_date.isoformat()} falls "
                    "outside the run window",
                )
            )
            continue

        outcome = evaluate_strategy(
            document,
            catalog=catalog,
            market_data=market_data,
            run_id=run_id,
            evaluation_instant=session.close_at,
            components=components,
        )
        trace.extend(outcome.trace)
        if not outcome.ok or outcome.targets is None:
            diagnostics = (
                RuntimeDiagnostic(
                    EVALUATION_FAILED,
                    f"graph evaluation failed at {day.isoformat()}",
                    subject=day.isoformat(),
                ),
                *outcome.diagnostics,
            )
            return result(False, diagnostics)

        targeted = tuple(asset for asset, weight in outcome.targets.weights if weight > 0.0)
        union = tuple(sorted(set(state.held_assets) | set(targeted)))
        reconciliation = reconcile(state, outcome.targets, _closes_at(view_close, day, union))
        evaluations.append(
            EvaluationRecord(
                session_date=day,
                evaluation_instant=session.close_at,
                target_weights=outcome.targets.weights,
                reconciliation=reconciliation,
                fill_session=next_session.session_date,
                scheduled_fill_instant=next_session.open_at,
            )
        )
        if not reconciliation.ok:
            diagnostics = (
                RuntimeDiagnostic(
                    RECONCILIATION_FAILED,
                    f"reconciliation failed at {day.isoformat()}",
                    subject=day.isoformat(),
                ),
                *reconciliation.diagnostics,
            )
            return result(False, diagnostics)
        if reconciliation.orders:
            pending = (reconciliation.orders, next_session.session_date)

    return result(True)
