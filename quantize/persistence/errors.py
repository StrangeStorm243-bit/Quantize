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


class PersistenceError(Exception):
    """A structured, stable-coded persistence failure."""

    def __init__(self, code: str, message: str, context: Mapping[str, object] | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.context: dict[str, object] = dict(context or {})
