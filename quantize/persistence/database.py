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

from quantize.persistence.errors import (
    CORRUPT_DATABASE,
    DATABASE_LOCKED,
    UNSUPPORTED_DATABASE_VERSION,
    IntegrityViolationError,
    PersistenceError,
)
from quantize.persistence.migrations import (
    CURRENT_DATABASE_VERSION,
    DATABASE_MIGRATIONS,
)


def _is_lock_error(error: sqlite3.OperationalError) -> bool:
    """SQLITE_BUSY / SQLITE_LOCKED by PRIMARY error code (extended codes masked to their
    primary — e.g. SQLITE_BUSY_SNAPSHOT=261 & 0xFF == 5); message check only as a fallback
    for hand-constructed errors that carry no code."""
    code = getattr(error, "sqlite_errorcode", None)
    if code is not None:
        return (code & 0xFF) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)
    return "database is locked" in str(error)


def _locked(error: sqlite3.OperationalError, phase: str) -> PersistenceError:
    return PersistenceError(
        DATABASE_LOCKED,
        f"the database is locked by another connection ({phase}): {error}",
        {"phase": phase},
    )


class Database:
    """One SQLite database, migrated to the current structure at open. Context manager."""

    def __init__(self, path: Path | str, *, busy_timeout_ms: int = 5000) -> None:
        self._path = str(path)
        self._connection = sqlite3.connect(self._path, isolation_level=None)
        self._connection.execute("PRAGMA foreign_keys = ON")
        # Lock-contention grace BEFORE migrations, so migration BEGIN/COMMIT honor it too.
        # Tests pass a tiny value; contention past the timeout surfaces as structured
        # ``database_locked`` (below), never a raw sqlite3 error.
        self._connection.execute(f"PRAGMA busy_timeout = {int(busy_timeout_ms)}")
        self._in_transaction = False
        try:
            # WAL journal mode (M12.9): under the rollback-journal default, a writer's COMMIT needs
            # an EXCLUSIVE lock and blocks (then times out to structured ``database_locked`` → 503)
            # while a reader holds a SHARED lock. Since M12 the validate endpoint READS component
            # definitions per call, so validating a componentized strategy during a long run's write
            # could 503 — a failure the validate contract never had. WAL lets readers proceed
            # against the last committed snapshot while a writer commits, closing it. This pragma
            # reads the file header, so it sits INSIDE the try: a corrupt/garbage file surfaces here
            # as the same structured ``corrupt_database`` the migration reads below would raise.
            # busy_timeout is unchanged.
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._apply_migrations()
        except sqlite3.DatabaseError as error:
            self._connection.close()
            if isinstance(error, sqlite3.OperationalError):
                # Open-time lock contention is structured like every other lock (query()/
                # transaction() map it below); OTHER operational faults (e.g. an unopenable
                # path) are environmental, not corruption — they propagate unchanged.
                if _is_lock_error(error):
                    raise _locked(error, "open") from error
                raise
            # A garbage or malformed file is an expected environment fault: structured,
            # per the errors-module contract — never a bare sqlite3 exception.
            raise PersistenceError(
                CORRUPT_DATABASE,
                f"file is not readable as a SQLite database: {error}",
                {"path": self._path},
            ) from error
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
        """Explicit BEGIN IMMEDIATE ... COMMIT, rolling back on any exception.

        The sqlite3 boundary discipline: lock contention (any phase — acquisition, body,
        commit) surfaces as structured ``database_locked``; constraint violations surface as
        ``IntegrityViolationError`` (post-rollback) so repositories never touch sqlite3; every
        failure path leaves the handle OUT of a transaction — never poisoned.
        """
        if self._in_transaction:
            raise RuntimeError("nested transactions are not supported")
        try:
            self._connection.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as error:
            # Acquisition failure: no transaction was started (writer-vs-writer contention).
            if _is_lock_error(error):
                raise _locked(error, "begin") from error
            raise
        self._in_transaction = True
        try:
            yield self._connection
        except BaseException as body_error:
            self._connection.execute("ROLLBACK")
            if isinstance(body_error, sqlite3.IntegrityError):
                raise IntegrityViolationError(
                    f"database constraint violated: {body_error}"
                ) from body_error
            if isinstance(body_error, sqlite3.OperationalError) and _is_lock_error(body_error):
                raise _locked(body_error, "statement") from body_error
            raise
        else:
            try:
                self._connection.execute("COMMIT")
            except BaseException as commit_error:
                # A rejected COMMIT (e.g. SQLITE_BUSY under a reader's shared lock) leaves
                # the driver mid-transaction; roll back so this instance stays usable and
                # the commit failure — the real fault — propagates (structured for locks).
                if self._connection.in_transaction:
                    self._connection.execute("ROLLBACK")
                if isinstance(commit_error, sqlite3.OperationalError) and _is_lock_error(
                    commit_error
                ):
                    raise _locked(commit_error, "commit") from commit_error
                raise
        finally:
            self._in_transaction = False

    def query(self, sql: str, parameters: tuple[object, ...] = ()) -> list[tuple[object, ...]]:
        """Read-only fetch, returned as plain tuples (no sqlite3.Row escapes this module)."""
        try:
            cursor = self._connection.execute(sql, parameters)
        except sqlite3.OperationalError as error:
            if _is_lock_error(error):
                raise _locked(error, "query") from error
            raise
        try:
            return [tuple(row) for row in cursor.fetchall()]
        except sqlite3.OperationalError as error:  # a mid-fetch BUSY is a lock like any other
            if _is_lock_error(error):
                raise _locked(error, "query") from error
            raise
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
