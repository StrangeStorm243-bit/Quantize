"""Generic node instances and edges.

A node is a **two-variant structural union**, schema-visible and generic:

* ``RegisteredNode`` — an ordinary node of an open, namespaced ``type_id`` (any registered or future
  block), requiring ``type_version``;
* ``ComponentRefNode`` — the one reserved ``type_id == "component"`` node, requiring ``ref``.

This is **not** a closed union of built-in quantitative node types; ``RegisteredNode`` accepts any
namespaced ``type_id``, so adding a new block never changes the IR schema. ``params`` is required
(may be ``{}``); ``ui``/``extensions`` are optional.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Discriminator, Field, Tag, TypeAdapter

from quantize.schema.primitives import (
    JsonObject,
    NodeId,
    PortName,
    RefId,
    RegisteredTypeId,
    SemVer,
)


class RegisteredNode(BaseModel):
    """An ordinary node referencing a registered (or unknown future) node type by namespaced id."""

    model_config = ConfigDict(extra="forbid")

    id: NodeId
    type_id: RegisteredTypeId
    type_version: SemVer
    params: JsonObject
    ui: JsonObject | None = None
    extensions: JsonObject | None = None


class ComponentRefNode(BaseModel):
    """The reserved ``component`` node — references a pinned ``component_refs`` entry by ``ref``."""

    model_config = ConfigDict(extra="forbid")

    id: NodeId
    type_id: Literal["component"]
    ref: RefId
    params: JsonObject
    ui: JsonObject | None = None
    extensions: JsonObject | None = None


def _node_tag(value: object) -> str:
    type_id = value.get("type_id") if isinstance(value, dict) else getattr(value, "type_id", None)
    return "component" if type_id == "component" else "registered"


# Two-variant structural union, discriminated by whether type_id is the reserved "component".
NodeInstance = Annotated[
    Annotated[RegisteredNode, Tag("registered")] | Annotated[ComponentRefNode, Tag("component")],
    Discriminator(_node_tag),
]

# Use to validate a node in isolation (NodeInstance is a union alias, not a class).
NodeAdapter: TypeAdapter[Any] = TypeAdapter(NodeInstance)


class Edge(BaseModel):
    """A directed connection from one node's output port to another node's input port.

    Persisted via the canonical serializer as ``{"from": [node, port], "to": [node, port]}``.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_: tuple[NodeId, PortName] = Field(alias="from", serialization_alias="from")
    to: tuple[NodeId, PortName]
