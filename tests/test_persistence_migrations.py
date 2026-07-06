"""M7.3: database migration runner + artifact-format migration seams."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from quantize.persistence.database import Database
from quantize.persistence.errors import (
    CORRUPT_DATABASE,
    DATABASE_LOCKED,
    INTEGRITY_VIOLATION,
    UNSUPPORTED_ARTIFACT_VERSION,
    UNSUPPORTED_DATABASE_VERSION,
    IntegrityViolationError,
    PersistenceError,
)
from quantize.persistence.migrations import (
    ARTIFACT_MIGRATIONS,
    CURRENT_DATABASE_VERSION,
    ArtifactMigration,
    ArtifactMigrationRegistry,
)

_EXPECTED_TABLES = {
    "components",
    "datasets",  # M9.6 migration v2
    "runs",
    "schema_migrations",
    "strategies",
    "trace_events",
}


def test_fresh_database_reaches_current_version(tmp_path: Path) -> None:
    with Database(tmp_path / "q.db") as db:
        tables = {
            str(row[0]) for row in db.query("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        assert tables == _EXPECTED_TABLES
        versions = db.query("SELECT version FROM schema_migrations ORDER BY version")
        assert [row[0] for row in versions] == list(range(1, CURRENT_DATABASE_VERSION + 1))


def test_reopening_is_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "q.db"
    with Database(path):
        pass
    with Database(path) as db:  # second open applies nothing and changes nothing
        rows = db.query("SELECT COUNT(*) FROM schema_migrations")
        assert rows[0][0] == CURRENT_DATABASE_VERSION


def test_database_ahead_of_code_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "q.db"
    with Database(path) as db, db.transaction() as connection:
        connection.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (99, 'x')")
    with pytest.raises(PersistenceError) as caught:
        Database(path)
    assert caught.value.code == UNSUPPORTED_DATABASE_VERSION
    assert caught.value.context["database"] == 99


def test_corrupt_database_file_fails_structured(tmp_path: Path) -> None:
    """A garbage or truncated database file surfaces as a structured PersistenceError
    (stable code), never a bare sqlite3.DatabaseError (the errors-module contract)."""
    for name, content in (
        ("garbage.db", b"this is not a sqlite database, just bytes\n" * 4),
        ("truncated.db", b"SQLite format 3\x00" + b"\x00" * 8),  # valid magic, malformed body
    ):
        path = tmp_path / name
        path.write_bytes(content)
        with pytest.raises(PersistenceError) as caught:
            Database(path)
        assert caught.value.code == CORRUPT_DATABASE
        assert caught.value.context["path"] == str(path)


_INSERT_STRATEGY = (
    "INSERT INTO strategies (strategy_id, version, schema_version, name,"
    " content_hash, document, saved_at) VALUES ('x', 1, 'v', 'n', 'h', '{}', 't')"
)


def test_writer_commit_is_not_blocked_by_a_concurrent_reader(tmp_path: Path) -> None:
    """WAL rewrite (M12.9): BEFORE WAL a reader holding a shared lock forced the writer's COMMIT
    to fail as structured ``database_locked`` (this test previously asserted that surface). That
    was the 503 pathology at the validate endpoint. Under WAL the reader reads its own committed
    snapshot and the writer commits WITHOUT blocking — assert the commit now succeeds, the row is
    durable, and the handle stays usable. (The commit-failure recovery in ``transaction()`` remains;
    writer-vs-writer contention below still exercises the structured-lock path.)"""
    import sqlite3

    path = tmp_path / "q.db"
    with Database(path, busy_timeout_ms=20) as db:
        reader = sqlite3.connect(str(path))
        try:
            reader.execute("BEGIN")
            reader.execute("SELECT COUNT(*) FROM schema_migrations").fetchall()
            with db.transaction() as connection:  # no longer raises under WAL
                connection.execute(_INSERT_STRATEGY)
            # The writer's commit succeeded despite the reader's open transaction.
            assert db.query("SELECT COUNT(*) FROM strategies")[0][0] == 1
        finally:
            reader.close()
        # The instance remains usable for a subsequent transaction.
        with db.transaction() as connection:
            connection.execute("DELETE FROM strategies")
        assert db.query("SELECT COUNT(*) FROM strategies")[0][0] == 0


def test_connection_uses_wal_journal_mode(tmp_path: Path) -> None:
    """WAL is enabled at open (M12.9): the finding is that the rollback-journal default lets a
    writer's commit block a concurrent reader's SHARED lock, surfacing as ``database_locked`` (a
    503) at the validate endpoint. WAL readers never block on writers — assert the mode directly."""
    with Database(tmp_path / "q.db") as db:
        mode = db.query("PRAGMA journal_mode")[0][0]
        assert str(mode).lower() == "wal"


def test_reader_proceeds_during_an_open_write_transaction(tmp_path: Path) -> None:
    """Under WAL a second connection reads the last committed snapshot while a writer holds an
    open write transaction — no ``database_locked``. (Under the old rollback default this same
    read races the writer's commit and can surface as a 503 at validate.) No threads: the write
    transaction is held open across the concurrent read."""
    path = tmp_path / "q.db"
    with Database(path, busy_timeout_ms=20) as writer, Database(path, busy_timeout_ms=20) as reader:
        with writer.transaction() as connection:
            connection.execute(_INSERT_STRATEGY)  # uncommitted write held open
            # The reader sees the last committed snapshot (0 rows) without blocking or locking.
            assert reader.query("SELECT COUNT(*) FROM strategies")[0][0] == 0
        # After commit the reader observes the new row on its next read.
        assert reader.query("SELECT COUNT(*) FROM strategies")[0][0] == 1


def test_writer_contention_on_begin_is_structured(tmp_path: Path) -> None:
    """Writer-vs-writer: a second handle's BEGIN IMMEDIATE against a held RESERVED lock is
    the acquisition path (outside the commit recovery) — it too must surface as structured
    ``database_locked`` and must not poison either handle."""
    path = tmp_path / "q.db"
    with Database(path, busy_timeout_ms=20) as writer, Database(path, busy_timeout_ms=20) as db:
        with writer.transaction() as connection:
            connection.execute(_INSERT_STRATEGY)
            with pytest.raises(PersistenceError) as caught:
                with db.transaction():
                    pass  # pragma: no cover — BEGIN itself must fail
            assert caught.value.code == DATABASE_LOCKED
        # Both handles remain usable after the contention window closes.
        assert db.query("SELECT COUNT(*) FROM strategies")[0][0] == 1
        with db.transaction() as connection:
            connection.execute("DELETE FROM strategies")
        assert writer.query("SELECT COUNT(*) FROM strategies")[0][0] == 0


def test_lock_wait_honors_the_configured_busy_timeout(tmp_path: Path) -> None:
    """The busy handler waits roughly the configured timeout before giving up — identity of
    the error is asserted exactly; the duration only via a generous upper bound."""
    import time

    path = tmp_path / "q.db"
    with Database(path, busy_timeout_ms=50) as writer, Database(path, busy_timeout_ms=50) as db:
        with writer.transaction() as connection:
            connection.execute(_INSERT_STRATEGY)
            started = time.perf_counter()
            with pytest.raises(PersistenceError) as caught:
                with db.transaction():
                    pass  # pragma: no cover
            elapsed = time.perf_counter() - started
            assert caught.value.code == DATABASE_LOCKED
            assert elapsed < 5.0  # waited ~50ms, not the 5s default, not forever


def test_integrity_violation_is_translated_not_leaked(tmp_path: Path) -> None:
    """A constraint violation inside a transaction surfaces as the persistence-owned
    ``IntegrityViolationError`` (post-rollback), so repositories never import sqlite3."""
    path = tmp_path / "q.db"
    with Database(path) as db:
        with db.transaction() as connection:
            connection.execute(_INSERT_STRATEGY)
        with pytest.raises(IntegrityViolationError) as caught:
            with db.transaction() as connection:
                connection.execute(_INSERT_STRATEGY)  # duplicate primary key
        assert caught.value.code == INTEGRITY_VIOLATION
        assert isinstance(caught.value, PersistenceError)
        # Rolled back cleanly; the handle stays usable.
        assert db.query("SELECT COUNT(*) FROM strategies")[0][0] == 1


def test_repositories_do_not_import_sqlite3() -> None:
    """database.py is the ONLY quantize module that IMPORTS sqlite3 (its declared boundary);
    prose mentions in docstrings/comments are fine — the coupling is the import."""
    import re
    from pathlib import Path as _Path

    package = _Path("quantize")
    imports_sqlite = re.compile(r"^\s*(import sqlite3|from sqlite3\b)", re.MULTILINE)
    offenders = [
        str(path)
        for path in package.rglob("*.py")
        if imports_sqlite.search(path.read_text(encoding="utf-8")) and path.name != "database.py"
    ]
    assert offenders == []


def test_nested_transactions_are_rejected(tmp_path: Path) -> None:
    with Database(tmp_path / "q.db") as db, db.transaction():
        with pytest.raises(RuntimeError, match="nested"):
            with db.transaction():
                pass  # pragma: no cover


def test_transaction_rolls_back_on_error(tmp_path: Path) -> None:
    with Database(tmp_path / "q.db") as db:
        with pytest.raises(ValueError, match="boom"), db.transaction() as connection:
            connection.execute(
                "INSERT INTO strategies (strategy_id, version, schema_version, name,"
                " content_hash, document, saved_at) VALUES ('x', 1, 'v', 'n', 'h', '{}', 't')"
            )
            raise ValueError("boom")
        assert db.query("SELECT COUNT(*) FROM strategies")[0][0] == 0


# --- artifact-format migration seams --------------------------------------------------------------


def _registry_with_chain() -> ArtifactMigrationRegistry:
    registry = ArtifactMigrationRegistry()
    registry.register(
        ArtifactMigration(
            kind="test_kind",
            from_version=1,
            migrate=lambda payload: {**payload, "added_in_2": True},
            example_input={"v_field": 1, "kept": "yes"},
        )
    )
    registry.register(
        ArtifactMigration(
            kind="test_kind",
            from_version=2,
            migrate=lambda payload: {key: value for key, value in payload.items() if key != "kept"},
            dropped_keys=frozenset({"kept"}),
            example_input={"v_field": 1, "kept": "yes", "added_in_2": True},
        )
    )
    return registry


def test_migration_chain_applies_in_order_and_deterministically() -> None:
    registry = _registry_with_chain()
    start: dict[str, Any] = {"v_field": 1, "kept": "yes"}
    first = registry.migrate_to_current("test_kind", dict(start), 1, 3)
    second = registry.migrate_to_current("test_kind", dict(start), 1, 3)
    assert first == {"v_field": 1, "added_in_2": True}
    assert first == second  # deterministic pure functions
    assert start == {"v_field": 1, "kept": "yes"}  # input not mutated


def test_current_version_passes_through_untouched() -> None:
    registry = _registry_with_chain()
    payload = {"anything": 1}
    assert registry.migrate_to_current("test_kind", payload, 3, 3) is payload


def test_newer_than_supported_fails_structured() -> None:
    registry = _registry_with_chain()
    with pytest.raises(PersistenceError) as caught:
        registry.migrate_to_current("test_kind", {}, 4, 3)
    assert caught.value.code == UNSUPPORTED_ARTIFACT_VERSION


def test_gap_in_chain_fails_structured() -> None:
    registry = ArtifactMigrationRegistry()
    registry.register(
        ArtifactMigration(kind="gappy", from_version=1, migrate=lambda p: p)
    )  # no 2->3 step
    with pytest.raises(PersistenceError) as caught:
        registry.migrate_to_current("gappy", {}, 1, 3)
    assert caught.value.code == UNSUPPORTED_ARTIFACT_VERSION
    assert caught.value.context["missing_step"] == 2


def test_duplicate_registration_fails_loud() -> None:
    registry = ArtifactMigrationRegistry()
    step = ArtifactMigration(kind="dup", from_version=1, migrate=lambda p: p)
    registry.register(step)
    with pytest.raises(ValueError, match="duplicate"):
        registry.register(step)


def test_no_migration_is_silently_lossy() -> None:
    """The never-silently-lossy MECHANISM: for every registered migration (production registry
    plus the synthetic chain), migrating its example input may only remove keys the migration
    explicitly declared as dropped."""
    for registry in (ARTIFACT_MIGRATIONS, _registry_with_chain()):
        for step in registry.steps():
            output = step.migrate(dict(step.example_input))
            vanished = set(step.example_input) - set(output)
            assert vanished <= step.dropped_keys, (
                f"{step.kind} v{step.from_version} silently dropped {vanished - step.dropped_keys}"
            )


def test_production_registry_holds_exactly_the_run_record_upgrade() -> None:
    # Pre-M9 E: run records moved to format 2 (input provenance); the ONLY production
    # migration is that single 1->2 step. Trace events remain format 1.
    steps = ARTIFACT_MIGRATIONS.steps()
    assert [(step.kind, step.from_version) for step in steps] == [("run_record", 1)]
    migrated = steps[0].migrate({"record_format": 1, "ok": True})
    assert migrated["record_format"] == 2
    assert migrated["input_provenance"] == {
        "status": "unknown",
        "dataset_hash": None,
        "calendar_hash": None,
    }
