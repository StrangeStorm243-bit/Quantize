"""Component models: standalone ``ComponentDefinition`` documents and pinned ``ComponentRef``s.

A component's implementation is held behind a discriminator; v0 ships only ``kind:"graph"`` (other
kinds are future schema additions, not implemented). Exposed ports use the v0 ``PortType`` lattice —
which excludes ``OrderList`` — so a component can never expose an engine-only order list. All
contract collections are required (may be empty), never silently defaulted.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from quantize.schema.nodes import Edge, NodeInstance
from quantize.schema.primitives import EntityId, JsonObject, NodeId, PortName, RefId, SemVer
from quantize.schema.provenance import ComponentForkRef, Provenance
from quantize.schema.types import PortType
from quantize.schema.version import SchemaVersion


class _Governed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ComponentRef(_Governed):
    """A pinned reference from a strategy/definition to a specific component version."""

    id: RefId
    component_id: EntityId
    version: SemVer


class ExposedPort(_Governed):
    """A component's externally visible port, mapped to one internal node port."""

    name: str = Field(min_length=1)
    type: PortType
    maps_to: tuple[NodeId, PortName]


class ExposedParam(_Governed):
    """A component parameter, bound to one internal node parameter."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: str = Field(min_length=1)
    binds_to: tuple[NodeId, str]
    # 'schema' is exposed in JSON; aliased to avoid shadowing Pydantic internals.
    schema_: JsonObject = Field(alias="schema", serialization_alias="schema")


class Graph(_Governed):
    """An internal node/edge graph (a component's body for the v0 'graph' implementation)."""

    nodes: list[NodeInstance]
    edges: list[Edge]


class GraphImplementation(_Governed):
    kind: Literal["graph"]
    graph: Graph


# Discriminated implementation seam; v0 has only the 'graph' kind.
Implementation = Annotated[GraphImplementation, Field(discriminator="kind")]


class ComponentDefinition(_Governed):
    """A standalone, immutable, versioned reusable component."""

    component_id: EntityId
    version: SemVer
    schema_version: SchemaVersion
    name: str = Field(min_length=1)
    description: str | None = None
    component_refs: list[ComponentRef]
    implementation: Implementation
    exposed_inputs: list[ExposedPort]
    exposed_outputs: list[ExposedPort]
    exposed_params: list[ExposedParam]
    provenance: Provenance[ComponentForkRef]
    extensions: JsonObject | None = None
