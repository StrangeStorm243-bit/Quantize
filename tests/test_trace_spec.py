"""M6: trace-event spec contracts — versioning, combined schemas, aggregation, namespace."""

from __future__ import annotations

import pytest

from quantize.engine.trace import ENGINE_TRACE_EVENTS
from quantize.nodes import build_core_catalog, core_node_implementations
from quantize.tracing.spec import (
    ASSET_LIST,
    ENGINE_EVENT_PREFIX,
    STRING,
    TraceEventSpec,
    combined_trace_schema,
)
from quantize.tracing.validate import collect_trace_specs


def test_spec_requires_const_pinned_version() -> None:
    spec = TraceEventSpec.of("x.event", 2, {"asset": STRING}, ("asset",))
    assert spec.payload_schema.errors({"v": 2, "asset": "SPY"}) == ()
    assert spec.payload_schema.errors({"v": 1, "asset": "SPY"})  # wrong version rejected
    assert spec.payload_schema.errors({"asset": "SPY"})  # missing version rejected
    assert spec.payload_schema.errors({"v": 2, "asset": "SPY", "extra": 1})  # closed object


def test_spec_rejects_invalid_construction() -> None:
    with pytest.raises(ValueError):
        TraceEventSpec.of("", 1, {}, ())
    with pytest.raises(ValueError):
        TraceEventSpec.of("x.event", 0, {}, ())


def test_spec_owns_its_schema_copy() -> None:
    from typing import Any

    properties: dict[str, Any] = {"assets": {"type": "array", "items": {"type": "string"}}}
    spec = TraceEventSpec.of("x.event", 1, properties, ("assets",))
    properties["assets"]["items"]["type"] = "number"  # later caller mutation
    assert spec.payload_schema.errors({"v": 1, "assets": ["SPY"]}) == ()


def test_combined_schema_matches_exactly_one_branch() -> None:
    specs = (
        TraceEventSpec.of("x.a", 1, {"asset": STRING}, ("asset",)),
        TraceEventSpec.of("x.b", 1, {"assets": ASSET_LIST}, ("assets",)),
    )
    combined = combined_trace_schema(specs)
    assert combined is not None
    assert combined.errors({"v": 1, "asset": "SPY"}) == ()  # branch 1
    assert combined.errors({"v": 1, "assets": ["SPY"]}) == ()  # branch 2
    assert combined.errors({"v": 1, "asset": "SPY", "assets": ["SPY"]})  # neither (closed)
    assert combined_trace_schema(()) is None


def test_every_core_node_with_events_declares_specs_and_combined_schema() -> None:
    for implementation in core_node_implementations():
        descriptor = implementation.descriptor
        assert descriptor.trace_events, descriptor.type_id  # every core node emits something
        assert descriptor.trace_schema is not None
        for spec in descriptor.trace_events:
            assert spec.version == 1
            # every declared payload schema demands the const-pinned version field
            assert spec.payload_schema.errors({"v": 999})  # wrong/missing fields rejected


def test_collect_trace_specs_aggregates_nodes_and_engine() -> None:
    specs = collect_trace_specs(build_core_catalog())
    node_declared = {
        spec.event_type
        for implementation in core_node_implementations()
        for spec in implementation.descriptor.trace_events
    }
    engine_declared = {spec.event_type for spec in ENGINE_TRACE_EVENTS}
    assert set(specs) == node_declared | engine_declared
    assert all(t.startswith(ENGINE_EVENT_PREFIX) for t in engine_declared)
    assert not any(t.startswith(ENGINE_EVENT_PREFIX) for t in node_declared)


def test_nested_engine_event_is_rejected() -> None:
    # Regression (Codex finding): BOTH halves of the reservation are enforced — an engine.*
    # event with a non-empty component_path would be hoisted into the top-level engine root by
    # the tree builder, silently losing hierarchy.
    from datetime import UTC, datetime

    from quantize.tracing.events import TraceEvent
    from quantize.tracing.validate import validate_trace

    specs = collect_trace_specs(build_core_catalog())
    nested = TraceEvent(
        run_id="12121212-1212-1212-1212-121212121212",
        timestamp=datetime(2026, 1, 5, 21, 0, tzinfo=UTC),
        node_id="engine",
        component_path=("some_instance",),  # NOT top level
        event_type="engine.note",
        payload={"v": 1, "session": "2026-01-05", "code": "x", "message": "y"},
    )
    violations = validate_trace((nested,), specs)
    assert len(violations) == 1 and "reserved" in violations[0]
    # And the well-formed engine event still validates cleanly.
    proper = TraceEvent(
        run_id="12121212-1212-1212-1212-121212121212",
        timestamp=datetime(2026, 1, 5, 21, 0, tzinfo=UTC),
        node_id="engine",
        component_path=(),
        event_type="engine.note",
        payload={"v": 1, "session": "2026-01-05", "code": "x", "message": "y"},
    )
    assert validate_trace((proper,), specs) == ()


def test_node_sink_cannot_spoof_engine_events() -> None:
    # Regression (Codex finding): the node-facing sink is the spoof channel - even a node
    # LITERALLY NAMED "engine" at top level cannot emit engine.* events; the reservation is
    # enforced at the emission boundary, not just post-hoc validation. The engine itself never
    # uses a node sink (it constructs TraceEvents directly in backtest.py).
    from datetime import UTC, datetime

    from quantize.tracing.events import TraceEvent
    from quantize.tracing.recorder import TraceRecorder

    recorder = TraceRecorder(
        "12121212-1212-1212-1212-121212121212",
        datetime(2026, 1, 5, 21, 0, tzinfo=UTC),
    )
    spoofing_sink = recorder.sink_for("engine", ())  # a user node named "engine", top level
    with pytest.raises(ValueError, match="reserved engine namespace"):
        spoofing_sink("engine.note", {"v": 1, "session": "2026-01-05", "code": "x", "message": "y"})
    assert len(recorder.events) == 0  # nothing leaked through
    spoofing_sink("x.ordinary", {"v": 1})  # non-engine events still flow normally
    recorded: tuple[TraceEvent, ...] = recorder.events
    assert [event.event_type for event in recorded] == ["x.ordinary"]


def test_conflicting_redeclaration_fails_loud() -> None:
    from quantize.registry.descriptor import NodeDescriptor, NodeMetadata, OutputPortSpec
    from quantize.runtime.binding import ImplementationCatalog, NodeImplementation
    from quantize.schema.types import ScalarType

    conflicting = TraceEventSpec.of("universe.selected", 1, {"other": STRING}, ("other",))
    descriptor = NodeDescriptor(
        type_id="test.conflict",
        type_version="1.0.0",
        inputs=(),
        outputs=(OutputPortSpec(name="out", port_type=ScalarType(kind="Scalar", dtype="Number")),),
        metadata=NodeMetadata(
            display_name="X", description="conflicting spec fixture", category="transform"
        ),
        trace_events=(conflicting,),
    )
    catalog = ImplementationCatalog()
    for implementation in core_node_implementations():
        catalog.register(implementation)
    from quantize.runtime.values import ScalarValue

    catalog.register(
        NodeImplementation(
            descriptor=descriptor,
            evaluate=lambda invocation: {"out": ScalarValue(dtype="Number", value=1.0)},
        )
    )
    with pytest.raises(ValueError, match="conflicting trace spec"):
        collect_trace_specs(catalog)
