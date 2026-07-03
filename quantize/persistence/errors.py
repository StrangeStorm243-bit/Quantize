"""Stable structured persistence errors (M7).

Every failure surfaces as a ``PersistenceError`` with a stable machine-readable ``code`` —
never a bare sqlite3/json exception, never a partially-loaded object. Codes are contract:
tests pin the strings.
"""

from __future__ import annotations

from collections.abc import Mapping

ARTIFACT_NOT_FOUND = "artifact_not_found"
ARTIFACT_CONFLICT = "artifact_conflict"
INVALID_ARTIFACT = "invalid_artifact"
CORRUPT_ARTIFACT = "corrupt_artifact"
UNSUPPORTED_ARTIFACT_VERSION = "unsupported_artifact_version"
UNSUPPORTED_DATABASE_VERSION = "unsupported_database_version"
CORRUPT_DATABASE = "corrupt_database"
DATABASE_LOCKED = "database_locked"
INTEGRITY_VIOLATION = "integrity_violation"


class PersistenceError(Exception):
    """A structured, stable-coded persistence failure."""

    def __init__(self, code: str, message: str, context: Mapping[str, object] | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.context: dict[str, object] = dict(context or {})


class IntegrityViolationError(PersistenceError):
    """A database constraint violation, translated at the ``Database`` boundary.

    Repositories catch THIS (never ``sqlite3.IntegrityError`` — nothing sqlite-shaped leaks
    past ``database.py``) and map it to their domain conflict (``artifact_conflict``); the
    original constraint message is preserved in ``message``/``__cause__``.
    """

    def __init__(self, message: str, context: Mapping[str, object] | None = None):
        super().__init__(INTEGRITY_VIOLATION, message, context)
