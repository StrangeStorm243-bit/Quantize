"""Builders for engine-orchestration tests: tiny strategies + datasets with explicit open/close."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime
from typing import Literal

from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataSet, PriceObservation
from quantize.schema.components import ComponentRef
from quantize.schema.document import (
    ExecutionPolicy,
    StrategyDocument,
    StrategyMeta,
    TransactionCosts,
)
from quantize.schema.nodes import Edge, NodeInstance, RegisteredNode
from quantize.schema.primitives import JsonValue
from quantize.schema.provenance import Provenance, StrategyForkRef
from quantize.schema.schedule import Schedule, ScheduleDaily, ScheduleMonthly, ScheduleWeekly

_OWNER = "22222222-2222-2222-2222-222222222222"
RUN_ID = "77777777-7777-7777-7777-777777777777"


def _session(day: date) -> MarketSession:
    return MarketSession(
        session_date=day,
        open_at=datetime(day.year, day.month, day.day, 14, 30, tzinfo=UTC),
        close_at=datetime(day.year, day.month, day.day, 21, 0, tzinfo=UTC),
    )


def make_engine_dataset(
    bars: Mapping[str, Mapping[date, tuple[float, float]]],
) -> MarketDataSet:
    """A dataset with explicit (open, close) per asset/day; calendar = union of all days."""
    days = sorted({day for asset_bars in bars.values() for day in asset_bars})
    sessions = {day: _session(day) for day in days}
    calendar = ExchangeCalendar(
        exchange="QSE", timezone="UTC-05:00", sessions=tuple(sessions[d] for d in days)
    )
    observations = {
        asset: [
            PriceObservation(
                session_date=day,
                open_price=open_close[0],
                close_price=open_close[1],
                open_available_at=sessions[day].open_at,
                close_available_at=sessions[day].close_at,
            )
            for day, open_close in sorted(asset_bars.items())
        ]
        for asset, asset_bars in bars.items()
    }
    return MarketDataSet(calendar=calendar, observations=observations)


def _schedule(kind: Literal["daily", "weekly", "monthly"]) -> Schedule:
    if kind == "daily":
        return ScheduleDaily(kind="daily")
    if kind == "weekly":
        return ScheduleWeekly(kind="weekly")
    return ScheduleMonthly(kind="monthly")


def make_document(
    nodes: list[NodeInstance],
    edges: list[Edge],
    *,
    schedule: Literal["daily", "weekly", "monthly"] = "daily",
    bps: float = 5.0,
    component_refs: list[ComponentRef] | None = None,
) -> StrategyDocument:
    return StrategyDocument(
        schema_version="0.1.0",
        strategy=StrategyMeta(
            id=_OWNER,
            version=1,
            name="engine-fixture",
            provenance=Provenance[StrategyForkRef](
                owner=_OWNER,
                creator=_OWNER,
                contributors=[],
                visibility="private",
                duplicable=False,
                created_at=datetime(2026, 1, 1, tzinfo=UTC),
            ),
        ),
        execution_policy=ExecutionPolicy(
            policy="close_signal_next_session_open",
            valuation="session_close",
            transaction_costs=TransactionCosts(model="bps", bps=bps),
        ),
        schedule=_schedule(schedule),
        nodes=nodes,
        edges=edges,
        component_refs=component_refs or [],
    )


def fixed_weight_strategy(
    tickers: list[str],
    *,
    schedule: Literal["daily", "weekly", "monthly"] = "daily",
    bps: float = 0.0,
    weight: float | str = "equal",
) -> StrategyDocument:
    """The smallest complete engine strategy: universe -> fixed_weight -> terminal (warm-up 0)."""
    ticker_values: list[JsonValue] = list(tickers)
    nodes: list[NodeInstance] = [
        RegisteredNode(
            id="u",
            type_id="universe.fixed_list",
            type_version="1.0.0",
            params={"tickers": ticker_values},
        ),
        RegisteredNode(
            id="fw",
            type_id="portfolio.fixed_weight",
            type_version="1.0.0",
            params={"weight_per_asset": weight},
        ),
        RegisteredNode(id="tp", type_id="output.target_portfolio", type_version="1.0.0", params={}),
    ]
    edges = [
        Edge.model_validate({"from": ("u", "assets"), "to": ("fw", "assets")}),
        Edge.model_validate({"from": ("fw", "targets"), "to": ("tp", "targets")}),
    ]
    return make_document(nodes, edges, schedule=schedule, bps=bps)
