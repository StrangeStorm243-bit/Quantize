"""Semantic validation — registry resolution, port wiring by name, and port-type compatibility.

Operates on an ALREADY-PARSED, STRUCTURALLY-VALID ``StrategyDocument``; it does not rerun or
duplicate M1 structural checks. Pure, deterministic, registry-injected (read-only
``NodeRegistryView``). Covers (M2.2) registered-node resolution, port-name existence, required-input
connectivity, and (M2.3) port-type compatibility via the single shared ``is_compatible``.
Out of scope (later slices): parameter validation (M2.4) and component resolution (M3);
``ComponentRefNode``s are not registry-resolved here.
"""

from __future__ import annotations

from quantize.compatibility import is_compatible
from quantize.registry.descriptor import NodeDescriptor
from quantize.registry.registry import NodeRegistryView, ResolutionStatus
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import RegisteredNode
from quantize.schema.types import PortType
from quantize.validation.diagnostics import sort_diagnostics
from quantize.validation.errors import (
    INCOMPATIBLE_PORT_TYPES,
    NODE_VERSION_UNAVAILABLE,
    REQUIRED_INPUT_UNCONNECTED,
    UNKNOWN_INPUT_PORT,
    UNKNOWN_NODE_TYPE,
    UNKNOWN_OUTPUT_PORT,
    SemanticDiagnostic,
    SemanticValidation,
)


def _render_type(port_type: PortType) -> str:
    """Compact human rendering of a port type — total over current PortType variants."""
    dtype = getattr(port_type, "dtype", None)
    return f"{port_type.kind}[{dtype}]" if dtype is not None else port_type.kind


def validate_strategy_semantics(
    document: StrategyDocument, registry: NodeRegistryView
) -> SemanticValidation:
    """Resolve registered nodes and check edge port wiring by name (see module docstring)."""
    diagnostics: list[SemanticDiagnostic] = []
    resolved: dict[str, NodeDescriptor] = {}

    # 1. Registered-node resolution. Component nodes are deferred to M3 (skipped here).
    for index, node in enumerate(document.nodes):
        if not isinstance(node, RegisteredNode):
            continue
        result = registry.resolve(node.type_id, node.type_version)
        if result.status is ResolutionStatus.OK:
            # OK ⇒ descriptor present (NodeResolution invariant).
            assert result.descriptor is not None
            resolved[node.id] = result.descriptor
        elif result.status is ResolutionStatus.UNKNOWN_TYPE:
            diagnostics.append(
                SemanticDiagnostic(
                    UNKNOWN_NODE_TYPE,
                    f"node type {node.type_id!r} is not registered",
                    ("nodes", index),
                    node.type_id,
                )
            )
        else:  # VERSION_UNAVAILABLE
            available = ", ".join(result.available_versions)
            diagnostics.append(
                SemanticDiagnostic(
                    NODE_VERSION_UNAVAILABLE,
                    f"node type {node.type_id!r} has no version {node.type_version!r} "
                    f"(available: {available})",
                    ("nodes", index),
                    node.type_id,
                )
            )

    # 2. Port-name existence + port-type compatibility on edges. Endpoints are gated independently,
    #    so an unresolved endpoint (component node / failed resolution) is skipped. Compatibility is
    #    checked only when BOTH endpoints resolved AND both named ports exist (no cascade on a
    #    missing port).
    output_ports = {
        nid: {p.name: p.port_type for p in desc.outputs} for nid, desc in resolved.items()
    }
    input_ports = {
        nid: {p.name: p.port_type for p in desc.inputs} for nid, desc in resolved.items()
    }
    for index, edge in enumerate(document.edges):
        src_id, src_port = edge.from_
        dst_id, dst_port = edge.to
        src_outputs = output_ports.get(src_id)
        dst_inputs = input_ports.get(dst_id)
        if src_outputs is not None and src_port not in src_outputs:
            diagnostics.append(
                SemanticDiagnostic(
                    UNKNOWN_OUTPUT_PORT,
                    f"node {src_id!r} has no output port {src_port!r}",
                    ("edges", index, "from"),
                    src_port,
                )
            )
        if dst_inputs is not None and dst_port not in dst_inputs:
            diagnostics.append(
                SemanticDiagnostic(
                    UNKNOWN_INPUT_PORT,
                    f"node {dst_id!r} has no input port {dst_port!r}",
                    ("edges", index, "to"),
                    dst_port,
                )
            )
        if (
            src_outputs is not None
            and src_port in src_outputs
            and dst_inputs is not None
            and dst_port in dst_inputs
            and not is_compatible(src_outputs[src_port], dst_inputs[dst_port])
        ):
            source = src_outputs[src_port]
            destination = dst_inputs[dst_port]
            diagnostics.append(
                SemanticDiagnostic(
                    INCOMPATIBLE_PORT_TYPES,
                    f"port type {_render_type(source)} from {src_id!r}.{src_port!r} is not "
                    f"compatible with {_render_type(destination)} at {dst_id!r}.{dst_port!r}",
                    ("edges", index),
                    dst_port,
                )
            )

    # 3. Required-input connectivity. Any edge targeting (node, port) counts — even if its source
    #    failed resolution or is a component node (no cascade; M2.3 decides type-compatibility).
    connected_targets = {(edge.to[0], edge.to[1]) for edge in document.edges}
    for index, node in enumerate(document.nodes):
        descriptor = resolved.get(node.id)
        if descriptor is None:
            continue
        for port in descriptor.inputs:
            if port.required and (node.id, port.name) not in connected_targets:
                diagnostics.append(
                    SemanticDiagnostic(
                        REQUIRED_INPUT_UNCONNECTED,
                        f"required input {port.name!r} of node {node.id!r} is not connected",
                        ("nodes", index),
                        port.name,
                    )
                )

    return SemanticValidation(ok=not diagnostics, diagnostics=sort_diagnostics(diagnostics))
