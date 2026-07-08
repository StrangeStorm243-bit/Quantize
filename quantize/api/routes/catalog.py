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
    CATALOG_IDENTITY_FIELDS,
    CatalogInputPortDto,
    CatalogOutputPortDto,
    CompatibilityPairDto,
    NodeCatalogResponse,
    NodeDocDto,
    NodeTypeDto,
    ParamDocDto,
    PortTypeEntryDto,
)
from quantize.api.version import API_VERSION
from quantize.nodes import build_core_catalog
from quantize.registry.descriptor import NodeDoc
from quantize.registry.export import PORT_TYPE_LATTICE, catalog_digest, compatible_pairs
from quantize.schema.primitives import JsonObject
from quantize.schema.types import render_port_type
from quantize.schema.version import CURRENT_SCHEMA_VERSION

router = APIRouter(prefix="/v1", tags=["catalog"])


def _doc_dto(doc: NodeDoc | None) -> NodeDocDto | None:
    """Project a registry ``NodeDoc`` into its wire mirror (identity translation, no logic)."""
    if doc is None:
        return None
    return NodeDocDto(
        summary=doc.summary,
        formula=doc.formula,
        latex=doc.latex,
        semantics=doc.semantics,
        parameters={
            name: ParamDocDto(label=param.label, help=param.help)
            for name, param in doc.parameters.items()
        },
    )


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
            category=descriptor.metadata.category,
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
            doc=_doc_dto(descriptor.metadata.doc),
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
    # Build the envelope with a placeholder digest, then hash the body EXCLUDING the identity
    # fields. Excluding (rather than hand-listing the payload keys) means any future payload field
    # is digest-covered automatically, and matches the recipe a client uses to recompute it.
    projection = NodeCatalogResponse(
        api_version=API_VERSION,
        schema_version=CURRENT_SCHEMA_VERSION,
        catalog_digest="",
        port_types=port_types,
        compatibility=compatibility,
        node_types=node_types,
    )
    body: JsonObject = projection.model_dump(
        mode="json", by_alias=True, exclude=set(CATALOG_IDENTITY_FIELDS)
    )
    return projection.model_copy(update={"catalog_digest": catalog_digest(body)})
