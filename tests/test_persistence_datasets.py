"""M9.6: the content-addressed dataset store + its migration.

Identity is the full canonical payload (calendar AND observations): a price, an availability
instant, or a calendar change each flips ``dataset_id``. The split fingerprints let a caller see
WHICH changed — an observation change moves ``dataset_fingerprint`` (not ``calendar_fingerprint``);
a calendar change moves ``calendar_fingerprint`` (not ``dataset_fingerprint``). Uses the same
sensitivity oracle as ``test_run_provenance``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataSet, PriceObservation
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository
from quantize.persistence.errors import ARTIFACT_NOT_FOUND, CORRUPT_ARTIFACT, PersistenceError
from quantize.persistence.provenance import calendar_fingerprint, dataset_fingerprint

_DAY = date(2026, 1, 5)
_OPEN = datetime(2026, 1, 5, 14, 30, tzinfo=UTC)
_CLOSE = datetime(2026, 1, 5, 21, 0, tzinfo=UTC)


def _dataset(
    *,
    close_price: float = 10.5,
    close_available_at: datetime = _CLOSE,
    timezone: str = "UTC-05:00",
) -> MarketDataSet:
    calendar = ExchangeCalendar(
        exchange="QSE",
        timezone=timezone,
        sessions=(MarketSession(session_date=_DAY, open_at=_OPEN, close_at=_CLOSE),),
    )
    observations = {
        "AAA": [
            PriceObservation(
                session_date=_DAY,
                open_price=10.0,
                close_price=close_price,
                open_available_at=_OPEN,
                close_available_at=close_available_at,
            )
        ]
    }
    return MarketDataSet(calendar=calendar, observations=observations)


def _repo(tmp_path: Path) -> tuple[Database, DatasetRepository]:
    db = Database(tmp_path / "q.db")
    return db, DatasetRepository(db)


# --- migration --------------------------------------------------------------------------------


def test_migration_v2_creates_datasets_table_fresh(tmp_path: Path) -> None:
    with Database(tmp_path / "q.db") as db:
        tables = {r[0] for r in db.query("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "datasets" in tables


def test_migration_v2_upgrades_existing_v1_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A database created under v1 (no datasets table) gains it when reopened under current code."""
    from quantize.persistence import database as db_mod
    from quantize.persistence.migrations import DATABASE_MIGRATIONS

    monkeypatch.setattr(db_mod, "DATABASE_MIGRATIONS", (DATABASE_MIGRATIONS[0],))
    monkeypatch.setattr(db_mod, "CURRENT_DATABASE_VERSION", 1)
    path = tmp_path / "q.db"
    with Database(path) as db:
        tables = {r[0] for r in db.query("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "datasets" not in tables  # v1 has no dataset store yet

    monkeypatch.undo()  # restore the full (v2) migration set
    with Database(path) as db:  # reopen under current code → migration 2 applies
        tables = {r[0] for r in db.query("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "datasets" in tables
        versions = [
            r[0] for r in db.query("SELECT version FROM schema_migrations ORDER BY version")
        ]
        assert versions == [1, 2]


# --- store round-trip + idempotency -----------------------------------------------------------


def test_upload_returns_all_three_identities(tmp_path: Path) -> None:
    db, repo = _repo(tmp_path)
    with db:
        info, created = repo.save(_dataset())
        assert created is True
        assert len(info.dataset_id) == 64  # SHA-256 hex
        assert info.dataset_fingerprint == dataset_fingerprint(_dataset())
        assert info.calendar_fingerprint == calendar_fingerprint(_dataset().calendar)
        assert info.sessions == 1 and info.assets == 1


def test_identical_reupload_is_idempotent(tmp_path: Path) -> None:
    db, repo = _repo(tmp_path)
    with db:
        first, created_1 = repo.save(_dataset())
        second, created_2 = repo.save(_dataset())
        assert created_1 is True and created_2 is False
        assert first.dataset_id == second.dataset_id
        assert db.query("SELECT COUNT(*) FROM datasets")[0][0] == 1  # only one row


def test_payload_round_trip_reconstructs_matching_fingerprints(tmp_path: Path) -> None:
    db, repo = _repo(tmp_path)
    with db:
        info, _ = repo.save(_dataset())
        reloaded = repo.load(info.dataset_id)
        assert dataset_fingerprint(reloaded) == info.dataset_fingerprint
        assert calendar_fingerprint(reloaded.calendar) == info.calendar_fingerprint


def test_describe_returns_metadata_without_payload(tmp_path: Path) -> None:
    db, repo = _repo(tmp_path)
    with db:
        info, _ = repo.save(_dataset())
        described = repo.describe(info.dataset_id)
        assert described == info


# --- identity sensitivity battery -------------------------------------------------------------


def test_observation_change_flips_dataset_not_calendar(tmp_path: Path) -> None:
    db, repo = _repo(tmp_path)
    with db:
        base, _ = repo.save(_dataset())
        changed, _ = repo.save(_dataset(close_price=11.0))
        assert changed.dataset_id != base.dataset_id
        assert changed.dataset_fingerprint != base.dataset_fingerprint
        assert changed.calendar_fingerprint == base.calendar_fingerprint


def test_availability_change_flips_dataset_not_calendar(tmp_path: Path) -> None:
    db, repo = _repo(tmp_path)
    with db:
        base, _ = repo.save(_dataset())
        later = datetime(2026, 1, 5, 22, 0, tzinfo=UTC)  # still >= session close
        changed, _ = repo.save(_dataset(close_available_at=later))
        assert changed.dataset_id != base.dataset_id
        assert changed.dataset_fingerprint != base.dataset_fingerprint
        assert changed.calendar_fingerprint == base.calendar_fingerprint


def test_calendar_change_flips_calendar_not_dataset(tmp_path: Path) -> None:
    db, repo = _repo(tmp_path)
    with db:
        base, _ = repo.save(_dataset())
        changed, _ = repo.save(_dataset(timezone="UTC+00:00"))
        assert changed.dataset_id != base.dataset_id  # full-payload id catches calendar-only change
        assert changed.calendar_fingerprint != base.calendar_fingerprint
        assert changed.dataset_fingerprint == base.dataset_fingerprint


# --- error paths ------------------------------------------------------------------------------


def test_load_unknown_dataset_is_not_found(tmp_path: Path) -> None:
    db, repo = _repo(tmp_path)
    with db:
        with pytest.raises(PersistenceError) as caught:
            repo.load("0" * 64)
        assert caught.value.code == ARTIFACT_NOT_FOUND


def test_corrupt_row_is_corrupt_artifact(tmp_path: Path) -> None:
    db, repo = _repo(tmp_path)
    with db:
        info, _ = repo.save(_dataset())
        with db.transaction() as connection:
            connection.execute(
                "UPDATE datasets SET payload = ? WHERE dataset_id = ?",
                ("not a dataset object", info.dataset_id),
            )
        with pytest.raises(PersistenceError) as caught:
            repo.load(info.dataset_id)
        assert caught.value.code == CORRUPT_ARTIFACT
