"""Migration seams (M7): database structure + artifact formats. Forward-only, explicit, tested.

**Database migrations** are ordered ``DatabaseMigration`` rows applied at open, each DDL batch
plus its ``schema_migrations`` bookkeeping INSERT in ONE transaction (a crash mid-migration
leaves the previous version intact, never a half-applied one). Bootstrap rule: an absent
``schema_migrations`` table means version 0. A database AHEAD of the code fails loudly
(``unsupported_database_version``) — never best-effort.

**Artifact-format migrations** run at LOAD time, forward-only, chained to the current format;
stored bytes are never rewritten silently. Each migration is a deterministic pure function over
the decoded JSON dict and must DECLARE any keys it drops — a generic registry test enforces
``output_keys ⊇ input_keys − dropped_keys`` so a migration can never be silently lossy.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from quantize.persistence.errors import UNSUPPORTED_ARTIFACT_VERSION, PersistenceError

# --- database structure -------------------------------------------------------------------------


@dataclass(frozen=True)
class DatabaseMigration:
    version: int
    purpose: str
    statements: tuple[str, ...]


# Postgres-ready discipline (ADR-0004): TEXT UUIDs, TEXT ISO-UTC timestamps, INTEGER/TEXT
# versions, TEXT canonical-JSON payloads; no SQLite-only types or features.
DATABASE_MIGRATIONS: tuple[DatabaseMigration, ...] = (
    DatabaseMigration(
        version=1,
        purpose="initial persistence schema: strategies, components, runs, trace events",
        statements=(
            """
            CREATE TABLE strategies (
                strategy_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                schema_version TEXT NOT NULL,
                name TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                document TEXT NOT NULL,
                saved_at TEXT NOT NULL,
                PRIMARY KEY (strategy_id, version)
            )
            """,
            """
            CREATE TABLE components (
                component_id TEXT NOT NULL,
                version TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                name TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                document TEXT NOT NULL,
                saved_at TEXT NOT NULL,
                PRIMARY KEY (component_id, version)
            )
            """,
            """
            CREATE TABLE runs (
                run_id TEXT NOT NULL PRIMARY KEY,
                strategy_id TEXT NOT NULL,
                strategy_version INTEGER NOT NULL,
                mode TEXT NOT NULL,
                record_format INTEGER NOT NULL,
                ok INTEGER NOT NULL,
                first_session TEXT,
                last_session TEXT,
                total_return REAL NOT NULL,
                content_hash TEXT NOT NULL,
                trace_content_hash TEXT NOT NULL,
                trace_count INTEGER NOT NULL,
                record TEXT NOT NULL,
                saved_at TEXT NOT NULL,
                FOREIGN KEY (strategy_id, strategy_version)
                    REFERENCES strategies (strategy_id, version)
            )
            """,
            """
            CREATE TABLE trace_events (
                run_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                trace_format INTEGER NOT NULL,
                timestamp TEXT NOT NULL,
                event TEXT NOT NULL,
                PRIMARY KEY (run_id, seq),
                FOREIGN KEY (run_id) REFERENCES runs (run_id)
            )
            """,
        ),
    ),
    DatabaseMigration(
        version=2,
        purpose="dataset store: content-addressed uploaded market data (M9)",
        statements=(
            """
            CREATE TABLE datasets (
                dataset_id TEXT NOT NULL PRIMARY KEY,
                dataset_fingerprint TEXT NOT NULL,
                calendar_fingerprint TEXT NOT NULL,
                payload TEXT NOT NULL,
                saved_at TEXT NOT NULL
            )
            """,
        ),
    ),
)

CURRENT_DATABASE_VERSION = DATABASE_MIGRATIONS[-1].version


# --- artifact formats ---------------------------------------------------------------------------

MigrationFn = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class ArtifactMigration:
    """One forward step for one artifact kind: ``from_version`` -> ``from_version + 1``.

    ``dropped_keys`` DECLARES every top-level key the step is allowed to remove; the generic
    registry test fails on any undeclared disappearance (the never-silently-lossy mechanism).
    ``example_input`` is a representative old-format payload the registry test migrates.
    """

    kind: str
    from_version: int
    migrate: MigrationFn
    dropped_keys: frozenset[str] = frozenset()
    example_input: Mapping[str, Any] = field(default_factory=dict)


class ArtifactMigrationRegistry:
    """Forward-only read-time migration chains, keyed by (kind, from_version)."""

    def __init__(self) -> None:
        self._steps: dict[tuple[str, int], ArtifactMigration] = {}

    def register(self, migration: ArtifactMigration) -> None:
        key = (migration.kind, migration.from_version)
        if key in self._steps:
            raise ValueError(f"duplicate migration registered for {key!r}")
        self._steps[key] = migration

    def steps(self) -> tuple[ArtifactMigration, ...]:
        return tuple(self._steps.values())

    def migrate_to_current(
        self, kind: str, payload: dict[str, Any], stored_version: int, current_version: int
    ) -> dict[str, Any]:
        """Chain *payload* from *stored_version* to *current_version* (forward only).

        Unknown future versions and gaps in the chain fail with structured errors; downgrading
        is out of scope and rejected.
        """
        if stored_version == current_version:
            return payload
        if stored_version > current_version:
            raise PersistenceError(
                UNSUPPORTED_ARTIFACT_VERSION,
                f"{kind} format {stored_version} is newer than supported {current_version}",
                {"kind": kind, "stored": stored_version, "supported": current_version},
            )
        version = stored_version
        migrated = payload
        while version < current_version:
            step = self._steps.get((kind, version))
            if step is None:
                raise PersistenceError(
                    UNSUPPORTED_ARTIFACT_VERSION,
                    f"no migration registered for {kind} format {version}",
                    {"kind": kind, "stored": stored_version, "missing_step": version},
                )
            migrated = step.migrate(dict(migrated))
            version += 1
        return migrated


ARTIFACT_MIGRATIONS = ArtifactMigrationRegistry()


def _run_record_1_to_2(payload: dict[str, Any]) -> dict[str, Any]:
    """Format 1 -> 2: add EXPLICIT unknown input provenance (pre-M9 E).

    Format-1 rows predate input fingerprinting; the dataset/calendar hashes were never
    recorded and cannot be honestly invented, so the migrated record SAYS so — replay against
    them is attemptable, never verifiable.

    NOT value-preserving for a hypothetical format-1 payload that already carries an
    ``input_provenance`` key (it would be overwritten with unknown) — unreachable in this
    lineage, and the registry's never-silently-lossy guard is KEY-level, so it would not flag
    that overwrite. Recorded here so a future fork lineage does not assume otherwise.
    """
    return {
        **payload,
        "record_format": 2,
        "input_provenance": {"status": "unknown", "dataset_hash": None, "calendar_hash": None},
    }


ARTIFACT_MIGRATIONS.register(
    ArtifactMigration(
        kind="run_record",
        from_version=1,
        migrate=_run_record_1_to_2,
        example_input={
            "record_format": 1,
            "run_id": "00000000-0000-0000-0000-000000000000",
            "mode": "backtest",
            "ok": True,
        },
    )
)
