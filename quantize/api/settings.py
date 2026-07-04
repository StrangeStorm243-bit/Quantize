"""API settings and their FastAPI dependency.

``ApiSettings`` is a frozen dataclass (config, not a DTO — never crosses the wire). ``get_settings``
is the yield-free dependency handlers depend on; tests override it with a ``tmp_path``-backed
instance. The resolved settings are also stored on ``app.state`` so the body-size middleware and
the startup warm-up read the SAME values (see ``app.create_app``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DB_PATH_ENV = "QUANTIZE_DB_PATH"
DEFAULT_DB_PATH = "quantize.db"
# Shorter than the persistence library's 5000 ms default: an API caller gets a retryable 503
# quickly rather than blocking a worker thread on a contended write.
DEFAULT_BUSY_TIMEOUT_MS = 1000
# Applies to every POST body (including dataset upload); over it → 413. 10 MiB comfortably holds
# the synthetic fixtures while bounding depth-bomb / oversized payloads.
DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class ApiSettings:
    """Immutable per-app configuration. No mutable request-global state (invariant i)."""

    db_path: str = DEFAULT_DB_PATH
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES

    @classmethod
    def from_env(cls) -> ApiSettings:
        """Read the deployment-configurable values from the environment (db path only in v0)."""
        return cls(db_path=os.environ.get(DB_PATH_ENV, DEFAULT_DB_PATH))


def get_settings() -> ApiSettings:
    """FastAPI dependency: the active settings. Overridden in tests via ``dependency_overrides``."""
    return ApiSettings.from_env()
