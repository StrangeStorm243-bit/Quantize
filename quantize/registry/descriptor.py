"""Static node descriptors — the editor-facing semantic subset of a node type's contract.

A descriptor declares a node type's identity, ports, and human-readable metadata. It is runtime
infrastructure authored by node code; it is NOT persisted IR and does not participate in codegen.
The full executable contract (parameter schema, evaluate, trace schema, purity, warm-up, cadence)
is defined in later slices.
"""

from __future__ import annotations

from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.schema.primitives import PortName, RegisteredTypeId, SemVer
from quantize.schema.types import PortType


class _FrozenGoverned(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class InputPortSpec(_FrozenGoverned):
    """A named, typed input port. ``required`` distinguishes mandatory from optional inputs."""

    name: PortName
    port_type: PortType
    # strict: a typo like required="false" must fail loud, never coerce to a boolean.
    required: bool = Field(default=True, strict=True)


class OutputPortSpec(_FrozenGoverned):
    """A named, typed output port. Outputs have no ``required`` flag."""

    name: PortName
    port_type: PortType


class NodeMetadata(_FrozenGoverned):
    """Human-readable metadata a node type declares (consumed later by the M10 editor API)."""

    display_name: str = Field(min_length=1)
    description: str = Field(min_length=1)


class NodeDescriptor(_FrozenGoverned):
    """The static semantic descriptor for a node type: identity, ports, metadata, and schemas.

    ``RegisteredTypeId`` excludes the reserved ``"component"`` node; ``PortType`` excludes engine-only
    ``OrderList``. An input and an output may share a name; duplicates *within* inputs or *within*
    outputs are rejected. ``parameter_schema`` validates node ``params`` (M2.4); ``trace_schema`` is
    the schema of ``TraceEvent.payload`` this node emits (declared now, used at M6). Node-specific
    validation hooks are deferred until a real node needs a rule JSON Schema cannot express.
    """

    # arbitrary_types_allowed: the *_schema fields hold the non-Pydantic JsonSchemaSpec. Scoped to
    # this model — ports and metadata stay on the stricter shared base.
    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    type_id: RegisteredTypeId
    type_version: SemVer
    inputs: tuple[InputPortSpec, ...]
    outputs: tuple[OutputPortSpec, ...]
    metadata: NodeMetadata
    parameter_schema: JsonSchemaSpec | None = None
    trace_schema: JsonSchemaSpec | None = None

    @model_validator(mode="after")
    def _reject_duplicate_port_names(self) -> Self:
        for kind, ports in (("input", self.inputs), ("output", self.outputs)):
            seen: set[str] = set()
            for port in ports:
                if port.name in seen:
                    raise ValueError(f"duplicate {kind} port name {port.name!r}")
                seen.add(port.name)
        return self
