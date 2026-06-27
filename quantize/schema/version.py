"""Supported IR ``schema_version`` — the single source of truth for compatibility.

M1 understands exactly one schema version (``0.1.0``). This module centralizes that fact so no
string literal is duplicated across models, validation, and tests.

**Layering note.** A future *raw-document loading / migration* layer may read a document's
``schema_version`` **before** choosing which schema/parser to apply (so it can reject or migrate
an unsupported version up front). That loader is **not** part of M1.2. M1.2 validates
``schema_version`` on a document **already parsed** with the current M1 Pydantic contract — i.e. it
confirms the parsed document targets a version this build supports, and fails loud otherwise. No
migration is performed.
"""

from __future__ import annotations

# The schema version this build authors and validates against (see docs/STRATEGY_LANGUAGE.md).
CURRENT_SCHEMA_VERSION = "0.1.0"

# The full set of schema versions accepted by structural validation. M1 supports exactly one; the
# set form keeps the contract honest if a future build accepts a small explicit range.
SUPPORTED_SCHEMA_VERSIONS: frozenset[str] = frozenset({CURRENT_SCHEMA_VERSION})


def is_supported_schema_version(version: str) -> bool:
    """Return whether *version* is a ``schema_version`` this build structurally supports."""
    return version in SUPPORTED_SCHEMA_VERSIONS
