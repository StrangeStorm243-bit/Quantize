"""Pre-M9 E: run-input provenance — dataset/calendar identity, migration, mismatch reporting.

A persisted run must identify the material market-data and calendar inputs it consumed
(deterministic content hashes), or HONESTLY record that older provenance is unknown (the
format-1 -> 2 migration writes an explicit unknown — hashes are never fabricated). Identity is
sensitive to everything that can affect execution: observation values, availability instants,
session boundaries, and calendar membership.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataSet, PriceObservation
from quantize.persistence.database import Database
from quantize.persistence.errors import ARTIFACT_CONFLICT, PersistenceError
from quantize.persistence.provenance import (
    RunInputProvenance,
    calendar_fingerprint,
    dataset_fingerprint,
    input_provenance_mismatches,
    recorded_input_provenance,
    unknown_input_provenance,
)


def _sessions(count: int, *, start: date = date(2026, 4, 6)) -> tuple[MarketSession, ...]:
    days: list[date] = []
    day = start
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return tuple(
        MarketSession(
            session_date=d,
            open_at=datetime(d.year, d.month, d.day, 14, 30, tzinfo=UTC),
            close_at=datetime(d.year, d.month, d.day, 21, 0, tzinfo=UTC),
        )
        for d in days
    )


def _dataset(sessions: tuple[MarketSession, ...] | None = None) -> MarketDataSet:
    sessions = sessions or _sessions(3)
    calendar = ExchangeCalendar(exchange="QSE", timezone="UTC-05:00", sessions=sessions)
    observations = {
        "AAA": [
            PriceObservation(
                session_date=s.session_date,
                open_price=10.0 + i,
                close_price=10.5 + i,
                open_available_at=s.open_at,
                close_available_at=s.close_at,
            )
            for i, s in enumerate(sessions)
        ]
    }
    return MarketDataSet(calendar=calendar, observations=observations)


# --- identity sensitivity -------------------------------------------------------------------


def test_identical_material_inputs_yield_identical_hashes() -> None:
    first, second = _dataset(), _dataset()
    assert dataset_fingerprint(first) == dataset_fingerprint(second)
    assert calendar_fingerprint(first.calendar) == calendar_fingerprint(second.calendar)
    # Stable across repeated builds within a process too (pure function of content).
    assert dataset_fingerprint(first) == dataset_fingerprint(first)


def test_changing_one_observation_changes_the_dataset_identity() -> None:
    base = _dataset()
    sessions = base.calendar.sessions
    changed_observations = {
        "AAA": [
            replace(obs, close_price=obs.close_price + 0.01) if i == 1 else obs
            for i, obs in enumerate(base.observations["AAA"])
        ]
    }
    changed = MarketDataSet(calendar=base.calendar, observations=changed_observations)
    assert dataset_fingerprint(changed) != dataset_fingerprint(base)
    assert calendar_fingerprint(changed.calendar) == calendar_fingerprint(base.calendar)
    del sessions


def test_changing_availability_changes_the_dataset_identity() -> None:
    base = _dataset()
    delayed_observations = {
        "AAA": [
            replace(obs, close_available_at=obs.close_available_at + timedelta(hours=2))
            if i == 1
            else obs
            for i, obs in enumerate(base.observations["AAA"])
        ]
    }
    delayed = MarketDataSet(calendar=base.calendar, observations=delayed_observations)
    assert dataset_fingerprint(delayed) != dataset_fingerprint(base)


def test_changing_session_boundaries_changes_the_calendar_identity() -> None:
    sessions = _sessions(3)
    shifted = (
        sessions[0],
        MarketSession(
            session_date=sessions[1].session_date,
            open_at=sessions[1].open_at - timedelta(minutes=30),  # earlier open
            close_at=sessions[1].close_at,
        ),
        sessions[2],
    )
    base = ExchangeCalendar(exchange="QSE", timezone="UTC-05:00", sessions=sessions)
    changed = ExchangeCalendar(exchange="QSE", timezone="UTC-05:00", sessions=shifted)
    assert calendar_fingerprint(changed) != calendar_fingerprint(base)


def test_removing_a_session_changes_the_calendar_identity() -> None:
    sessions = _sessions(3)
    base = ExchangeCalendar(exchange="QSE", timezone="UTC-05:00", sessions=sessions)
    holiday = ExchangeCalendar(  # the middle session becomes a holiday
        exchange="QSE", timezone="UTC-05:00", sessions=(sessions[0], sessions[2])
    )
    assert calendar_fingerprint(holiday) != calendar_fingerprint(base)


# --- the provenance value object -------------------------------------------------------------


def test_recorded_provenance_carries_both_hashes() -> None:
    dataset = _dataset()
    provenance = recorded_input_provenance(dataset)
    assert provenance.status == "recorded"
    assert provenance.dataset_hash == dataset_fingerprint(dataset)
    assert provenance.calendar_hash == calendar_fingerprint(dataset.calendar)


def test_unknown_provenance_is_explicit_and_hashless() -> None:
    provenance = unknown_input_provenance()
    assert provenance.status == "unknown"
    assert provenance.dataset_hash is None and provenance.calendar_hash is None


def test_provenance_shape_is_internally_consistent_or_rejected() -> None:
    with pytest.raises(ValueError):
        RunInputProvenance(status="recorded", dataset_hash=None, calendar_hash=None)
    with pytest.raises(ValueError):
        RunInputProvenance(status="unknown", dataset_hash="a" * 64, calendar_hash="b" * 64)


def test_recorded_hashes_must_be_sha256_hex(  # Codex pre-M9 review: HIGH finding, part 2
) -> None:
    """A recorded provenance carries REAL digests: 64-character lowercase hex, nothing else —
    malformed 'hashes' must never enter the durable envelope."""
    valid = {"dataset_hash": "a" * 64, "calendar_hash": "b" * 64}
    assert RunInputProvenance(status="recorded", **valid).status == "recorded"
    for corrupt in ("x", "A" * 64, "a" * 63, "a" * 65, "g" * 64, ""):
        with pytest.raises(ValueError):
            RunInputProvenance(status="recorded", dataset_hash=corrupt, calendar_hash="b" * 64)
        with pytest.raises(ValueError):
            RunInputProvenance(status="recorded", dataset_hash="a" * 64, calendar_hash=corrupt)


def test_unknown_does_not_compare_equal_to_recorded() -> None:
    dataset = _dataset()
    assert unknown_input_provenance() != recorded_input_provenance(dataset)


# --- replay mismatch reporting ----------------------------------------------------------------


def test_mismatch_reporting_is_precise() -> None:
    dataset = _dataset()
    recorded = recorded_input_provenance(dataset)
    assert input_provenance_mismatches(recorded, dataset) == ()

    changed_observations = {
        "AAA": [
            replace(obs, close_price=obs.close_price * 1.001) for obs in dataset.observations["AAA"]
        ]
    }
    changed_data = MarketDataSet(calendar=dataset.calendar, observations=changed_observations)
    assert input_provenance_mismatches(recorded, changed_data) == ("dataset_mismatch",)

    sessions = dataset.calendar.sessions
    changed_calendar = ExchangeCalendar(
        exchange="QSE", timezone="UTC-05:00", sessions=(sessions[0], sessions[2])
    )
    moved = MarketDataSet(
        calendar=changed_calendar,
        observations={
            "AAA": [
                obs
                for obs in dataset.observations["AAA"]
                if obs.session_date != sessions[1].session_date
            ]
        },
    )
    assert input_provenance_mismatches(recorded, moved) == (
        "calendar_mismatch",
        "dataset_mismatch",
    )

    assert input_provenance_mismatches(unknown_input_provenance(), dataset) == (
        "unknown_provenance",
    )


# --- persistence: format 2, migration of legacy rows, immutability ---------------------------


def _saved_run(db: Database) -> tuple[str, object]:
    from quantize.engine.backtest import run_backtest
    from quantize.engine.state import PortfolioState
    from quantize.nodes import build_core_catalog
    from quantize.persistence.runs import RunRepository
    from quantize.schema.document import StrategyDocument
    from tests.helpers import load_fixture
    from tests.market_fixture import build_market_fixture

    market = build_market_fixture()
    document = StrategyDocument.model_validate(load_fixture("strategy_a"))
    result = run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id="3e000000-0000-0000-0000-000000000001",
        initial_state=PortfolioState(cash=1_000_000.0),
        collect_trace=False,
    )
    repository = RunRepository(db)
    run_id = repository.save_run(
        document, result, input_provenance=recorded_input_provenance(market)
    )
    return run_id, repository


def test_new_saves_fail_closed_on_unknown_provenance(tmp_path: Path) -> None:
    """Codex pre-M9 review (HIGH): unknown provenance is reserved for the 1->2 load migration
    of legacy rows — a BRAND-NEW save claiming unknown must be rejected structurally with NO
    rows written, or a new run is indistinguishable from a migrated legacy run."""
    from quantize.engine.backtest import run_backtest
    from quantize.engine.state import PortfolioState
    from quantize.nodes import build_core_catalog
    from quantize.persistence.errors import INVALID_ARTIFACT
    from quantize.persistence.runs import RunRepository
    from quantize.schema.document import StrategyDocument
    from tests.helpers import load_fixture
    from tests.market_fixture import build_market_fixture

    document = StrategyDocument.model_validate(load_fixture("strategy_a"))
    result = run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=build_market_fixture(),
        run_id="3e000000-0000-0000-0000-000000000003",
        initial_state=PortfolioState(cash=1_000_000.0),
        collect_trace=False,
    )
    with Database(tmp_path / "q.db") as db:
        repository = RunRepository(db)
        with pytest.raises(PersistenceError) as caught:
            repository.save_run(document, result, input_provenance=unknown_input_provenance())
        assert caught.value.code == INVALID_ARTIFACT
        assert repository.list_runs() == ()  # fail closed: nothing persisted
        assert db.query("SELECT COUNT(*) FROM strategies")[0][0] == 0  # not even the doc


def test_new_runs_persist_recorded_provenance(tmp_path: Path) -> None:
    from quantize.persistence.records import RECORD_FORMAT
    from tests.market_fixture import build_market_fixture

    assert RECORD_FORMAT == 2
    with Database(tmp_path / "q.db") as db:
        run_id, repository = _saved_run(db)
        loaded = repository.load_run(run_id)  # type: ignore[attr-defined]
        market = build_market_fixture()
        assert loaded.record_format == 2
        assert loaded.input_provenance == recorded_input_provenance(market)


def test_legacy_format_one_row_loads_as_explicit_unknown(tmp_path: Path) -> None:
    """A pre-provenance row (format 1, no input_provenance key) migrates at load to an
    EXPLICIT unknown — never a fabricated hash."""
    import json

    with Database(tmp_path / "q.db") as db:
        run_id, repository = _saved_run(db)
        # Rewrite the stored row back to format 1 by stripping the new field — building
        # exactly what an M7-era database contains.
        rows = db.query("SELECT record FROM runs WHERE run_id = ?", (run_id,))
        payload = json.loads(str(rows[0][0]))
        del payload["input_provenance"]
        payload["record_format"] = 1
        legacy = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        from quantize.persistence.serialize import content_hash

        with db.transaction() as connection:
            connection.execute(
                "UPDATE runs SET record = ?, record_format = 1, content_hash = ? WHERE run_id = ?",
                (legacy, content_hash(legacy.encode("utf-8")), run_id),
            )
        loaded = repository.load_run(run_id)  # type: ignore[attr-defined]
        assert loaded.record_format == 2  # migrated at load
        assert loaded.input_provenance == unknown_input_provenance()


def test_resaving_a_pre_upgrade_run_is_an_immutability_conflict(tmp_path: Path) -> None:
    """Re-saving the same run against a legacy format-1 row produces format-2 bytes with a
    different content hash -> ARTIFACT_CONFLICT. Persisted artifacts are immutable; the
    conflict is the INTENDED outcome, pinned here so it stays deliberate."""
    import json

    from quantize.engine.backtest import run_backtest
    from quantize.engine.state import PortfolioState
    from quantize.nodes import build_core_catalog
    from quantize.persistence.runs import RunRepository
    from quantize.persistence.serialize import content_hash
    from quantize.schema.document import StrategyDocument
    from tests.helpers import load_fixture
    from tests.market_fixture import build_market_fixture

    market = build_market_fixture()
    document = StrategyDocument.model_validate(load_fixture("strategy_a"))
    result = run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id="3e000000-0000-0000-0000-000000000002",
        initial_state=PortfolioState(cash=1_000_000.0),
        collect_trace=False,
    )
    with Database(tmp_path / "q.db") as db:
        repository = RunRepository(db)
        provenance = recorded_input_provenance(market)
        run_id = repository.save_run(document, result, input_provenance=provenance)
        rows = db.query("SELECT record FROM runs WHERE run_id = ?", (run_id,))
        payload = json.loads(str(rows[0][0]))
        del payload["input_provenance"]
        payload["record_format"] = 1
        legacy = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with db.transaction() as connection:
            connection.execute(
                "UPDATE runs SET record = ?, record_format = 1, content_hash = ? WHERE run_id = ?",
                (legacy, content_hash(legacy.encode("utf-8")), run_id),
            )
        with pytest.raises(PersistenceError) as caught:
            repository.save_run(document, result, input_provenance=provenance)
        assert caught.value.code == ARTIFACT_CONFLICT
