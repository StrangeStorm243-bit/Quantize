"""M7.3: database migration runner + artifact-format migration seams."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from quantize.persistence.database import Database
from quantize.persistence.errors import (
    UNSUPPORTED_ARTIFACT_VERSION,
    UNSUPPORTED_DATABASE_VERSION,
    PersistenceError,
)
from quantize.persistence.migrations import (
    ARTIFACT_MIGRATIONS,
    CURRENT_DATABASE_VERSION,
    ArtifactMigration,
    ArtifactMigrationRegistry,
)

_EXPECTED_TABLES = {"components", "runs", "schema_migrations", "strategies", "trace_events"}


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


def test_production_registry_is_empty_at_format_one() -> None:
    # v0 ships format 1 for every kind; the seam is proven by the synthetic chain (above) and
    # by the format-0 load-path test in test_persistence_runs.py.
    assert ARTIFACT_MIGRATIONS.steps() == ()
