"""Node-catalog endpoint DTOs — the wire projection of the node registry (M10).

A read-only projection so a future editor can render the palette: the governed port-type lattice
(with human labels), the compatible-edge enumeration, and one entry per registered node type (its
identity, its typed ports, and its portable-JSON parameter schema). ``PortType`` and ``JsonObject``
are imported from the schema layer — never re-declared here.
"""

from __future__ import annotations

from pydantic import Field

from quantize.api.dto.common import _Dto
from quantize.schema.primitives import JsonObject
from quantize.schema.types import PortType


class ParamDocDto(_Dto):
    """Wire mirror of ``registry.descriptor.ParamDoc`` — a parameter's display label + help."""

    label: str
    help: str | None = None


class NodeDocDto(_Dto):
    """Wire mirror of ``registry.descriptor.NodeDoc`` — the node's role-first meaning for the
    editor (``summary`` prose, plain-text ``formula``, reserved ``latex``, ``semantics``, and
    per-parameter docs)."""

    summary: str
    formula: str | None = None
    latex: str | None = None
    semantics: str | None = None
    parameters: dict[str, ParamDocDto] = Field(default_factory=dict)


class PortTypeEntryDto(_Dto):
    """One lattice member paired with its compact human ``label`` (e.g. ``"Scalar[Number]"``)."""

    port_type: PortType
    label: str


class CompatibilityPairDto(_Dto):
    """One allowed ``(source -> destination)`` edge over the port-type lattice."""

    source: PortType
    destination: PortType


class CatalogInputPortDto(_Dto):
    """One declared input port of a node type."""

    name: str
    port_type: PortType
    required: bool


class CatalogOutputPortDto(_Dto):
    """One declared output port of a node type."""

    name: str
    port_type: PortType


class NodeTypeDto(_Dto):
    """One registered node type: identity, machine-stage ``category``, typed ports, its parameter
    JSON Schema (if any), and the structured ``doc`` block the inspector renders (M13.1)."""

    type_id: str
    type_version: str
    display_name: str
    description: str
    category: str
    inputs: tuple[CatalogInputPortDto, ...]
    outputs: tuple[CatalogOutputPortDto, ...]
    parameter_schema: JsonObject | None
    doc: NodeDocDto | None = None


class NodeCatalogResponse(_Dto):
    """The full node-catalog projection: versions, a content digest, the lattice, the compatible
    edges, and every registered node type."""

    api_version: str
    schema_version: str
    catalog_digest: str
    port_types: tuple[PortTypeEntryDto, ...]
    compatibility: tuple[CompatibilityPairDto, ...]
    node_types: tuple[NodeTypeDto, ...]


# The envelope's identity fields — excluded from the content digest so ``catalog_digest`` changes
# only when the projected CONTENT changes, not when a version label moves. The route hashes every
# OTHER field; naming the identity set here (not the payload set) means a future payload field is
# digest-covered automatically, and a client recomputes the digest by excluding exactly these keys.
CATALOG_IDENTITY_FIELDS = frozenset({"api_version", "schema_version", "catalog_digest"})
