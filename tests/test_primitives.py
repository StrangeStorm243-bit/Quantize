"""Tests for IR primitive types (M1.1a): JsonObject, TypeId, SemVer, Utc."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest
from pydantic import TypeAdapter, ValidationError

from quantize.schema.primitives import JS_MAX_SAFE_INT, JsonObject, SemVer, TypeId, Utc

_json = TypeAdapter(JsonObject)
_type_id = TypeAdapter(TypeId)
_semver = TypeAdapter(SemVer)
_utc = TypeAdapter(Utc)


# --- JsonObject: valid / invalid / round-trip ------------------------------------------------


def test_json_object_accepts_nested_portable_json() -> None:
    value = {"n": 1, "f": 1.5, "b": True, "s": "x", "list": [1, "a", None], "obj": {"k": 2}}
    assert _json.validate_python(value) == value


def test_json_object_rejects_nan_and_infinity() -> None:
    with pytest.raises(ValidationError):
        _json.validate_python({"x": float("nan")})
    with pytest.raises(ValidationError):
        _json.validate_python({"x": float("inf")})


def test_json_object_rejects_integer_outside_js_safe_range() -> None:
    assert _json.validate_python({"x": JS_MAX_SAFE_INT}) == {"x": JS_MAX_SAFE_INT}
    with pytest.raises(ValidationError):
        _json.validate_python({"x": JS_MAX_SAFE_INT + 1})


def test_json_object_rejects_non_portable_value() -> None:
    with pytest.raises(ValidationError):
        _json.validate_python({"x": object()})


def test_json_object_serialization_emits_no_nan_or_infinity() -> None:
    # Serialize-side guarantee (HIGH-5): valid data never serializes NaN/Infinity tokens.
    blob = _json.dump_json({"a": 1.5, "b": [1, 2], "c": {"d": True}})
    assert b"NaN" not in blob
    assert b"Infinity" not in blob


# --- TypeId: open & namespaced, with the one reserved exception ------------------------------


def test_type_id_accepts_namespaced_and_reserved_component() -> None:
    assert _type_id.validate_python("transform.rank") == "transform.rank"
    assert _type_id.validate_python("vendor.ns.deep_block") == "vendor.ns.deep_block"
    assert _type_id.validate_python("component") == "component"


def test_type_id_rejects_bare_or_empty() -> None:
    for bad in ["rank", "", "Transform.Rank", "transform."]:
        with pytest.raises(ValidationError):
            _type_id.validate_python(bad)


# --- SemVer ----------------------------------------------------------------------------------


def test_semver_accepts_major_minor_patch_only() -> None:
    assert _semver.validate_python("1.0.0") == "1.0.0"
    for bad in ["1.0", "1", "v1.0.0", "1.0.0-rc1"]:
        with pytest.raises(ValidationError):
            _semver.validate_python(bad)


# --- Utc: tz-aware, normalized to UTC, RFC-3339 round-trip ----------------------------------


def test_utc_normalizes_aware_datetime_and_rejects_naive() -> None:
    aware = datetime(2026, 6, 23, 5, 0, 0, tzinfo=timezone(timedelta(hours=5)))
    normalized = _utc.validate_python(aware)
    assert normalized.tzinfo == UTC
    assert normalized == aware  # same instant, different representation
    assert normalized.hour == 0  # 05:00+05:00 == 00:00Z

    with pytest.raises(ValidationError):
        _utc.validate_python(datetime(2026, 6, 23, 0, 0, 0))  # naive -> rejected


def test_utc_round_trips_via_rfc3339_json() -> None:
    parsed = _utc.validate_json('"2026-06-23T00:00:00Z"')
    assert parsed.tzinfo == UTC
    restored = _utc.validate_json(_utc.dump_json(parsed))
    assert restored == parsed
