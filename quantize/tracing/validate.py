"""Trace validation against declared payload contracts (M6).

Opt-in (test-time / tooling) — never an always-on runtime cost. Aggregates specs from the two
declared sources: node descriptors (via the catalog) and the engine's own spec tuple. Flags
undeclared event types, payload-schema violations, and abuses of the reserved ``engine.``
namespace by non-engine emitters.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from quantize.engine.trace import ENGINE_TRACE_EVENTS
from quantize.runtime.binding import ImplementationCatalog
from quantize.tracing.events import TraceEvent
from quantize.tracing.spec import ENGINE_EVENT_PREFIX, ENGINE_NODE_ID, TraceEventSpec


def collect_trace_specs(catalog: ImplementationCatalog) -> dict[str, TraceEventSpec]:
    """All declared specs: every node descriptor's plus the engine's. Duplicate event types
    must agree (the same spec object shape) — a conflicting redeclaration fails loudly."""
    specs: dict[str, TraceEventSpec] = {}

    def add(source: str, batch: Iterable[TraceEventSpec]) -> None:
        for spec in batch:
            existing = specs.get(spec.event_type)
            if existing is not None and existing.schema != spec.schema:
                raise ValueError(
                    f"conflicting trace spec for {spec.event_type!r} declared by {source}"
                )
            specs[spec.event_type] = spec

    for implementation in catalog.implementations():
        add(implementation.type_id, implementation.descriptor.trace_events)
    add("engine", ENGINE_TRACE_EVENTS)
    return specs


def validate_trace(
    events: Sequence[TraceEvent], specs: dict[str, TraceEventSpec]
) -> tuple[str, ...]:
    """Human-readable violations (empty = fully conformant), deterministic order."""
    violations: list[str] = []
    for index, event in enumerate(events):
        context = f"event[{index}] {event.event_type!r} from {event.node_id!r}"
        if event.event_type.startswith(ENGINE_EVENT_PREFIX) and (
            event.node_id != ENGINE_NODE_ID or event.component_path != ()
        ):
            # Both halves of the reservation: engine identity AND top-level path — a nested
            # engine.* event would be hoisted into the top-level engine root by the tree
            # builder, silently losing hierarchy.
            violations.append(
                f"{context}: the {ENGINE_EVENT_PREFIX!r} event-type namespace is reserved "
                f"for node_id={ENGINE_NODE_ID!r} at component_path=()"
            )
        spec = specs.get(event.event_type)
        if spec is None:
            violations.append(f"{context}: undeclared event type")
            continue
        for issue in spec.payload_schema.errors(event.payload):
            violations.append(f"{context}: {issue.json_path}: {issue.message}")
    return tuple(violations)
