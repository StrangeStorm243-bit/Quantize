"""The top-level strategy document and its execution-policy / metadata models.

``StrategyDocument`` is the persisted IR instance — the semantic source of truth. v0 supports one
execution policy; it is modeled explicitly (closed) so additional policies can be added later. All
contract collections are required (may be empty), never silently defaulted.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from quantize.schema.components import ComponentRef
from quantize.schema.nodes import Edge, NodeInstance
from quantize.schema.primitives import Count, EntityId, JsonObject, NonNegativeFinite
from quantize.schema.provenance import Provenance, StrategyForkRef
from quantize.schema.schedule import Schedule
from quantize.schema.version import SchemaVersion


class _Governed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TransactionCosts(_Governed):
    model: Literal["bps"]
    bps: NonNegativeFinite


class ExecutionPolicy(_Governed):
    policy: Literal["close_signal_next_session_open"]
    valuation: Literal["session_close"]
    transaction_costs: TransactionCosts


class StrategyMeta(_Governed):
    id: EntityId
    version: Count
    name: str = Field(min_length=1)
    description: str | None = None
    provenance: Provenance[StrategyForkRef]


class StrategyDocument(_Governed):
    schema_version: SchemaVersion
    strategy: StrategyMeta
    execution_policy: ExecutionPolicy
    schedule: Schedule
    nodes: list[NodeInstance]
    edges: list[Edge]
    component_refs: list[ComponentRef]
    extensions: JsonObject | None = None
