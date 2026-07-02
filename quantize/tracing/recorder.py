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


class TraceSink(Protocol):
    """What a node sees: emit one event type + payload; identity/time are already bound."""

    def __call__(self, event_type: str, payload: Mapping[str, JsonValue]) -> None: ...


class TraceRecorder:
    """Collects the trace events of one run, in emission order."""

    def __init__(self, run_id: str, timestamp: datetime) -> None:
        self._run_id = run_id
        self._timestamp = timestamp
        self._events: list[TraceEvent] = []

    def emit(
        self,
        node_id: str,
        component_path: tuple[str, ...],
        event_type: str,
        payload: Mapping[str, JsonValue],
    ) -> None:
        self._events.append(
            TraceEvent(
                run_id=self._run_id,
                timestamp=self._timestamp,
                node_id=node_id,
                component_path=component_path,
                event_type=event_type,
                payload=dict(payload),
            )
        )

    def sink_for(self, node_id: str, component_path: tuple[str, ...]) -> TraceSink:
        """A sink bound to one node's identity, for handing into its invocation."""

        def sink(event_type: str, payload: Mapping[str, JsonValue]) -> None:
            self.emit(node_id, component_path, event_type, payload)

        return sink

    @property
    def events(self) -> tuple[TraceEvent, ...]:
        return tuple(self._events)
