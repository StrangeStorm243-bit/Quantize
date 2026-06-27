"""Primitive value types for the Quantize IR (M1.1a).

These are the atomic building blocks the IR models compose: portable JSON values, identifier and
version strings, and timezone-aware datetimes. No document-level model lives here.

Conceptually, ``JsonValue`` is the recursive portable-JSON type
(``None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]``); the
``_check_portable_json`` validator enforces its finiteness and JS-safe-integer rules. Fields that
hold generic JSON (``params``/``ui``/``extensions``) use :data:`JsonObject`.
"""

from __future__ import annotations

import math
import re
from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import AfterValidator, AwareDatetime, StringConstraints

# --- Portable JSON ---------------------------------------------------------------------------

# JavaScript's Number.MAX_SAFE_INTEGER boundary. Integers outside this range cannot be represented
# losslessly by the TypeScript editor, so they must be carried as strings (HIGH-5).
JS_MAX_SAFE_INT = 2**53 - 1


def _check_portable_json(value: Any) -> Any:
    """Recursively assert *value* is portable JSON; return it unchanged or raise ``ValueError``.

    Portable JSON = ``null``, ``bool``, a JS-safe ``int``, a finite ``float``, ``str``, a list of
    portable JSON, or an object with string keys and portable-JSON values. NaN/Infinity and
    out-of-JS-safe-range integers are rejected.
    """
    # bool is a subclass of int in Python; handle it (and str/None) before the int branch.
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if not -JS_MAX_SAFE_INT <= value <= JS_MAX_SAFE_INT:
            raise ValueError(
                f"integer {value} is outside the JS-safe range [-(2^53-1), 2^53-1]; "
                "carry large magnitudes as strings"
            )
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("NaN and Infinity are not portable JSON")
        return value
    if isinstance(value, list):
        return [_check_portable_json(item) for item in value]
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("JSON object keys must be strings")
            _check_portable_json(item)
        return value
    raise ValueError(f"{type(value).__name__} is not a portable JSON value")


def _check_portable_json_object(value: dict[str, Any]) -> dict[str, Any]:
    _check_portable_json(value)  # raises if any contained value is not portable JSON
    return value


# A JSON object (used by params/ui/extensions) whose contents are validated portable JSON.
JsonObject = Annotated[dict[str, Any], AfterValidator(_check_portable_json_object)]

# --- Identifiers -----------------------------------------------------------------------------

# Node ids, ref ids, and port names are short, non-empty identifier strings.
_IDENT = r"^[A-Za-z0-9_]+$"
NodeId = Annotated[str, StringConstraints(min_length=1, pattern=_IDENT)]
RefId = Annotated[str, StringConstraints(min_length=1, pattern=_IDENT)]
PortName = Annotated[str, StringConstraints(min_length=1, pattern=_IDENT)]

# --- type_id (open, namespaced) --------------------------------------------------------------

RESERVED_COMPONENT_TYPE_ID = "component"
_TYPE_ID = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")


def _check_type_id(value: str) -> str:
    if value == RESERVED_COMPONENT_TYPE_ID:
        return value
    if _TYPE_ID.match(value):
        return value
    raise ValueError(
        f"type_id {value!r} must be namespaced (e.g. 'transform.rank') or the "
        f"reserved '{RESERVED_COMPONENT_TYPE_ID}'"
    )


# An open, namespaced node-type identifier (NOT an enum): a dotted name, or reserved 'component'.
TypeId = Annotated[str, AfterValidator(_check_type_id)]

# --- Versions --------------------------------------------------------------------------------

# A MAJOR.MINOR.PATCH version string (node `type_version`, `schema_version`, component version).
SemVer = Annotated[str, StringConstraints(pattern=r"^\d+\.\d+\.\d+$")]

# --- Datetimes -------------------------------------------------------------------------------


def _to_utc(value: datetime) -> datetime:
    """Normalize a timezone-aware datetime to UTC (naive datetimes are rejected upstream)."""
    return value.astimezone(UTC)


# A timezone-aware datetime, normalized to UTC and serialized as RFC 3339. Naive values rejected.
Utc = Annotated[AwareDatetime, AfterValidator(_to_utc)]
