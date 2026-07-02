"""Ordered, deterministic trace-event collection for one evaluation run (M3 plumbing).

This is emission plumbing only — detailed per-node payload construction is M6 and persistence is
M7. The recorder appends ``TraceEvent``s in evaluation order (deterministic because the evaluator's
node order and each node's internal emission order are deterministic) and stamps every event with
the run id and the run's single deterministic timestamp (the evaluation instant) — never
wall-clock time.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Protocol

from quantize.schema.primitives import JsonValue
from quantize.tracing.events import TraceEvent
from quantize.tracing.spec import ENGINE_EVENT_PREFIX


class TraceSink(Protocol):
    """What a node sees: emit one event type + payload; identity/time are already bound."""

    def __call__(self, event_type: str, payload: Mapping[str, JsonValue]) -> None: ...


class TraceRecorder:
    """Collects the trace events of one run, in emission order.

    ``enabled=False`` makes every emit a no-op (the M6 tracing switch): emitters still call
    their sinks, so control flow — and therefore every financial output — is byte-identical
    with tracing on or off.
    """

    def __init__(self, run_id: str, timestamp: datetime, *, enabled: bool = True) -> None:
        self._run_id = run_id
        self._timestamp = timestamp
        self._enabled = enabled
        self._events: list[TraceEvent] = []

    def emit(
        self,
        node_id: str,
        component_path: tuple[str, ...],
        event_type: str,
        payload: Mapping[str, JsonValue],
    ) -> None:
        self.emit_at(self._timestamp, node_id, component_path, event_type, payload)

    def emit_at(
        self,
        timestamp: datetime,
        node_id: str,
        component_path: tuple[str, ...],
        event_type: str,
        payload: Mapping[str, JsonValue],
    ) -> None:
        """Emit with an explicit separately-modeled instant (M6: engine fill/note events)."""
        if not self._enabled:
            return
        self._events.append(
            TraceEvent(
                run_id=self._run_id,
                timestamp=timestamp,
                node_id=node_id,
                component_path=component_path,
                event_type=event_type,
                payload=dict(payload),
            )
        )

    def sink_for(self, node_id: str, component_path: tuple[str, ...]) -> TraceSink:
        """A sink bound to one node's identity, for handing into its invocation.

        The ``engine.`` event-type namespace is reserved for the engine, which constructs its
        events directly (never through a node sink) — so ANY ``engine.``-prefixed emission
        through this path is a node spoofing engine identity (including a node literally named
        ``engine``) and fails loudly at the emission boundary.
        """

        def sink(event_type: str, payload: Mapping[str, JsonValue]) -> None:
            if event_type.startswith(ENGINE_EVENT_PREFIX):
                raise ValueError(
                    f"event type {event_type!r} is in the reserved engine namespace and "
                    "cannot be emitted through a node trace sink"
                )
            self.emit(node_id, component_path, event_type, payload)

        return sink

    @property
    def events(self) -> tuple[TraceEvent, ...]:
        return tuple(self._events)
