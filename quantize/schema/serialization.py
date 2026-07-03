"""Canonical IR serialization boundary.

Pydantic's default JSON dump silently rewrites non-portable values (NaN/Infinity -> null) and
uses Python field names (from_) unless by_alias=True is remembered. These helpers are the only
sanctioned way to persist an IR model: dump in Python mode (so invalid values stay detectable),
recursively revalidate portability, normalize datetimes to RFC 3339, and emit aliased,
deterministic JSON, raising on non-portable state rather than rewriting it.
"""

from __future__ import annotations

import json
import math
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel

from quantize.schema.primitives import JS_MAX_SAFE_INT


def _to_portable(value: Any) -> Any:
    """Recursively convert a Python-mode dump to portable JSON, raising on any invalid value."""
    # bool before int (bool is an int subclass); str/None pass through.
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if not -JS_MAX_SAFE_INT <= value <= JS_MAX_SAFE_INT:
            raise ValueError(f"integer {value} is outside the JS-safe range; cannot persist")
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("NaN/Infinity is not portable JSON; cannot persist")
        # Canonical zero (pre-M9 F): -0.0 == 0.0 numerically but serializes as "-0.0",
        # splitting content hashes over a sign bit no consumer can act on. Nonzero signs
        # untouched; historical -0.0 bytes still LOAD fine (their stored hashes re-hash
        # their stored bytes, never a re-serialized form).
        if value == 0.0:
            return 0.0
        return value
    if isinstance(value, datetime):
        return value.isoformat()  # RFC 3339 (aware UTC)
    if isinstance(value, date):  # after datetime -- datetime subclasses date
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_to_portable(item) for item in value]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("JSON object keys must be strings; cannot persist")
            out[key] = _to_portable(item)
        return out
    raise ValueError(f"{type(value).__name__} is not portable JSON and cannot be persisted")


def to_ir_dict(model: BaseModel) -> dict[str, Any]:
    """Return the canonical, alias-keyed, portable dict for *model* (raises on invalid state)."""
    raw = model.model_dump(mode="python", by_alias=True)
    portable = _to_portable(raw)
    assert isinstance(portable, dict)
    return portable


def to_ir_json(model: BaseModel) -> str:
    """Canonical IR JSON for a model: aliased, portable, deterministic (raises on bad state)."""
    return json.dumps(to_ir_dict(model), ensure_ascii=False, allow_nan=False, separators=(",", ":"))
