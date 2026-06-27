"""Primitive value types for the Quantize IR.

Atomic building blocks the IR models compose: portable JSON values, identifiers, version strings,
strict numerics, and timezone-aware datetimes. Constraints are made schema-visible where the IR
contract requires them (patterns, bounds, recursion), so the published JSON Schema rejects what
Pydantic rejects.
"""

from __future__ import annotations

import math
import re
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import AfterValidator, AwareDatetime, BeforeValidator, Field, StringConstraints

# --- Portable JSON ---------------------------------------------------------------------------

# JavaScript's Number.MAX_SAFE_INTEGER boundary. Integers outside this range cannot be represented
# losslessly by the TypeScript editor, so they are NOT valid generic JSON integers (HIGH-5); larger
# exact integers require a future explicit string/decimal/big-integer contract.
JS_MAX_SAFE_INT = 2**53 - 1

# A JSON integer bounded to the JS-safe range (strict so an out-of-range int is NOT coerced to a
# float through the union). Bounds are schema-visible.
_BoundedInt = Annotated[int, Field(ge=-JS_MAX_SAFE_INT, le=JS_MAX_SAFE_INT, strict=True)]
# Strict float so a Python int is not silently widened to float (keeps int/float distinct in JSON).
_StrictFloat = Annotated[float, Field(strict=True)]

# The recursive portable-JSON value type. Recursive + bounded so the emitted JSON Schema describes
# the real shape (not `Any`). NaN/Infinity are not valid JSON numbers and are additionally rejected
# at parse (the validator below) and at the canonical serialization boundary.
type JsonValue = (
    None | bool | _BoundedInt | _StrictFloat | str | list[JsonValue] | dict[str, JsonValue]
)


def _check_portable_json(value: Any) -> Any:
    """Recursively assert *value* is portable JSON; return it unchanged or raise ``ValueError``."""
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


def _check_portable_json_object(value: Any) -> Any:
    # Runs on RAW input (pre-coercion) so an out-of-range int is rejected, not widened to a float.
    _check_portable_json(value)
    return value


# A JSON object (used by params/ui/extensions) — recursive portable-JSON values. The recursive type
# gives the schema its shape; the BeforeValidator enforces JS-safe ints and rejects NaN/Infinity on
# the raw input.
JsonObject = Annotated[dict[str, JsonValue], BeforeValidator(_check_portable_json_object)]

# --- Identifiers -----------------------------------------------------------------------------

# Node/ref ids and port names are short, non-empty identifier strings (schema-visible pattern).
_IDENT = r"^[A-Za-z0-9_]+$"
NodeId = Annotated[str, StringConstraints(min_length=1, pattern=_IDENT)]
RefId = Annotated[str, StringConstraints(min_length=1, pattern=_IDENT)]
PortName = Annotated[str, StringConstraints(min_length=1, pattern=_IDENT)]

# --- type_id (open, namespaced) --------------------------------------------------------------

RESERVED_COMPONENT_TYPE_ID = "component"
# A namespaced (dotted) node-type id, e.g. "transform.rank". Open (not an enum).
REGISTERED_TYPE_ID_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$"
# The full type_id contract: a namespaced id OR the one reserved literal "component".
TYPE_ID_PATTERN = r"^(component|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+)$"

RegisteredTypeId = Annotated[str, StringConstraints(pattern=REGISTERED_TYPE_ID_PATTERN)]
TypeId = Annotated[str, StringConstraints(pattern=TYPE_ID_PATTERN)]

# --- Versions & entity ids -------------------------------------------------------------------

# A MAJOR.MINOR.PATCH version string (node `type_version`, `schema_version`, component version).
SEMVER_PATTERN = r"^\d+\.\d+\.\d+$"
SemVer = Annotated[str, StringConstraints(pattern=SEMVER_PATTERN)]

_UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"


def _normalize_uuid(value: str) -> str:
    return str(uuid.UUID(value))  # canonicalizes form; pattern above keeps it schema-visible


# A stable entity identifier (strategy id, owner, component id): a canonical UUID string.
EntityId = Annotated[str, StringConstraints(pattern=_UUID_PATTERN), AfterValidator(_normalize_uuid)]

# --- Strict numerics -------------------------------------------------------------------------


# A strict positive integer count/version. `strict` rejects bool and float coercion; `ge` requires
# >= 1. Strict + ge emit a clean JSON-Schema `minimum` (no BeforeValidator that would obscure it).
Count = Annotated[int, Field(strict=True, ge=1)]


def _to_finite_number(value: object) -> float:
    if isinstance(value, bool):
        raise ValueError("a boolean is not a valid number")
    if isinstance(value, int):
        return float(value)  # accept genuine JSON integers like 5
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("number must be finite (no NaN/Infinity)")
        return value
    raise ValueError("must be a finite JSON number")


# A non-negative finite number (e.g. transaction-cost bps): accepts int/float JSON numbers, rejects
# bool/NaN/Infinity. `Field` precedes the validator so JSON Schema emits a clean `minimum: 0`.
NonNegativeFinite = Annotated[float, Field(ge=0), BeforeValidator(_to_finite_number)]

# --- Datetimes -------------------------------------------------------------------------------


def _to_utc(value: datetime) -> datetime:
    """Normalize a timezone-aware datetime to UTC (naive datetimes are rejected upstream)."""
    return value.astimezone(UTC)


# A timezone-aware datetime, normalized to UTC and serialized as RFC 3339. Naive values rejected.
Utc = Annotated[AwareDatetime, AfterValidator(_to_utc)]

_TYPE_ID = re.compile(TYPE_ID_PATTERN)  # retained for internal assertions/tests
