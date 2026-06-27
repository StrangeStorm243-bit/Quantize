"""Supported IR ``schema_version`` — the single source of truth for compatibility.

M1 understands exactly one schema version (``0.1.0``). This module centralizes that fact so no
string literal is duplicated across models, validation, and tests.

**Three boundaries, one source of truth (``SUPPORTED_SCHEMA_VERSIONS``).**

* The **Python representation** (``SchemaVersion`` below) recognizes SemVer *syntax* only, so a
  well-formed-but-unsupported version still parses.
* **M1.2 structural validation** owns the supported-version *diagnostic*: it inspects the parsed
  ``schema_version`` and emits ``unsupported_schema_version`` for anything outside the set.
* The **exported JSON Schema** (M1.3) independently restricts both persisted roots'
  ``schema_version`` to the supported set via an ``enum``, so language-neutral consumers reject
  unsupported documents up front — without that rejection moving to Python parse time (which would
  suppress the M1.2 diagnostic).

Future migrations / multi-version loading remain **deferred** (no migration infrastructure here).

**Layering note.** A future *raw-document loading / migration* layer may read a document's
``schema_version`` **before** choosing which schema/parser to apply (so it can reject or migrate
an unsupported version up front). That loader is **not** part of M1.2. M1.2 validates
``schema_version`` on a document **already parsed** with the current M1 Pydantic contract — i.e. it
confirms the parsed document targets a version this build supports, and fails loud otherwise. No
migration is performed.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import StringConstraints, WithJsonSchema

from quantize.schema.primitives import SEMVER_PATTERN

# The schema version this build authors and validates against (see docs/STRATEGY_LANGUAGE.md).
CURRENT_SCHEMA_VERSION = "0.1.0"

# The full set of schema versions accepted by structural validation. M1 supports exactly one; the
# set form keeps the contract honest if a future build accepts a small explicit range.
SUPPORTED_SCHEMA_VERSIONS: frozenset[str] = frozenset({CURRENT_SCHEMA_VERSION})


def is_supported_schema_version(version: str) -> bool:
    """Return whether *version* is a ``schema_version`` this build structurally supports."""
    return version in SUPPORTED_SCHEMA_VERSIONS


def supported_schema_versions() -> list[str]:
    """The supported versions in deterministic (sorted) order — the single emission source.

    ``SUPPORTED_SCHEMA_VERSIONS`` is a ``frozenset`` (unordered); sorting makes any artifact derived
    from it byte-stable across runs.
    """
    return sorted(SUPPORTED_SCHEMA_VERSIONS)


# The persisted-document ``schema_version`` field type — the one place the supported-version policy
# meets the field. **Runtime parsing stays broad**: it validates only SemVer *syntax*, so a
# well-formed-but-unsupported version (e.g. ``"0.2.0"``) still parses and M1.2 can emit its
# structured ``unsupported_schema_version`` diagnostic on the parsed document. The **exported JSON
# Schema**, by contrast, restricts the field to the centralized supported set via an ``enum`` (with
# the SemVer pattern retained) — so language-neutral consumers reject unsupported versions up front.
# Narrowing the *runtime* type to a ``Literal`` would move that rejection to parse time and suppress
# the M1.2 diagnostic; ``WithJsonSchema`` keeps the two boundaries distinct.
SchemaVersion = Annotated[
    str,
    StringConstraints(pattern=SEMVER_PATTERN),
    WithJsonSchema(
        {"type": "string", "pattern": SEMVER_PATTERN, "enum": supported_schema_versions()},
    ),
]
