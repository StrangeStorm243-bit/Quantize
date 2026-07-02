"""SQLite database wrapper (M7, ADR-0004): connection lifecycle, migrations, transactions.

Transaction discipline (reviewer-pinned): connections open with ``isolation_level=None`` so the
stdlib driver NEVER issues implicit BEGINs (and never auto-commits DDL mid-transaction — the
semantics differ across driver versions otherwise); ``Database.transaction()`` drives explicit
``BEGIN IMMEDIATE`` / ``COMMIT`` / ``ROLLBACK``. That makes each migration (DDL + bookkeeping
INSERT) and each multi-row save (run record + trace stream) genuinely one atomic unit on both
supported Python versions and both OSes. One connection per ``Database`` instance, shared by all
repositories (avoids same-process ``SQLITE_BUSY`` between sibling connections).

The wrapper is the ONLY module that touches ``sqlite3``. Repositories expose domain objects and
plain values; nothing sqlite-shaped leaks into contracts.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType

from quantize.persistence.errors import UNSUPPORTED_DATABASE_VERSION, PersistenceError
from quantize.persistence.migrations import (
    CURRENT_DATABASE_VERSION,
    DATABASE_MIGRATIONS,
)


class Database:
    """One SQLite database, migrated to the current structure at open. Context manager."""

    def __init__(self, path: Path | str) -> None:
        self._path = str(path)
        self._connection = sqlite3.connect(self._path, isolation_level=None)
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._in_transaction = False
        try:
            self._apply_migrations()
        except BaseException:
            # Never leak an open handle out of a failed construction (Windows file locks).
            self._connection.close()
            raise

    # --- lifecycle --------------------------------------------------------------------------

    def close(self) -> None:
        """Deterministic close (Windows file locks require this before delete/reopen)."""
        self._connection.close()

    def __enter__(self) -> Database:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    # --- transactions -----------------------------------------------------------------------

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Explicit BEGIN IMMEDIATE ... COMMIT, rolling back on any exception."""
        if self._in_transaction:
            raise RuntimeError("nested transactions are not supported")
        self._connection.execute("BEGIN IMMEDIATE")
        self._in_transaction = True
        try:
            yield self._connection
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        finally:
            self._in_transaction = False

    def query(self, sql: str, parameters: tuple[object, ...] = ()) -> list[tuple[object, ...]]:
        """Read-only fetch, returned as plain tuples (no sqlite3.Row escapes this module)."""
        cursor = self._connection.execute(sql, parameters)
        try:
            return [tuple(row) for row in cursor.fetchall()]
        finally:
            cursor.close()

    # --- migrations -------------------------------------------------------------------------

    def _current_version(self) -> int:
        # Bootstrap rule: an absent schema_migrations table means version 0.
        present = self.query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
        )
        if not present:
            return 0
        rows = self.query("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
        version = rows[0][0]
        assert isinstance(version, int)
        return version

    def _apply_migrations(self) -> None:
        version = self._current_version()
        if version > CURRENT_DATABASE_VERSION:
            raise PersistenceError(
                UNSUPPORTED_DATABASE_VERSION,
                f"database is at version {version}, newer than supported "
                f"{CURRENT_DATABASE_VERSION}",
                {"database": version, "supported": CURRENT_DATABASE_VERSION},
            )
        for migration in DATABASE_MIGRATIONS:
            if migration.version <= version:
                continue
            # DDL + bookkeeping INSERT in ONE transaction: a crash leaves the previous version.
            with self.transaction() as connection:
                if migration.version == 1:
                    connection.execute(
                        """
                        CREATE TABLE schema_migrations (
                            version INTEGER NOT NULL PRIMARY KEY,
                            applied_at TEXT NOT NULL
                        )
                        """
                    )
                for statement in migration.statements:
                    connection.execute(statement)
                connection.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (migration.version, datetime.now(UTC).isoformat()),
                )
