"""The minimal trace-event envelope (fixed at M2).

M2 fixes only the shape so registered nodes can declare a ``trace_schema`` for the payload. Trace
CONSTRUCTION is M6; payload validation against ``trace_schema`` is M6; persistence is M7. The
envelope reuses the IR primitives, so ids/timestamps/payloads obey the same portable-JSON rules.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from quantize.schema.primitives import EntityId, JsonObject, NodeId, Utc


class _FrozenTraceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class TraceEvent(_FrozenTraceModel):
    """One structured decision-trace event (envelope only; ``payload`` shape is per-node)."""

    run_id: EntityId
    timestamp: Utc
    node_id: NodeId
    component_path: tuple[NodeId, ...] = ()  # hierarchical component-instance path; () == top level
    event_type: str = Field(min_length=1)  # open string (events are extensible, like type_id)
    payload: JsonObject
