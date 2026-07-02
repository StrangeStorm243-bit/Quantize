"""M8: backtest↔forward consistency, one-session-at-a-time discipline, restart, stored facts.

The calibrated claim (ARCHITECTURE §3): the modes share semantics; identical local data plus
the shared availability gating make FULL equality the strongest valid form of "agreement on
overlapping decisions" — asserted here field-for-field, same run_id, bounded window advanced
to exhaustion. Environment differences in v0 are NONE by construction; the divergence axes a
live adapter would introduce (data source, history depth, arrival timing) are documented in
the M8 plan and deferred with that adapter.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from quantize.engine.backtest import run_backtest
from quantize.engine.forward import ForwardReplay, SessionAdvance
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.persistence.database import Database
from quantize.persistence.records import RUN_MODE_FORWARD, record_from_result
from quantize.persistence.runs import RunRepository
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import Edge, NodeInstance, RegisteredNode
from tests.engine_harness import make_document
from tests.helpers import load_fixture
from tests.market_fixture import build_market_fixture
from tests.stateful_fixture import ACCUMULATOR_TYPE_ID, build_accumulator_catalog

RUN_ID = "99999999-9999-9999-9999-999999999999"
FORWARD_RUN_ID = "88888888-8888-8888-8888-888888888888"
INITIAL_CASH = 1_000_000.0


@pytest.fixture(scope="module")
def market() -> MarketDataSet:
    return build_market_fixture()


def _document(name: str) -> StrategyDocument:
    return StrategyDocument.model_validate(load_fixture(name))


def _last_session(market: MarketDataSet) -> date:
    return market.calendar.session_dates[-1]


def _backtest(
    document: StrategyDocument, market: MarketDataSet, **kwargs: object
) -> BacktestResult:
    return run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        **kwargs,  # type: ignore[arg-type]
    )


def _forward(
    document: StrategyDocument, market: MarketDataSet, last_session: date, run_id: str = RUN_ID
) -> ForwardReplay:
    return ForwardReplay(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=run_id,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        last_session=last_session,
    )


@pytest.fixture(scope="module")
def strategy_a_backtest(market: MarketDataSet) -> BacktestResult:
    return _backtest(_document("strategy_a"), market)


@pytest.fixture(scope="module")
def strategy_b_backtest(market: MarketDataSet) -> BacktestResult:
    return _backtest(_document("strategy_b"), market)


def _exhaust(replay: ForwardReplay) -> list[SessionAdvance]:
    advances: list[SessionAdvance] = []
    while (advance := replay.advance()) is not None:
        advances.append(advance)
    return advances


# --- battery 1: full equality --------------------------------------------------------------------


@pytest.mark.parametrize("fixture_name", ["strategy_a", "strategy_b"])
def test_forward_replay_equals_backtest_on_every_field(
    market: MarketDataSet,
    fixture_name: str,
    request: pytest.FixtureRequest,
) -> None:
    backtest = request.getfixturevalue(f"{fixture_name}_backtest")
    replay = _forward(_document(fixture_name), market, _last_session(market))
    advances = _exhaust(replay)
    assert len(advances) == 374  # every fixture session fed exactly once
    forward = replay.result()
    # Field-for-field: targets, orders, fills, valuations, notes, stale marks, metrics, final
    # state, diagnostics, AND the trace with its separately-modeled instants.
    assert forward == backtest


def test_advance_is_one_session_at_a_time(market: MarketDataSet) -> None:
    replay = _forward(_document("strategy_a"), market, _last_session(market))
    seen: list[date] = []
    while (advance := replay.advance()) is not None:
        assert advance.ok
        seen.append(advance.session_date)
        partial = replay.result()
        assert len(partial.valuations) == len(seen)  # exactly one session per advance
        assert partial.valuations[-1][0] == advance.session_date
        assert partial.valuations[-1][1] == advance.portfolio_value
    assert seen == list(market.calendar.session_dates)
    assert replay.advance() is None  # exhaustion is idempotent


# --- battery 2: persisted facts as the oracle -----------------------------------------------------


def test_forward_run_agrees_with_the_stored_backtest_facts(
    tmp_path: Path, market: MarketDataSet, strategy_a_backtest: BacktestResult
) -> None:
    document = _document("strategy_a")
    path = tmp_path / "runs.db"
    with Database(path) as database:
        RunRepository(database).save_run(document, strategy_a_backtest)
    # REOPEN: the stored artifact — not anything in memory — is the historical oracle.
    with Database(path) as database:
        repository = RunRepository(database)
        stored_record = repository.load_run(RUN_ID)
        stored_trace = repository.load_trace(RUN_ID)
    replay = _forward(document, market, _last_session(market))
    _exhaust(replay)
    forward = replay.result()
    forward_record = record_from_result(
        forward,
        strategy_id=document.strategy.id,
        strategy_version=document.strategy.version,
    )
    assert forward_record == stored_record  # every persisted fact, incl. instants
    assert forward.trace == stored_trace  # the loaded events, element for element


# --- battery 3: bounded equivalence + prefix stability --------------------------------------------


@pytest.mark.parametrize(
    "k",
    [
        date(2025, 7, 31),  # eval-boundary: the fill would land at 08-01 > k (tail-note case)
        date(2025, 8, 1),  # the day AFTER an eval: pending order fills inside the window
        date(2025, 6, 13),  # interior non-evaluation day
    ],
)
def test_bounded_forward_equals_bounded_backtest(market: MarketDataSet, k: date) -> None:
    document = _document("strategy_a")
    truncated = _backtest(document, market, last_session=k)
    replay = _forward(document, market, k)
    _exhaust(replay)
    assert replay.result() == truncated  # incl. the window-tail note semantics at k


def test_later_sessions_never_rewrite_earlier_decisions(market: MarketDataSet) -> None:
    replay = _forward(_document("strategy_a"), market, _last_session(market))
    observed: list[tuple[date, float]] = []
    while (advance := replay.advance()) is not None:
        assert advance.portfolio_value is not None
        observed.append((advance.session_date, advance.portfolio_value))
    final = replay.result()
    assert tuple(observed) == final.valuations  # per-advance facts ARE the final prefixes


# --- battery 4: restart/replay --------------------------------------------------------------------


def test_resume_with_pending_overnight_orders_is_deterministic(
    market: MarketDataSet, strategy_a_backtest: BacktestResult
) -> None:
    document = _document("strategy_a")
    last = _last_session(market)
    replay = _forward(document, market, last)
    # Advance until the first evaluation queues an overnight order, then checkpoint.
    while (advance := replay.advance()) is not None:
        if advance.evaluated:
            break
    checkpoint = replay.snapshot()
    assert checkpoint.pending is not None  # the order legitimately spans the boundary
    # The original keeps going (proves the checkpoint holds no live references)...
    _exhaust(replay)
    uninterrupted = replay.result()
    # ...and TWO independent resumes from the same checkpoint replay identically.
    for _ in range(2):
        resumed = ForwardReplay.resume(
            checkpoint,
            document,
            catalog=build_core_catalog(),
            market_data=market,
            last_session=last,
        )
        _exhaust(resumed)
        assert resumed.result() == uninterrupted
    assert uninterrupted == strategy_a_backtest  # and everything equals the backtest


def test_resume_from_final_checkpoint_is_a_noop(market: MarketDataSet) -> None:
    document = _document("strategy_a")
    last = _last_session(market)
    replay = _forward(document, market, last)
    _exhaust(replay)
    final_checkpoint = replay.snapshot()
    resumed = ForwardReplay.resume(
        final_checkpoint,
        document,
        catalog=build_core_catalog(),
        market_data=market,
        last_session=last,
    )
    assert resumed.exhausted
    assert resumed.advance() is None
    assert resumed.result() == replay.result()


# --- battery 5: test-only stateful accumulator ----------------------------------------------------


def _accumulator_document() -> StrategyDocument:
    nodes: list[NodeInstance] = [
        RegisteredNode(
            id="u",
            type_id="universe.fixed_list",
            type_version="1.0.0",
            params={"tickers": ["AGG", "SPY"]},
        ),
        RegisteredNode(id="acc", type_id=ACCUMULATOR_TYPE_ID, type_version="1.0.0", params={}),
        RegisteredNode(
            id="fw",
            type_id="portfolio.fixed_weight",
            type_version="1.0.0",
            params={"weight_per_asset": "equal"},
        ),
        RegisteredNode(id="tp", type_id="output.target_portfolio", type_version="1.0.0", params={}),
    ]
    edges = [
        Edge.model_validate({"from": ("u", "assets"), "to": ("acc", "assets")}),
        Edge.model_validate({"from": ("acc", "assets"), "to": ("fw", "assets")}),
        Edge.model_validate({"from": ("fw", "targets"), "to": ("tp", "targets")}),
    ]
    return make_document(nodes, edges, schedule="weekly", bps=0.0)


def test_stateful_trajectories_agree_between_modes(market: MarketDataSet) -> None:
    document = _accumulator_document()
    window = (date(2025, 7, 1), date(2025, 10, 31))

    # FRESH catalog + store per mode: a shared closure would concatenate trajectories.
    backtest_catalog, backtest_store = build_accumulator_catalog()
    backtest = run_backtest(
        document,
        catalog=backtest_catalog,
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        first_session=window[0],
        last_session=window[1],
    )
    assert backtest.ok, backtest.diagnostics

    forward_catalog, forward_store = build_accumulator_catalog()
    replay = ForwardReplay(
        document,
        catalog=forward_catalog,
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        first_session=window[0],
        last_session=window[1],
    )
    _exhaust(replay)
    assert replay.result() == backtest

    # Identical state trajectories given equivalent data (STRATEGY_LANGUAGE §5).
    assert len(backtest_store.points) > 3  # non-trivially long (weekly firings over 4 months)
    assert backtest_store.points == forward_store.points
    # Direct lookahead witness: each firing saw ONLY data through its own session — never k+1.
    for point in backtest_store.points:
        assert point.last_visible, "both assets are always present in the fixture"
        for _, visible_date in point.last_visible:
            assert visible_date == point.instant.date()
    counts = [point.count for point in backtest_store.points]
    assert counts == list(range(1, len(counts) + 1))  # evaluation_only cadence, in order


# --- battery 6: forward runs persist with their mode ----------------------------------------------


def test_forward_run_persists_with_forward_mode(
    tmp_path: Path, market: MarketDataSet, strategy_a_backtest: BacktestResult
) -> None:
    document = _document("strategy_a")
    replay = _forward(document, market, _last_session(market), run_id=FORWARD_RUN_ID)
    _exhaust(replay)
    forward = replay.result()
    with Database(tmp_path / "runs.db") as database:
        repository = RunRepository(database)
        repository.save_run(document, strategy_a_backtest)
        repository.save_run(document, forward, mode=RUN_MODE_FORWARD)
        summaries = {s.run_id: s.mode for s in repository.list_runs()}
        assert summaries == {RUN_ID: "backtest", FORWARD_RUN_ID: "forward"}
        loaded = repository.load_run(FORWARD_RUN_ID)
    assert loaded.mode == RUN_MODE_FORWARD
    # Same engine core: the records agree on every field except identity and mode.
    backtest_record = record_from_result(
        strategy_a_backtest,
        strategy_id=document.strategy.id,
        strategy_version=document.strategy.version,
    )
    normalized = loaded.model_copy(update={"mode": "backtest", "run_id": RUN_ID})
    assert normalized == backtest_record


# --- partial results fail closed at the persistence boundary -----------------------------------


def test_partial_forward_peek_cannot_persist_as_a_completed_run(
    tmp_path: Path, market: MarketDataSet
) -> None:
    # Codex HIGH: 10 advances -> result() peek claims ok through the full window with only a
    # prefix of the facts; the repository must fail closed, for BOTH modes.
    from quantize.persistence.errors import INVALID_ARTIFACT, PersistenceError

    document = _document("strategy_a")
    replay = _forward(document, market, _last_session(market))
    for _ in range(10):
        replay.advance()
    peek = replay.result()
    assert peek.ok and len(peek.valuations) == 10  # the misleading shape
    with Database(tmp_path / "runs.db") as database:
        repository = RunRepository(database)
        for mode_kwargs in ({}, {"mode": RUN_MODE_FORWARD}):
            with pytest.raises(PersistenceError) as caught:
                repository.save_run(document, peek, **mode_kwargs)
            assert caught.value.code == INVALID_ARTIFACT
        assert repository.list_runs() == ()  # nothing persisted
        # The same replay EXHAUSTED persists fine.
        _exhaust(replay)
        repository.save_run(document, replay.result(), mode=RUN_MODE_FORWARD)
        assert len(repository.list_runs()) == 1


def test_failed_and_empty_runs_still_persist_honestly(
    tmp_path: Path, market: MarketDataSet
) -> None:
    # ok=False partials are HONEST records and must keep persisting; so must an ok empty-window
    # run (no last_session to fall short of).
    from tests.engine_harness import fixed_weight_strategy, make_engine_dataset

    d1, d2 = date(2026, 1, 5), date(2026, 1, 6)
    data = make_engine_dataset({"AAA": {d1: (10.0, 10.0)}, "BBB": {d1: (5.0, 5.0), d2: (5.0, 5.0)}})
    document = fixed_weight_strategy(["AAA"], bps=0.0)
    failed = run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=data,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=100.0),
        last_session=d2,
    )
    assert not failed.ok
    empty = run_backtest(
        _document("strategy_a"),
        catalog=build_core_catalog(),
        market_data=market,
        run_id=FORWARD_RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        first_session=date(2030, 1, 1),
        last_session=date(2030, 12, 31),
    )
    assert empty.ok and empty.last_session is None
    with Database(tmp_path / "runs.db") as database:
        repository = RunRepository(database)
        repository.save_run(document, failed)
        repository.save_run(_document("strategy_a"), empty)
        assert {s.run_id: s.ok for s in repository.list_runs()} == {
            RUN_ID: False,
            FORWARD_RUN_ID: True,
        }


# --- abort contract ---------------------------------------------------------------------------


def test_preflight_failure_never_advances(market: MarketDataSet) -> None:
    # bps outside the engine-supported range: terminal BEFORE any session is fed.
    from tests.engine_harness import fixed_weight_strategy

    document = fixed_weight_strategy(["AGG"], bps=10_000.0)
    replay = ForwardReplay(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        last_session=_last_session(market),
    )
    assert replay.exhausted
    assert replay.advance() is None
    result = replay.result()
    assert not result.ok
    assert [d.code for d in result.diagnostics] == ["invalid_transaction_costs"]


def test_mid_replay_failure_is_terminal_and_equals_the_backtest_failure(
    market: MarketDataSet,
) -> None:
    """A fill-day failure (asset has no bar on the fill session): the failing advance reports
    ok=False, result() carries the diagnostics, later advances are None — and the failed
    forward result EQUALS the failed backtest result (equivalence holds even in failure)."""
    from tests.engine_harness import fixed_weight_strategy, make_engine_dataset

    d1, d2 = date(2026, 1, 5), date(2026, 1, 6)
    data = make_engine_dataset(
        {
            "AAA": {d1: (10.0, 10.0)},  # no bar on d2: the queued fill cannot price
            "BBB": {d1: (5.0, 5.0), d2: (5.0, 5.0)},  # keeps d2 on the calendar
        }
    )
    document = fixed_weight_strategy(["AAA"], bps=0.0)
    replay = ForwardReplay(
        document,
        catalog=build_core_catalog(),
        market_data=data,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=100.0),
        last_session=d2,
    )
    first = replay.advance()
    assert first is not None and first.ok and first.evaluated  # d1: evaluate, queue for d2
    failing = replay.advance()
    assert failing is not None and not failing.ok  # d2: the fill fails terminally
    assert failing.session_date == d2 and failing.portfolio_value is None
    assert replay.advance() is None  # a terminal run accepts no further sessions
    assert replay.advance() is None  # ... idempotently
    forward = replay.result()
    assert not forward.ok and forward.diagnostics
    backtest = run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=data,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=100.0),
        last_session=d2,
    )
    assert forward == backtest  # field-for-field, including the failure diagnostics


def test_checkpoint_of_a_failed_run_resumes_as_failed(market: MarketDataSet) -> None:
    from tests.engine_harness import fixed_weight_strategy, make_engine_dataset

    d1, d2 = date(2026, 1, 5), date(2026, 1, 6)
    data = make_engine_dataset({"AAA": {d1: (10.0, 10.0)}, "BBB": {d1: (5.0, 5.0), d2: (5.0, 5.0)}})
    document = fixed_weight_strategy(["AAA"], bps=0.0)
    replay = ForwardReplay(
        document,
        catalog=build_core_catalog(),
        market_data=data,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=100.0),
        last_session=d2,
    )
    _exhaust(replay)
    checkpoint = replay.snapshot()
    assert checkpoint.failure is not None  # a dead run checkpoints as dead
    resumed = ForwardReplay.resume(
        checkpoint,
        document,
        catalog=build_core_catalog(),
        market_data=data,
        last_session=d2,
    )
    assert resumed.exhausted
    assert resumed.advance() is None
    assert resumed.result() == replay.result()  # stays failed; never silently un-fails


# --- edges ----------------------------------------------------------------------------------------


def test_empty_window_is_immediately_exhausted(market: MarketDataSet) -> None:
    replay = ForwardReplay(
        _document("strategy_a"),
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        first_session=date(2030, 1, 1),
        last_session=date(2030, 12, 31),
    )
    assert replay.exhausted
    assert replay.advance() is None
    result = replay.result()
    assert result.ok and result.first_session is None and result.valuations == ()


def test_single_session_window(market: MarketDataSet) -> None:
    day = date(2025, 7, 31)
    document = _document("strategy_a")
    replay = ForwardReplay(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        first_session=day,
        last_session=day,
    )
    advances = _exhaust(replay)
    assert [a.session_date for a in advances] == [day]
    assert replay.result() == _backtest(document, market, first_session=day, last_session=day)


def test_result_is_non_destructive_mid_replay(market: MarketDataSet) -> None:
    document = _document("strategy_a")
    last = _last_session(market)
    replay = _forward(document, market, last)
    for _ in range(10):
        replay.advance()
    replay.result()  # peeking must not disturb the run
    _exhaust(replay)
    assert replay.result() == _backtest(document, market)
