"""Tiny helpers for reading already-validated node params.

Semantic validation (M2.4) has checked ``params`` against each descriptor's ``parameter_schema``
before evaluation, so these helpers only narrow types for the implementation — a failure here is
a schema/implementation mismatch (a programming error), not a user fault.
"""

from __future__ import annotations

from collections.abc import Mapping

from quantize.schema.primitives import JsonValue


def require_int(params: Mapping[str, JsonValue], key: str) -> int:
    value = params[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"param {key!r} must be an integer, got {type(value).__name__}")
    return value


def require_number(params: Mapping[str, JsonValue], key: str) -> float:
    value = params[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"param {key!r} must be a number, got {type(value).__name__}")
    return float(value)


def get_bool(params: Mapping[str, JsonValue], key: str, default: bool) -> bool:
    value = params.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"param {key!r} must be a boolean, got {type(value).__name__}")
    return value
