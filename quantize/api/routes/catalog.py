"""The read-only node-catalog endpoint (M10).

Projects the node registry for a future editor palette: the governed port-type lattice (with human
labels), the compatible-edge enumeration (produced by the single shared ``is_compatible`` via
``compatible_pairs`` — never a second table), and one entry per registered node type. Pure
translation over a fresh core catalog per request — no database, no numerics. The ``catalog_digest``
is a content hash over the projection body EXCLUDING the identity fields, so a client can detect a
catalog change independent of the api/schema version labels.
"""

from __future__ import annotations

from fastapi import APIRouter

from quantize.api.dto.catalog import (
    CatalogInputPortDto,
    CatalogOutputPortDto,
    CompatibilityPairDto,
    NodeCatalogResponse,
    NodeTypeDto,
    PortTypeEntryDto,
)
from quantize.api.version import API_VERSION
from quantize.nodes import build_core_catalog
from quantize.registry.export import PORT_TYPE_LATTICE, catalog_digest, compatible_pairs
from quantize.schema.primitives import JsonObject
from quantize.schema.types import render_port_type
from quantize.schema.version import CURRENT_SCHEMA_VERSION

router = APIRouter(prefix="/v1", tags=["catalog"])


@router.get("/node-types")
def get_node_types() -> NodeCatalogResponse:
    """The full node-catalog projection: versions, a content digest, the lattice, the compatible
    edges, and every registered node type."""
    catalog = build_core_catalog()
    node_types = tuple(
        NodeTypeDto(
            type_id=descriptor.type_id,
            type_version=descriptor.type_version,
            display_name=descriptor.metadata.display_name,
            description=descriptor.metadata.description,
            inputs=tuple(
                CatalogInputPortDto(
                    name=port.name, port_type=port.port_type, required=port.required
                )
                for port in descriptor.inputs
            ),
            outputs=tuple(
                CatalogOutputPortDto(name=port.name, port_type=port.port_type)
                for port in descriptor.outputs
            ),
            parameter_schema=(
                descriptor.parameter_schema.document
                if descriptor.parameter_schema is not None
                else None
            ),
        )
        for descriptor in catalog.descriptors()
    )
    port_types = tuple(
        PortTypeEntryDto(port_type=port_type, label=render_port_type(port_type))
        for port_type in PORT_TYPE_LATTICE
    )
    compatibility = tuple(
        CompatibilityPairDto(source=source, destination=destination)
        for (source, destination) in compatible_pairs()
    )
    body: JsonObject = {
        "compatibility": [pair.model_dump(mode="json", by_alias=True) for pair in compatibility],
        "node_types": [node.model_dump(mode="json", by_alias=True) for node in node_types],
        "port_types": [entry.model_dump(mode="json", by_alias=True) for entry in port_types],
    }
    return NodeCatalogResponse(
        api_version=API_VERSION,
        schema_version=CURRENT_SCHEMA_VERSION,
        catalog_digest=catalog_digest(body),
        port_types=port_types,
        compatibility=compatibility,
        node_types=node_types,
    )
