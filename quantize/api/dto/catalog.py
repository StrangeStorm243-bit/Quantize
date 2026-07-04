"""Node-catalog endpoint DTOs — the wire projection of the node registry (M10).

A read-only projection so a future editor can render the palette: the governed port-type lattice
(with human labels), the compatible-edge enumeration, and one entry per registered node type (its
identity, its typed ports, and its portable-JSON parameter schema). ``PortType`` and ``JsonObject``
are imported from the schema layer — never re-declared here.
"""

from __future__ import annotations

from quantize.api.dto.common import _Dto
from quantize.schema.primitives import JsonObject
from quantize.schema.types import PortType


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
    """One registered node type: identity, typed ports, and its parameter JSON Schema (if any)."""

    type_id: str
    type_version: str
    display_name: str
    description: str
    inputs: tuple[CatalogInputPortDto, ...]
    outputs: tuple[CatalogOutputPortDto, ...]
    parameter_schema: JsonObject | None


class NodeCatalogResponse(_Dto):
    """The full node-catalog projection: versions, a content digest, the lattice, the compatible
    edges, and every registered node type."""

    api_version: str
    schema_version: str
    catalog_digest: str
    port_types: tuple[PortTypeEntryDto, ...]
    compatibility: tuple[CompatibilityPairDto, ...]
    node_types: tuple[NodeTypeDto, ...]
