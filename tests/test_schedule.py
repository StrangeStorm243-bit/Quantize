"""Tests for the closed schedule union (M1.1a)."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from quantize.schema.schedule import Schedule

_schedule: TypeAdapter[Any] = TypeAdapter(Schedule)


def test_schedule_accepts_three_v0_kinds() -> None:
    for kind in ("daily", "weekly", "monthly"):
        assert _schedule.validate_python({"kind": kind}).kind == kind


def test_schedule_rejects_unknown_kind() -> None:
    with pytest.raises(ValidationError) as exc:
        _schedule.validate_python({"kind": "quarterly"})
    assert exc.value.errors()[0]["type"] == "union_tag_invalid"


def test_schedule_forbids_extra_fields() -> None:
    with pytest.raises(ValidationError) as exc:
        _schedule.validate_python({"kind": "monthly", "anchor": "session_close"})
    err = exc.value.errors()[0]
    assert err["type"] == "extra_forbidden"
    assert "anchor" in str(err["loc"])


def test_schedule_round_trips_via_json() -> None:
    value = _schedule.validate_python({"kind": "weekly"})
    assert _schedule.validate_json(_schedule.dump_json(value)) == value
