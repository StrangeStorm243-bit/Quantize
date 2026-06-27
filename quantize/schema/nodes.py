"""Generic node instance and edge models (M1.1a).

``NodeInstance`` is generic by design: ``type_id`` is an open namespaced string, so a document may
reference an unknown future node type — M1 accepts it structurally; M2 (the registry) resolves it.
Ordinary nodes pin ``type_version``; the reserved ``component`` node carries ``ref`` instead.
"""

from __future__ import annotations

from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from quantize.schema.primitives import (
    RESERVED_COMPONENT_TYPE_ID,
    JsonObject,
    NodeId,
    PortName,
    RefId,
    SemVer,
    TypeId,
)


class NodeInstance(BaseModel):
    """One node in a strategy (or component) graph."""

    model_config = ConfigDict(extra="forbid")

    id: NodeId
    type_id: TypeId
    type_version: SemVer | None = None
    params: JsonObject = Field(default_factory=dict)
    ref: RefId | None = None
    ui: JsonObject | None = None
    extensions: JsonObject | None = None

    @model_validator(mode="after")
    def _check_version_and_ref(self) -> Self:
        if self.type_id == RESERVED_COMPONENT_TYPE_ID:
            if self.ref is None:
                raise ValueError("a 'component' node requires a 'ref'")
            if self.type_version is not None:
                raise ValueError(
                    "a 'component' node must not carry 'type_version' "
                    "(its version is the pinned ComponentRef.version)"
                )
        else:
            if self.type_version is None:
                raise ValueError(f"ordinary node {self.id!r} requires a 'type_version'")
            if self.ref is not None:
                raise ValueError(f"ordinary node {self.id!r} must not carry a 'ref'")
        return self


class Edge(BaseModel):
    """A directed connection from one node's output port to another node's input port.

    Serializes as ``{"from": [node, port], "to": [node, port]}`` (use ``by_alias=True`` on dump).
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_: tuple[NodeId, PortName] = Field(alias="from", serialization_alias="from")
    to: tuple[NodeId, PortName]
