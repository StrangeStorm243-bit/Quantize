"""Persisted run-record contract (M7): the engine's historical FACTS, versioned.

``PersistedRunRecord`` is the durable, facts-only shape of a completed run — built FROM a live
``BacktestResult`` at save time and validated back into this frozen model at load. It never
recomputes anything: every field is copied from what the engine actually did. The in-memory
``ExchangeCalendar`` is an engine INPUT, not a run fact, so it is not persisted; the instants
the run actually used (evaluation/scheduled-fill/actual-fill) ARE facts and are stored
explicitly. Trace events are stored beside the record (same transaction), not inside it.

``RECORD_FORMAT`` is the persistence schema version of this envelope; it is stored with every
row and gated + migrated at load.
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from quantize.engine.records import BacktestResult

RECORD_FORMAT = 1
TRACE_FORMAT = 1

RUN_MODE_BACKTEST = "backtest"
RUN_MODE_FORWARD = "forward"  # M8: deterministic incremental replay


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class PersistedPlanRow(_Frozen):
    """One reconciliation explanation row (ADR-0005 AssetPlan), verbatim."""

    asset: str
    price: float
    current_quantity: float
    target_weight: float
    target_notional: float
    target_quantity: float
    delta_quantity: float
    action: str  # buy | sell | hold | dust


class PersistedOrder(_Frozen):
    side: str  # buy | sell
    asset: str
    quantity: float


class PersistedEvaluation(_Frozen):
    session_date: date
    evaluation_instant: datetime  # signal + order-creation instant (v0) — a run fact
    target_weights: tuple[tuple[str, float], ...]
    ok: bool
    portfolio_value: float | None
    target_cash: float | None
    projected_cash: float | None
    plans: tuple[PersistedPlanRow, ...]
    orders: tuple[PersistedOrder, ...]
    fill_session: date | None
    scheduled_fill_instant: datetime | None


class PersistedFill(_Frozen):
    session_date: date
    actual_fill_instant: datetime
    side: str
    asset: str
    quantity: float
    price: float
    cost: float
    cash_delta: float
    scaled: bool


class PersistedNote(_Frozen):
    session_date: date
    code: str
    message: str


class PersistedStaleMark(_Frozen):
    session_date: date
    asset: str
    mark_date: date


class PersistedDiagnostic(_Frozen):
    code: str
    message: str
    node_path: tuple[str, ...]
    subject: str | None


class PersistedRunRecord(_Frozen):
    """The complete durable fact set of one run (trace stored separately, same transaction)."""

    record_format: int = Field(ge=1)
    run_id: str
    mode: str  # "backtest" in v0
    strategy_id: str
    strategy_version: int
    ok: bool
    exchange: str
    timezone: str
    first_session: date | None
    last_session: date | None
    valuations: tuple[tuple[date, float], ...]
    returns: tuple[float, ...]
    total_return: float
    max_drawdown: float
    final_cash: float
    final_positions: tuple[tuple[str, float], ...]
    evaluations: tuple[PersistedEvaluation, ...]
    fills: tuple[PersistedFill, ...]
    stale_marks: tuple[PersistedStaleMark, ...]
    notes: tuple[PersistedNote, ...]
    diagnostics: tuple[PersistedDiagnostic, ...]


def record_from_result(
    result: BacktestResult,
    *,
    strategy_id: str,
    strategy_version: int,
    mode: str = RUN_MODE_BACKTEST,
) -> PersistedRunRecord:
    """Copy the run's facts into the durable shape. Pure read — never mutates *result*.

    Strategy identity comes from the DOCUMENT (it is not a ``BacktestResult`` fact); *mode*
    records HOW the facts were produced (backtest vs M8 forward replay) — same engine core,
    so the record shape is mode-agnostic.
    """
    return PersistedRunRecord(
        record_format=RECORD_FORMAT,
        run_id=result.run_id,
        mode=mode,
        strategy_id=strategy_id,
        strategy_version=strategy_version,
        ok=result.ok,
        exchange=result.exchange,
        timezone=result.timezone,
        first_session=result.first_session,
        last_session=result.last_session,
        valuations=result.valuations,
        returns=result.returns,
        total_return=result.total_return,
        max_drawdown=result.max_drawdown,
        final_cash=result.final_state.cash,
        final_positions=result.final_state.positions,
        evaluations=tuple(
            PersistedEvaluation(
                session_date=record.session_date,
                evaluation_instant=record.evaluation_instant,
                target_weights=record.target_weights,
                ok=record.reconciliation.ok,
                portfolio_value=record.reconciliation.portfolio_value,
                target_cash=record.reconciliation.target_cash,
                projected_cash=record.reconciliation.projected_cash,
                plans=tuple(
                    PersistedPlanRow(
                        asset=plan.asset,
                        price=plan.price,
                        current_quantity=plan.current_quantity,
                        target_weight=plan.target_weight,
                        target_notional=plan.target_notional,
                        target_quantity=plan.target_quantity,
                        delta_quantity=plan.delta_quantity,
                        action=plan.action,
                    )
                    for plan in record.reconciliation.plans
                ),
                orders=tuple(
                    PersistedOrder(side=order.side, asset=order.asset, quantity=order.quantity)
                    for order in record.reconciliation.orders
                ),
                fill_session=record.fill_session,
                scheduled_fill_instant=record.scheduled_fill_instant,
            )
            for record in result.evaluations
        ),
        fills=tuple(
            PersistedFill(
                session_date=event.session_date,
                actual_fill_instant=event.actual_fill_instant,
                side=event.fill.side,
                asset=event.fill.asset,
                quantity=event.fill.quantity,
                price=event.fill.price,
                cost=event.fill.cost,
                cash_delta=event.fill.cash_delta,
                scaled=event.fill.scaled,
            )
            for event in result.fills
        ),
        stale_marks=tuple(
            PersistedStaleMark(
                session_date=mark.session_date, asset=mark.asset, mark_date=mark.mark_date
            )
            for mark in result.stale_marks
        ),
        notes=tuple(
            PersistedNote(session_date=note.session_date, code=note.code, message=note.message)
            for note in result.notes
        ),
        diagnostics=tuple(
            PersistedDiagnostic(
                code=diag.code,
                message=diag.message,
                node_path=diag.node_path,
                subject=diag.subject,
            )
            for diag in result.diagnostics
        ),
    )
