"""Structured validation result types.

The shapes here are deliberately small and stable — enough for a future API to serialize as plain
JSON and for a future visual editor to highlight the responsible node, edge, or component reference
(via ``loc`` and ``subject``). This is **not** a universal diagnostic framework; it is the minimal
contract validation needs.

* **Structural** (M1.2): ``StructuralError`` / ``StructuralValidation`` + ``ComponentKey`` /
  ``ComponentSetValidation`` — registry-free, cross-element well-formedness.
* **Semantic** (M2.2): ``SemanticDiagnostic`` / ``SemanticValidation`` — registry-dependent meaning
  (node-type existence, version availability, port-name existence, required connectivity).
"""

from __future__ import annotations

from dataclasses import dataclass, field

# --- Stable error codes ----------------------------------------------------------------------
# Machine-stable identifiers (an editor/API keys on these, not on the human message text).
UNSUPPORTED_SCHEMA_VERSION = "unsupported_schema_version"
DUPLICATE_NODE_ID = "duplicate_node_id"
EDGE_ENDPOINT_UNKNOWN_NODE = "edge_endpoint_unknown_node"
SELF_EDGE = "self_edge"
GRAPH_CYCLE = "graph_cycle"
DUPLICATE_REF_ID = "duplicate_ref_id"
UNKNOWN_COMPONENT_REF = "unknown_component_ref"
COMPONENT_DIRECT_RECURSION = "component_direct_recursion"
COMPONENT_CYCLE = "component_cycle"
DUPLICATE_COMPONENT_DEFINITION = "duplicate_component_definition"


@dataclass(frozen=True)
class StructuralError:
    """One structural fault.

    * ``code`` — a stable machine identifier (see the module constants).
    * ``message`` — a human-readable description.
    * ``loc`` — a structural path into the document (e.g. ``("edges", 2, "from")``), for an editor
      to locate the fault and for deterministic ordering.
    * ``subject`` — the responsible entity id when one applies (a node id, ref id, or
      ``"<component_id>@<version>"``), so an editor can highlight it directly.
    """

    code: str
    message: str
    loc: tuple[str | int, ...]
    subject: str | None = None


@dataclass(frozen=True)
class StructuralValidation:
    """The outcome of validating a single strategy document or component definition."""

    ok: bool
    errors: tuple[StructuralError, ...] = ()


@dataclass(frozen=True, order=True)
class ComponentKey:
    """The identity of a component definition: its ``component_id`` plus pinned ``version``."""

    component_id: str
    version: str

    def __str__(self) -> str:
        return f"{self.component_id}@{self.version}"


@dataclass(frozen=True)
class ComponentSetValidation:
    """The outcome of validating a caller-supplied set of component definitions (plan §5).

    Three deterministic outcomes:

    * **closed & valid:** ``ok=True``, ``errors=()``, ``unresolved_refs=()``.
    * **acyclic but incomplete:** ``ok=True``, ``errors=()``, ``unresolved_refs=(...)`` — references
      to ``(component_id, version)`` **outside** the supplied set; deferred to M2/M3, not failures.
    * **cyclic / structural error:** ``ok=False``, ``errors=(...)``.
    """

    ok: bool
    errors: tuple[StructuralError, ...] = ()
    unresolved_refs: tuple[ComponentKey, ...] = field(default_factory=tuple)


# --- Semantic diagnostics (M2.2) -------------------------------------------------------------
# Machine-stable identifiers (an editor/API keys on these, not on the human message text).
UNKNOWN_NODE_TYPE = "unknown_node_type"
NODE_VERSION_UNAVAILABLE = "node_version_unavailable"
UNKNOWN_OUTPUT_PORT = "unknown_output_port"
UNKNOWN_INPUT_PORT = "unknown_input_port"
REQUIRED_INPUT_UNCONNECTED = "required_input_unconnected"


@dataclass(frozen=True)
class SemanticDiagnostic:
    """One semantic finding (registry-dependent). Same shape as ``StructuralError``; distinct type.

    * ``code`` — a stable machine identifier (see the module constants above).
    * ``message`` — a human-readable description.
    * ``loc`` — a structural path into the document (e.g. ``("edges", 2, "to")``).
    * ``subject`` — the responsible entity (a ``type_id``, port name, …) when one applies.
    """

    code: str
    message: str
    loc: tuple[str | int, ...]
    subject: str | None = None


@dataclass(frozen=True)
class SemanticValidation:
    """The outcome of semantic validation.

    v0 has only hard errors, so ``ok = not diagnostics``. ``diagnostics`` (not ``errors``) leaves
    room for future warning/info findings without renaming the field.
    """

    ok: bool
    diagnostics: tuple[SemanticDiagnostic, ...] = ()
