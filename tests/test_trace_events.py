"""M2 — minimal trace-event envelope."""

import pytest
from pydantic import ValidationError

from quantize.tracing.events import TraceEvent

_RUN = "44444444-4444-4444-4444-444444444444"


def _event(**overrides: object) -> TraceEvent:
    base: dict[str, object] = dict(
        run_id=_RUN,
        timestamp="2026-01-01T00:00:00Z",
        node_id="rk",
        event_type="evaluated",
        payload={},
    )
    base.update(overrides)
    return TraceEvent(**base)  # type: ignore[arg-type]


def test_trace_event_constructs_and_defaults_component_path() -> None:
    assert _event().component_path == ()


def test_trace_event_keeps_component_path() -> None:
    assert _event(component_path=("c1", "c2")).component_path == ("c1", "c2")


def test_trace_event_rejects_naive_timestamp() -> None:
    with pytest.raises(ValidationError):
        _event(timestamp="2026-01-01T00:00:00")  # no tzinfo


def test_trace_event_rejects_empty_event_type() -> None:
    with pytest.raises(ValidationError):
        _event(event_type="")


def test_trace_event_rejects_non_portable_payload() -> None:
    with pytest.raises(ValidationError):
        _event(payload={"x": float("nan")})


def test_trace_event_rejects_bad_node_id() -> None:
    with pytest.raises(ValidationError):
        _event(node_id="not a valid id")


def test_trace_event_forbids_unknown_field() -> None:
    with pytest.raises(ValidationError):
        _event(flavor="spicy")
