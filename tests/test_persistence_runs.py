"""M7.5/M7.6: run + trace persistence — fact preservation, atomicity, corruption, goldens."""

from __future__ import annotations

import copy
import json
from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest

from quantize.engine.backtest import run_backtest
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.persistence.database import Database
from quantize.persistence.documents import StrategyRepository
from quantize.persistence.errors import (
    ARTIFACT_CONFLICT,
    ARTIFACT_NOT_FOUND,
    CORRUPT_ARTIFACT,
    UNSUPPORTED_ARTIFACT_VERSION,
    PersistenceError,
)
from quantize.persistence.migrations import ArtifactMigration, ArtifactMigrationRegistry
from quantize.persistence.records import RECORD_FORMAT, PersistedRunRecord
from quantize.persistence.runs import RunRepository, RunSummary
from quantize.persistence.serialize import content_hash
from quantize.schema.document import StrategyDocument
from quantize.tracing.events import TraceEvent
from quantize.tracing.tree import build_trace_trees
from tests.golden_utils import (
    GOLDEN_FORMAT,
    assert_summary_matches_golden,
    golden_bytes,
    trace_tree_summary,
)
from tests.helpers import load_fixture
from tests.market_fixture import build_market_fixture

RUN_ID = "99999999-9999-9999-9999-999999999999"
INITIAL_CASH = 1_000_000.0


@pytest.fixture(scope="module")
def market() -> MarketDataSet:
    return build_market_fixture()


def _document(name: str) -> StrategyDocument:
    return StrategyDocument.model_validate(load_fixture(name))


def _run(document: StrategyDocument, market: MarketDataSet) -> BacktestResult:
    return run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
    )


@pytest.fixture(scope="module")
def strategy_a(market: MarketDataSet) -> tuple[StrategyDocument, BacktestResult]:
    document = _document("strategy_a")
    return document, _run(document, market)


@pytest.fixture(scope="module")
def strategy_b(market: MarketDataSet) -> tuple[StrategyDocument, BacktestResult]:
    document = _document("strategy_b")
    return document, _run(document, market)


@pytest.fixture
def db(tmp_path: Path) -> Iterator[Database]:
    database = Database(tmp_path / "q.db")
    yield database
    database.close()


# --- fact preservation ----------------------------------------------------------------------------


@pytest.mark.parametrize("strategy_fixture", ["strategy_a", "strategy_b"])
def test_run_facts_survive_round_trip_exactly(
    db: Database, strategy_fixture: str, request: pytest.FixtureRequest
) -> None:
    document, result = request.getfixturevalue(strategy_fixture)
    repository = RunRepository(db)
    trace_snapshot = copy.deepcopy(result.trace)  # mutable payload dicts: snapshot BEFORE save
    run_id = repository.save_run(document, result)
    assert result.trace == trace_snapshot  # save never mutated inputs
    record = repository.load_run(run_id)
    assert record.record_format == RECORD_FORMAT
    assert record.mode == "backtest"
    assert record.strategy_id == document.strategy.id
    assert record.strategy_version == document.strategy.version
    # Facts, never recomputed: every field equals what the engine actually did.
    assert record.ok == result.ok
    assert record.exchange == result.exchange and record.timezone == result.timezone
    assert record.valuations == result.valuations
    assert record.returns == result.returns
    assert record.total_return == result.total_return
    assert record.max_drawdown == result.max_drawdown
    assert record.final_cash == result.final_state.cash
    assert record.final_positions == result.final_state.positions
    assert len(record.evaluations) == len(result.evaluations)
    for stored, live in zip(record.evaluations, result.evaluations, strict=True):
        assert stored.session_date == live.session_date
        assert stored.evaluation_instant == live.evaluation_instant  # instants ARE facts
        assert stored.scheduled_fill_instant == live.scheduled_fill_instant
        assert stored.target_weights == live.target_weights
        assert stored.portfolio_value == live.reconciliation.portfolio_value
        assert stored.target_cash == live.reconciliation.target_cash
        assert stored.projected_cash == live.reconciliation.projected_cash
        assert [(p.asset, p.action, p.delta_quantity) for p in stored.plans] == [
            (p.asset, p.action, p.delta_quantity) for p in live.reconciliation.plans
        ]
        assert [(o.side, o.asset, o.quantity) for o in stored.orders] == [
            (o.side, o.asset, o.quantity) for o in live.reconciliation.orders
        ]
    assert [(f.asset, f.quantity, f.price, f.scaled) for f in record.fills] == [
        (e.fill.asset, e.fill.quantity, e.fill.price, e.fill.scaled) for e in result.fills
    ]
    assert [(n.session_date, n.code) for n in record.notes] == [
        (n.session_date, n.code) for n in result.notes
    ]
    assert [(m.session_date, m.asset, m.mark_date) for m in record.stale_marks] == [
        (m.session_date, m.asset, m.mark_date) for m in result.stale_marks
    ]


