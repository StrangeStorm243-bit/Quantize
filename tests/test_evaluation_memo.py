"""Pre-M9 C1: the run-scoped evaluation memo is a SPEED-ONLY channel.

The memo lets ``transform.moving_average`` reuse points it already computed at earlier
evaluation instants of the same run (a computed point is immutable: visibility is monotone in
the cutoff, the dataset is frozen, and each point's window sum reads the same closes). These
tests are the exactness proof: with and without the memo, a run's ENTIRE result is identical —
record fields bit-for-bit via ``repr`` (which distinguishes -0.0 from 0.0), the trace compared
explicitly event-for-event (it is ``repr=False`` on ``BacktestResult``, so the top-level repr
does NOT cover it), and the canonical persisted bytes byte-for-byte.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from quantize.engine.backtest import SessionEngine
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataSet, PriceObservation
from quantize.nodes import build_core_catalog
from quantize.persistence.provenance import recorded_input_provenance
from quantize.persistence.records import record_from_result
from quantize.persistence.serialize import model_bytes
from quantize.runtime.binding import EvaluationMemo
from quantize.schema.document import StrategyDocument
from tests.helpers import load_fixture
from tests.market_fixture import build_market_fixture

RUN_ID = "3b000000-0000-0000-0000-000000000001"


def _drive(
    document: StrategyDocument,
    market: MarketDataSet,
    *,
    memo_enabled: bool,
    collect_trace: bool,
) -> BacktestResult:
    engine = SessionEngine(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState(cash=1_000_000.0),
        components=None,
        first_session=None,
        last_session=None,
        collect_trace=collect_trace,
    )
    assert isinstance(engine.memo, EvaluationMemo)  # the engine owns one memo per run
    if not memo_enabled:
        engine.memo = None  # the None channel: every evaluation recomputes from scratch
    assert engine.preflight() is None
    for session in engine.sessions:
        failure = engine.step(session)
        assert failure is None, failure
    if memo_enabled:
        # The channel is genuinely exercised: the run left cached moving-average points.
        assert engine.memo is not None and not engine.memo.is_empty()
    return engine.finish(True)


def test_memo_on_equals_memo_off_bit_exactly_for_strategy_b() -> None:
    document = StrategyDocument.model_validate(load_fixture("strategy_b"))
    market = build_market_fixture()
    for collect_trace in (True, False):
        with_memo = _drive(document, market, memo_enabled=True, collect_trace=collect_trace)
        without = _drive(document, market, memo_enabled=False, collect_trace=collect_trace)
        # Bit-exact on the record fields (repr distinguishes -0.0; trace is repr=False so it
        # is compared EXPLICITLY below, sign-sensitively, event for event).
        assert repr(with_memo) == repr(without)
        assert with_memo.trace == without.trace
        assert [repr(event) for event in with_memo.trace] == [
            repr(event) for event in without.trace
        ]
        if collect_trace:
            assert with_memo.trace  # the comparison is not vacuous
        provenance = recorded_input_provenance(market)
        record_with = record_from_result(
            with_memo,
            strategy_id=document.strategy.id,
            strategy_version=1,
            input_provenance=provenance,
        )
        record_without = record_from_result(
            without,
            strategy_id=document.strategy.id,
            strategy_version=1,
            input_provenance=provenance,
        )
        assert model_bytes(record_with) == model_bytes(record_without)


def _lagged_market() -> MarketDataSet:
    """Four sessions; BBB's D2 close is vendor-lagged to D3's close instant.

    At the D2 evaluation the MA(2) point at D2 for BBB is NOT computable; at the D3
    evaluation it becomes computable (late arrival) alongside D3's own point — the memo's
    re-attempt path must produce exactly what a from-scratch evaluation produces.
    """
    days = [date(2026, 1, 5) + timedelta(days=i) for i in range(4)]
    sessions = tuple(
        MarketSession(
            session_date=day,
            open_at=datetime(day.year, day.month, day.day, 14, 30, tzinfo=UTC),
            close_at=datetime(day.year, day.month, day.day, 21, 0, tzinfo=UTC),
        )
        for day in days
    )
    calendar = ExchangeCalendar(exchange="QSE", timezone="UTC-05:00", sessions=sessions)

    def observation(
        day_index: int, price: float, close_lag_to: int | None = None
    ) -> PriceObservation:
        session = sessions[day_index]
        close_at = sessions[close_lag_to].close_at if close_lag_to is not None else session.close_at
        return PriceObservation(
            session_date=session.session_date,
            open_price=price,
            close_price=price,
            open_available_at=session.open_at,
            close_available_at=close_at,
        )

    return MarketDataSet(
        calendar=calendar,
        observations={
            "AAA": [
                observation(0, 10.0),
                observation(1, 11.0),
                observation(2, 12.0),
                observation(3, 13.0),
            ],
            # BBB's D2 close arrives only at D3's close (vendor lag).
            "BBB": [
                observation(0, 20.0),
                observation(1, 19.0, close_lag_to=2),
                observation(2, 18.0),
                observation(3, 17.0),
            ],
        },
    )


def test_memo_reattempts_late_arriving_points_identically() -> None:
    # A minimal MA(2) strategy over AAA/BBB (strategy B's shape, sized to the lagged dataset).
    from quantize.schema.nodes import Edge, NodeInstance, RegisteredNode
    from tests.engine_harness import make_document

    nodes: list[NodeInstance] = [
        RegisteredNode(
            id="u",
            type_id="universe.fixed_list",
            type_version="1.0.0",
            params={"tickers": ["AAA", "BBB"]},
        ),
        RegisteredNode(id="px", type_id="data.price", type_version="1.0.0", params={}),
        RegisteredNode(
            id="ma",
            type_id="transform.moving_average",
            type_version="1.0.0",
            params={"window": 2},
        ),
        RegisteredNode(id="lt", type_id="transform.latest", type_version="1.0.0", params={}),
        RegisteredNode(id="rk", type_id="transform.rank", type_version="1.0.0", params={}),
        RegisteredNode(
            id="sel", type_id="portfolio.select_top_n", type_version="1.0.0", params={"n": 1}
        ),
        RegisteredNode(id="ew", type_id="portfolio.equal_weight", type_version="1.0.0", params={}),
        RegisteredNode(id="tp", type_id="output.target_portfolio", type_version="1.0.0", params={}),
    ]
    edges = [
        Edge.model_validate({"from": ("u", "assets"), "to": ("px", "assets")}),
        Edge.model_validate({"from": ("px", "series"), "to": ("ma", "series")}),
        Edge.model_validate({"from": ("ma", "series"), "to": ("lt", "series")}),
        Edge.model_validate({"from": ("lt", "values"), "to": ("rk", "values")}),
        Edge.model_validate({"from": ("rk", "values"), "to": ("sel", "scores")}),
        Edge.model_validate({"from": ("u", "assets"), "to": ("sel", "universe")}),
        Edge.model_validate({"from": ("sel", "assets"), "to": ("ew", "assets")}),
        Edge.model_validate({"from": ("ew", "targets"), "to": ("tp", "targets")}),
    ]
    ma_document = make_document(nodes, edges, bps=0.0)
    market = _lagged_market()

    with_memo = _drive(ma_document, market, memo_enabled=True, collect_trace=True)
    without = _drive(ma_document, market, memo_enabled=False, collect_trace=True)
    assert repr(with_memo) == repr(without)
    assert with_memo.trace == without.trace
    assert [repr(event) for event in with_memo.trace] == [repr(event) for event in without.trace]

    # The lag genuinely exercises the re-attempt path: BBB is EXCLUDED at the D2 evaluation
    # (its D2 close invisible -> no MA(2) point at D2) and INCLUDED from the D3 evaluation.
    d2, d3 = date(2026, 1, 6), date(2026, 1, 7)
    by_session = {e.session_date: dict(e.target_weights) for e in with_memo.evaluations}
    assert by_session[d2] == {"AAA": 1.0}  # BBB unrankable at D2
    assert "BBB" in by_session[d3]  # late close arrived; BBB scored at D3


def test_memo_rejects_a_strictly_earlier_evaluation_instant() -> None:
    """A cached point is only guaranteed visible at the instant that computed it AND LATER —
    replaying one at an earlier cutoff would be look-ahead, so the memo fails loud."""
    import pytest

    memo = EvaluationMemo()
    later = datetime(2026, 1, 7, 21, 0, tzinfo=UTC)
    earlier = datetime(2026, 1, 6, 21, 0, tzinfo=UTC)
    memo.assert_monotonic(later)
    memo.assert_monotonic(later)  # equal instants are fine (several nodes per evaluation)
    with pytest.raises(ValueError, match="non-decreasing"):
        memo.assert_monotonic(earlier)
