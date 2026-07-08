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
from quantize.tracing.spec import TraceEventSpec


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


class ParamDoc(_FrozenGoverned):
    """Editor-facing docs for one node parameter: a display ``label`` and optional ``help`` text."""

    label: str = Field(min_length=1)
    help: str | None = None


class NodeDoc(_FrozenGoverned):
    """Structured node meaning served to the editor (M13.1) — the registry is its single home.

    ``summary`` opens with the node's plain-English *role for the machine* (role-first authoring,
    plan D-13). ``formula`` is plain-text/Unicode math; ``latex`` is reserved and never rendered in
    M13. ``semantics`` states the missing-data / alignment / warm-up rules CLAUDE.md requires to be
    explicit. ``parameters`` keys must be a subset of the node's ``parameter_schema`` properties —
    enforced on ``NodeDescriptor`` (which alone knows the schema).
    """

    summary: str = Field(min_length=1)
    formula: str | None = None
    latex: str | None = None
    semantics: str | None = None
    parameters: dict[str, ParamDoc] = Field(default_factory=dict)


class NodeMetadata(_FrozenGoverned):
    """Human-readable metadata a node type declares (consumed by the M10 editor API).

    ``category`` is authored **machine-stage semantics**, not the ``type_id`` namespace (M13.1
    guardrail): a lowercase open-set identifier the editor maps to a stage color/segment. ``doc`` is
    the optional structured meaning block served to the inspector.
    """

    display_name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    category: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    doc: NodeDoc | None = None


class NodeDescriptor(_FrozenGoverned):
    """The static semantic descriptor for a node type: identity, ports, metadata, and schemas.

    ``RegisteredTypeId`` excludes the reserved ``"component"`` node; ``PortType`` excludes the
    engine-only ``OrderList``. An input and an output may share a name; duplicates within inputs
    (or within outputs) are rejected. ``parameter_schema`` validates node ``params`` (M2.4);
    ``trace_schema`` describes ``TraceEvent.payload`` (declared now, used at M6). Node-specific
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
    # M6: per-event payload contracts (schema-versioned). ``trace_schema`` is their combined
    # ``oneOf`` form, honoring the M2 field; both stay empty for nodes that emit no events.
    # Runtime infrastructure — not persisted IR, no codegen impact.
    trace_events: tuple[TraceEventSpec, ...] = ()

    @model_validator(mode="after")
    def _reject_duplicate_port_names(self) -> Self:
        for kind, ports in (("input", self.inputs), ("output", self.outputs)):
            seen: set[str] = set()
            for port in ports:
                if port.name in seen:
                    raise ValueError(f"duplicate {kind} port name {port.name!r}")
                seen.add(port.name)
        return self

    @model_validator(mode="after")
    def _reject_orphan_param_docs(self) -> Self:
        """Every ``doc.parameters`` key must name a real ``parameter_schema`` property.

        The subset check lives here (not on ``NodeDoc``) because only the descriptor knows the
        parameter schema. Exact coverage (every parameter is documented) is a registration-time
        invariant tested over ``build_core_catalog()``, not a per-model rule.
        """
        doc = self.metadata.doc
        if doc is not None and doc.parameters:
            properties: set[str] = set()
            if self.parameter_schema is not None:
                schema_properties = self.parameter_schema.document.get("properties", {})
                if isinstance(schema_properties, dict):
                    properties = set(schema_properties)
            orphans = sorted(set(doc.parameters) - properties)
            if orphans:
                raise ValueError(
                    f"doc.parameters {orphans} are not properties of the parameter schema"
                )
        return self