def test_trace_stream_reloads_byte_and_object_exact(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    document, result = strategy_a
    repository = RunRepository(db)
    run_id = repository.save_run(document, result)
    reloaded = repository.load_trace(run_id)
    assert reloaded == result.trace  # full value equality incl. instants + payloads
    # And against the M6 committed goldens (external byte oracle — proves losslessness even
    # against a hypothetical shared engine+persistence bug).
    trees = {tree.instant: tree for tree in build_trace_trees(reloaded)}
    session = build_market_fixture().calendar.session_on(date(2025, 7, 31))
    assert session is not None
    committed = Path(__file__).parent / "goldens" / "trace_strategy_a_first_evaluation.json"
    assert golden_bytes(trace_tree_summary(trees[session.close_at])) == committed.read_bytes()


def test_date_keyed_trace_retrieval(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    document, result = strategy_a
    repository = RunRepository(db)
    run_id = repository.save_run(document, result)
    events = repository.load_trace(run_id, session_date=date(2025, 8, 1))
    assert events  # the first fill session
    assert {event.timestamp.date() for event in events} == {date(2025, 8, 1)}
    assert [tree.instant.date() for tree in build_trace_trees(events)] == [date(2025, 8, 1)]
    assert repository.load_trace(run_id, session_date=date(2024, 1, 1)) == ()


def test_run_and_document_save_are_idempotent_and_conflicting_diverges(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    document, result = strategy_a
    repository = RunRepository(db)
    run_id = repository.save_run(document, result)
    assert repository.save_run(document, result) == run_id  # idempotent, incl. document
    assert db.query("SELECT COUNT(*) FROM runs")[0][0] == 1
    divergent = _run(document, build_market_fixture())  # same run_id, same facts -> idempotent
    assert repository.save_run(document, divergent) == run_id


def test_divergent_run_content_under_same_run_id_is_a_conflict(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    import dataclasses

    document, result = strategy_a
    repository = RunRepository(db)
    repository.save_run(document, result)
    divergent = dataclasses.replace(result, total_return=result.total_return + 1.0)
    with pytest.raises(PersistenceError) as caught:
        repository.save_run(document, divergent)
    assert caught.value.code == ARTIFACT_CONFLICT
    assert repository.load_run(result.run_id).total_return == result.total_return


def test_duplicate_run_with_divergent_trace_is_a_conflict(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    # Codex BLOCKER: identical run facts with a different trace stream must be a conflict —
    # never a silent idempotent accept that hides trace loss.
    import dataclasses

    document, result = strategy_a
    repository = RunRepository(db)
    repository.save_run(document, result)
    for divergent_trace in (
        (),
        result.trace[:-1],
        (result.trace[1], result.trace[0], *result.trace[2:]),
    ):
        divergent = dataclasses.replace(result, trace=divergent_trace)
        with pytest.raises(PersistenceError) as caught:
            repository.save_run(document, divergent)
        assert caught.value.code == ARTIFACT_CONFLICT
    assert len(repository.load_trace(result.run_id)) == len(result.trace)  # original intact


def test_run_without_trace_loads_an_empty_stream(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    import dataclasses

    document, result = strategy_a
    repository = RunRepository(db)
    run_id = repository.save_run(document, dataclasses.replace(result, trace=()))
    assert repository.load_trace(run_id) == ()


def test_list_runs_summaries(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    document, result = strategy_a
    repository = RunRepository(db)
    run_id = repository.save_run(document, result)
    summaries = repository.list_runs()
    assert len(summaries) == 1
    summary = summaries[0]
    assert isinstance(summary, RunSummary)
    assert summary.run_id == run_id and summary.ok and summary.mode == "backtest"
    assert summary.total_return == result.total_return
    assert summary.first_session == "2025-01-02" and summary.last_session == "2026-06-30"
    assert repository.list_runs(document.strategy.id) == summaries
    assert repository.list_runs("00000000-0000-0000-0000-000000000000") == ()


# --- atomicity ------------------------------------------------------------------------------------


def test_failed_save_persists_nothing(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    """Fault injected MID-TRANSACTION: the strategy row, run row, and two trace events are
    already written when the third event's timestamp fails to render -> full rollback leaves
    NO strategy, run, or trace rows (the plan's in-transaction auto-save). The booby-trapped
    timestamp raises only on its SECOND isoformat call: the first feeds the up-front trace
    hash (pre-transaction), the second is the in-transaction INSERT."""
    import dataclasses
    from datetime import datetime

    class BoobyTrappedDatetime(datetime):
        calls = 0

        def isoformat(self, *args: object, **kwargs: object) -> str:
            type(self).calls += 1
            if type(self).calls >= 2:
                raise ValueError("mid-transaction fault")
            return super().isoformat(*args, **kwargs)  # type: ignore[arg-type]

    document, result = strategy_a
    source = result.trace[2].timestamp
    trapped = BoobyTrappedDatetime(
        source.year,
        source.month,
        source.day,
        source.hour,
        source.minute,
        source.second,
        source.microsecond,
        tzinfo=source.tzinfo,
    )
    poisoned_event = TraceEvent.model_construct(
        run_id=result.run_id,
        timestamp=trapped,
        node_id="poison",
        component_path=(),
        event_type="x.poison",
        payload={"v": 1},
    )
    poisoned = dataclasses.replace(
        result, trace=(*result.trace[:2], poisoned_event, *result.trace[3:])
    )
    repository = RunRepository(db)
    with pytest.raises(ValueError, match="mid-transaction fault"):
        repository.save_run(document, poisoned)
    assert db.query("SELECT COUNT(*) FROM runs")[0][0] == 0
    assert db.query("SELECT COUNT(*) FROM trace_events")[0][0] == 0
    assert db.query("SELECT COUNT(*) FROM strategies")[0][0] == 0  # auto-save rolled back too
    # A clean retry on the same database succeeds (nothing half-written blocks it).
    assert repository.save_run(document, result) == result.run_id


def test_non_portable_save_input_is_a_structured_error(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    # Codex HIGH (round 3): a non-portable artifact at SAVE time surfaces as invalid_artifact,
    # never a raw ValueError escaping model_bytes.
    import dataclasses

    from quantize.persistence.errors import INVALID_ARTIFACT

    document, result = strategy_a
    nan_event = TraceEvent.model_construct(
        run_id=result.run_id,
        timestamp=result.trace[0].timestamp,
        node_id="poison",
        component_path=(),
        event_type="x.poison",
        payload={"v": float("nan")},
    )
    poisoned = dataclasses.replace(result, trace=(nan_event, *result.trace[1:]))
    repository = RunRepository(db)
    with pytest.raises(PersistenceError) as caught:
        repository.save_run(document, poisoned)
    assert caught.value.code == INVALID_ARTIFACT
    assert caught.value.context["kind"] == "trace_event"
    assert db.query("SELECT COUNT(*) FROM runs")[0][0] == 0  # nothing persisted


def test_trace_rows_require_their_run(db: Database) -> None:
    with pytest.raises(Exception) as caught, db.transaction() as connection:
        connection.execute(
            "INSERT INTO trace_events (run_id, seq, trace_format, timestamp, event) "
            "VALUES ('orphan', 0, 1, 't', '{}')"
        )
    assert "FOREIGN KEY" in str(caught.value)


# --- corruption & version gates -------------------------------------------------------------------


def _saved(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> tuple[RunRepository, str]:
    document, result = strategy_a
    repository = RunRepository(db)
    return repository, repository.save_run(document, result)


def test_missing_run_is_structured(db: Database) -> None:
    repository = RunRepository(db)
    for call in (lambda: repository.load_run("nope"), lambda: repository.load_trace("nope")):
        with pytest.raises(PersistenceError) as caught:
            call()
        assert caught.value.code == ARTIFACT_NOT_FOUND


def test_tampered_or_shortened_trace_streams_are_corrupt(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    """Codex blocker (round 3): seq contiguity alone cannot see a deleted TAIL or a valid-JSON
    byte tamper — the recorded trace hash + count bind the WHOLE stream at load."""
    document, result = strategy_a
    # (a) mid-stream deletion -> count mismatch
    repository, run_id = _saved(db, strategy_a)
    with db.transaction() as connection:
        connection.execute("DELETE FROM trace_events WHERE run_id = ? AND seq = 5", (run_id,))
    with pytest.raises(PersistenceError) as caught:
        repository.load_trace(run_id)
    assert caught.value.code == CORRUPT_ARTIFACT
    assert caught.value.context["recorded"] == len(result.trace)
    # (b) TAIL deletion (contiguity would pass; the count must not)
    last = len(result.trace) - 1
    with db.transaction() as connection:
        connection.execute(
            "INSERT INTO trace_events (run_id, seq, trace_format, timestamp, event) "
            "SELECT run_id, 5, trace_format, timestamp, event FROM trace_events "
            "WHERE run_id = ? AND seq = 6",
            (run_id,),
        )  # restore a row so only the tail differs
        connection.execute("DELETE FROM trace_events WHERE run_id = ? AND seq = ?", (run_id, last))
    with pytest.raises(PersistenceError) as caught:
        repository.load_trace(run_id)
    assert caught.value.code == CORRUPT_ARTIFACT


def test_byte_tampered_trace_event_fails_the_stream_hash(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    repository, run_id = _saved(db, strategy_a)
    rows = db.query("SELECT event FROM trace_events WHERE run_id = ? AND seq = 0", (run_id,))
    tampered = str(rows[0][0]).replace('"v":1', '"v":1,"forged":true', 1)
    assert tampered != rows[0][0]
    with db.transaction() as connection:  # valid JSON, count + contiguity intact
        connection.execute(
            "UPDATE trace_events SET event = ? WHERE run_id = ? AND seq = 0",
            (tampered, run_id),
        )
    with pytest.raises(PersistenceError) as caught:
        repository.load_trace(run_id)
    assert caught.value.code == CORRUPT_ARTIFACT
    assert "content hash" in caught.value.message


def test_tampered_record_bytes_fail_the_hash(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    repository, run_id = _saved(db, strategy_a)
    with db.transaction() as connection:
        connection.execute(
            "UPDATE runs SET record = replace(record, '\"ok\":true', '\"ok\":false')"
        )
    with pytest.raises(PersistenceError) as caught:
        repository.load_run(run_id)
    assert caught.value.code == CORRUPT_ARTIFACT


def test_unknown_record_and_trace_formats_are_rejected(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    repository, run_id = _saved(db, strategy_a)
    rows = db.query("SELECT record FROM runs WHERE run_id = ?", (run_id,))
    payload = json.loads(str(rows[0][0]))
    payload["record_format"] = 99  # a consistent artifact from a FUTURE format
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with db.transaction() as connection:
        connection.execute(
            "UPDATE runs SET record = ?, record_format = 99, content_hash = ?",
            (raw, content_hash(raw.encode("utf-8"))),
        )
    with pytest.raises(PersistenceError) as caught:
        repository.load_run(run_id)
    assert caught.value.code == UNSUPPORTED_ARTIFACT_VERSION
    with db.transaction() as connection:
        connection.execute("UPDATE trace_events SET trace_format = 99 WHERE seq = 0")
    with pytest.raises(PersistenceError) as caught:
        repository.load_trace(run_id)
    assert caught.value.code == UNSUPPORTED_ARTIFACT_VERSION


def test_row_and_payload_record_format_must_agree(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    # Codex HIGH: a payload claiming a different format than its row is corruption; and a
    # migrated payload must land exactly at the current format.
    repository, run_id = _saved(db, strategy_a)
    rows = db.query("SELECT record FROM runs WHERE run_id = ?", (run_id,))
    payload = json.loads(str(rows[0][0]))
    payload["record_format"] = 99
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with db.transaction() as connection:  # row still says 1
        connection.execute(
            "UPDATE runs SET record = ?, content_hash = ?",
            (raw, content_hash(raw.encode("utf-8"))),
        )
    with pytest.raises(PersistenceError) as caught:
        repository.load_run(run_id)
    assert caught.value.code == CORRUPT_ARTIFACT


def test_nan_in_stored_record_is_corrupt_not_loaded(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    # Codex HIGH: default json.loads accepts the non-standard NaN token; the load path must not.
    repository, run_id = _saved(db, strategy_a)
    rows = db.query("SELECT record FROM runs WHERE run_id = ?", (run_id,))
    raw = str(rows[0][0]).replace('"total_return":', '"total_return":NaN,"x":', 1)
    with db.transaction() as connection:
        connection.execute(
            "UPDATE runs SET record = ?, content_hash = ?",
            (raw, content_hash(raw.encode("utf-8"))),
        )
    with pytest.raises(PersistenceError) as caught:
        repository.load_run(run_id)
    assert caught.value.code == CORRUPT_ARTIFACT


def test_non_integer_format_columns_are_corrupt(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    # Codex MEDIUM: SQLite happily stores text in INTEGER columns; that must surface as a
    # structured corruption error, never an AssertionError.
    repository, run_id = _saved(db, strategy_a)
    with db.transaction() as connection:
        connection.execute("UPDATE runs SET record_format = 'bad'")
    with pytest.raises(PersistenceError) as caught:
        repository.load_run(run_id)
    assert caught.value.code == CORRUPT_ARTIFACT
    with db.transaction() as connection:
        connection.execute("UPDATE runs SET record_format = ?", (RECORD_FORMAT,))
        connection.execute("UPDATE trace_events SET trace_format = 'bad' WHERE seq = 0")
    with pytest.raises(PersistenceError) as caught:
        repository.load_trace(run_id)
    assert caught.value.code == CORRUPT_ARTIFACT


def test_format_zero_row_migrates_through_the_production_load_path(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    """The migration SEAM proof: a synthetic 0->1 run-record migration registered in a registry
    of the production type, dispatched by the REAL load_run path (format check -> chain ->
    domain validation), differing from a real future migration only by its content."""
    repository, run_id = _saved(db, strategy_a)
    baseline = repository.load_run(run_id)
    # Rewrite the stored row to an imaginary format-0 shape (mode absent, spelled 'kind').
    rows = db.query("SELECT record FROM runs WHERE run_id = ?", (run_id,))
    payload = json.loads(str(rows[0][0]))
    payload["kind"] = payload.pop("mode")
    payload["record_format"] = 0
    old_bytes = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with db.transaction() as connection:
        connection.execute(
            "UPDATE runs SET record = ?, record_format = 0, content_hash = ?",
            (old_bytes.decode("utf-8"), content_hash(old_bytes)),
        )

    def upgrade(old: dict[str, object]) -> dict[str, object]:
        new = dict(old)
        new["mode"] = new.pop("kind")
        new["record_format"] = RECORD_FORMAT
        return new

    registry = ArtifactMigrationRegistry()
    registry.register(
        ArtifactMigration(
            kind="run_record",
            from_version=0,
            migrate=upgrade,
            dropped_keys=frozenset({"kind"}),
            example_input={"kind": "backtest", "record_format": 0},
        )
    )
    migrated = RunRepository(db, migrations=registry).load_run(run_id)
    assert migrated == baseline  # deterministic, lossless, fully validated


# --- determinism goldens (cross-platform anchors) ------------------------------------------------


def _windowed_run(market: MarketDataSet) -> tuple[StrategyDocument, BacktestResult]:
    document = _document("strategy_a")
    result = run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=INITIAL_CASH),
        first_session=date(2025, 7, 31),
        last_session=date(2025, 8, 29),
    )
    assert result.ok
    return document, result


def test_persisted_artifacts_are_deterministic_across_databases(
    tmp_path: Path, market: MarketDataSet, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    document, result = strategy_a
    stored: list[tuple[object, ...]] = []
    for name in ("one.db", "two.db"):
        with Database(tmp_path / name) as database:
            RunRepository(database).save_run(document, result)
            stored.append(
                database.query("SELECT content_hash, record FROM runs")[0]
                + database.query("SELECT content_hash, document FROM strategies")[0]
            )
    assert stored[0] == stored[1]  # identical bytes + hashes, saved_at excluded from identity


def test_persistence_golden(market: MarketDataSet, tmp_path: Path, update_goldens: bool) -> None:
    """Committed byte anchor: the canonical persisted envelope of a small deterministic run.
    CI re-checks these bytes on Linux/3.13/3.14 — the cross-platform determinism proof."""
    document, result = _windowed_run(market)
    with Database(tmp_path / "g.db") as database:
        repository = RunRepository(database)
        run_id = repository.save_run(document, result)
        run_hash, record_raw = database.query("SELECT content_hash, record FROM runs")[0]
        doc_hash, doc_raw = database.query("SELECT content_hash, document FROM strategies")[0]
        record = repository.load_run(run_id)
    assert isinstance(record_raw, str) and isinstance(doc_raw, str)
    summary = {
        "golden_format": GOLDEN_FORMAT,
        "run_id": run_id,
        "record_format": record.record_format,
        "run_content_hash": run_hash,  # SHA-256 of the exact stored record bytes
        "document_content_hash": doc_hash,  # SHA-256 of the exact stored document bytes
        "record": json.loads(record_raw),
        "document": json.loads(doc_raw),
    }
    assert_summary_matches_golden("persisted_run_envelope", summary, update_goldens)


# --- backend never leaks --------------------------------------------------------------------------


def test_contracts_expose_only_domain_objects_and_plain_values(
    db: Database, strategy_a: tuple[StrategyDocument, BacktestResult]
) -> None:
    import sqlite3

    document, result = strategy_a
    repository = RunRepository(db)
    run_id = repository.save_run(document, result)
    values: list[object] = [run_id, repository.load_run(run_id)]
    values.extend(repository.load_trace(run_id))
    values.extend(repository.list_runs())
    strategies = StrategyRepository(db)
    values.append(strategies.load(document.strategy.id, document.strategy.version))
    values.extend(strategies.list_strategies())
    for value in values:
        assert not isinstance(value, (sqlite3.Row, sqlite3.Cursor, sqlite3.Connection))
        assert isinstance(
            value, (str, PersistedRunRecord, TraceEvent, RunSummary, StrategyDocument)
        ) or type(value).__module__.startswith("quantize."), type(value)
