"""Document-layer pre-flight validation — the single implementation shared by the evaluator (M3)
and the M9 API validate endpoint.

``run_document_preflight`` runs, in order, the five document checks the evaluator performs before
executing a strategy:

1. **structural** (M1.2) — registry-free cross-element well-formedness;
2. **semantic** (M2) — node-type/version resolution and port wiring by name (gated on structural);
3. **component resolution** (M3) — component instances resolve (gated on structural);
4. **top-level component wiring** — edges touching component instances, exposed-input connectivity,
   ambiguous fan-in (gated on semantic AND resolution being clean);
5. **the terminal rule** — exactly one ``output.target_portfolio`` node (same gate).

It returns the **native** per-layer shapes (``StructuralError`` / ``SemanticDiagnostic`` carry the
document ``loc``; the runtime layer carries ``RuntimeDiagnostic`` located by execution identity),
plus the ``ResolvedStrategy`` the evaluator reuses to execute. The evaluator down-converts these to
its uniform ``RuntimeDiagnostic`` stream at its own call site; the M9 API presents them per layer.

The DATA-dependent ``NO_VISIBLE_SESSION`` check is **not** here: it needs the market data + the
evaluation instant, not just the document, and stays inline in the evaluator.
"""

from __future__ import annotations

from dataclasses import dataclass

from quantize.compatibility import is_compatible
from quantize.components.resolve import (
    AMBIGUOUS_INPUT,
    ComponentCatalog,
    ResolvedStrategy,
    build_port_tables,
    duplicate_input_edges,
    resolve_strategy_components,
)
from quantize.evaluator.errors import MISSING_TERMINAL_NODE, MULTIPLE_TERMINAL_NODES
from quantize.registry.registry import NodeRegistryView
from quantize.runtime.diagnostics import RuntimeDiagnostic, sort_runtime_diagnostics
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import RegisteredNode
from quantize.validation.errors import (
    INCOMPATIBLE_PORT_TYPES,
    REQUIRED_INPUT_UNCONNECTED,
    UNKNOWN_INPUT_PORT,
    UNKNOWN_OUTPUT_PORT,
    SemanticDiagnostic,
    StructuralError,
)
from quantize.validation.semantic import validate_strategy_semantics
from quantize.validation.structural import validate_strategy_document

# The one graph terminal (STRATEGY_LANGUAGE.md §3). A constant, not a dispatch switch: execution
# still resolves every node through the catalog.
TERMINAL_TYPE_ID = "output.target_portfolio"


@dataclass(frozen=True)
class PreflightResult:
    """The native, per-layer outcome of ``run_document_preflight``.

    ``structural``/``semantic`` are validator-native (they carry ``loc``); ``runtime`` is the
    sorted resolution + wiring + terminal ``RuntimeDiagnostic``s. ``resolution`` is reused by the
    evaluator to execute (``.instances`` / ``.ok``). Later layers are gated on earlier ones, so a
    downstream tuple is ``()`` when an upstream layer failed.
    """

    structural: tuple[StructuralError, ...]
    semantic: tuple[SemanticDiagnostic, ...]
    runtime: tuple[RuntimeDiagnostic, ...]
    resolution: ResolvedStrategy
    structural_ok: bool
    semantic_ok: bool
    resolution_ok: bool

    @property
    def ok(self) -> bool:
        """No document-layer fault at any layer (the data-dependent NO_VISIBLE_SESSION is not
        a pre-flight concern; the evaluator adds it separately)."""
        return not (self.structural or self.semantic or self.runtime)


def terminal_nodes(document: StrategyDocument) -> list[RegisteredNode]:
    return [
        node
        for node in document.nodes
        if isinstance(node, RegisteredNode) and node.type_id == TERMINAL_TYPE_ID
    ]


def toplevel_component_wiring(
    document: StrategyDocument,
    registry: NodeRegistryView,
    resolution: ResolvedStrategy,
) -> list[RuntimeDiagnostic]:
    """The top-level checks M2 explicitly defers: edges touching component instances (exposed
    port existence + compatibility), exposed-input connectivity, and ambiguous fan-in."""
    diagnostics: list[RuntimeDiagnostic] = []

    for node_id, port in duplicate_input_edges(document.edges):
        diagnostics.append(
            RuntimeDiagnostic(
                AMBIGUOUS_INPUT,
                f"input {port!r} of node {node_id!r} has more than one incoming edge",
                node_path=(node_id,),
                subject=port,
            )
        )

    definitions_for = {
        node_id: instance.definition for node_id, instance in resolution.instances.items()
    }
    tables = build_port_tables(document.nodes, registry, definitions_for)
    component_ids = set(definitions_for)

    for edge in document.edges:
        src_id, src_port = edge.from_
        dst_id, dst_port = edge.to
        if src_id not in component_ids and dst_id not in component_ids:
            continue  # both endpoints registered: fully covered by M2 semantic validation
        src_outputs = tables.outputs.get(src_id)
        dst_inputs = tables.inputs.get(dst_id)
        if src_id in component_ids and src_outputs is not None and src_port not in src_outputs:
            diagnostics.append(
                RuntimeDiagnostic(
                    UNKNOWN_OUTPUT_PORT,
                    f"component node {src_id!r} exposes no output {src_port!r}",
                    node_path=(src_id,),
                    subject=src_port,
                )
            )
        if dst_id in component_ids and dst_inputs is not None and dst_port not in dst_inputs:
            diagnostics.append(
                RuntimeDiagnostic(
                    UNKNOWN_INPUT_PORT,
                    f"component node {dst_id!r} exposes no input {dst_port!r}",
                    node_path=(dst_id,),
                    subject=dst_port,
                )
            )
        if (
            src_outputs is not None
            and src_port in src_outputs
            and dst_inputs is not None
            and dst_port in dst_inputs
            and not is_compatible(src_outputs[src_port], dst_inputs[dst_port])
        ):
            diagnostics.append(
                RuntimeDiagnostic(
                    INCOMPATIBLE_PORT_TYPES,
                    f"edge {src_id!r}.{src_port!r} -> {dst_id!r}.{dst_port!r} connects "
                    "incompatible port types",
                    node_path=(dst_id,),
                    subject=dst_port,
                )
            )

    connected = {(edge.to[0], edge.to[1]) for edge in document.edges}
    for node_id in sorted(component_ids):
        for exposed in definitions_for[node_id].exposed_inputs:
            if (node_id, exposed.name) not in connected:
                diagnostics.append(
                    RuntimeDiagnostic(
                        REQUIRED_INPUT_UNCONNECTED,
                        f"exposed input {exposed.name!r} of component node {node_id!r} "
                        "is not connected",
                        node_path=(node_id,),
                        subject=exposed.name,
                    )
                )
    return diagnostics


def run_document_preflight(
    document: StrategyDocument,
    *,
    registry: NodeRegistryView,
    components: ComponentCatalog | None = None,
) -> PreflightResult:
    """Run the five document-layer checks and return their native per-layer diagnostics.

    Later layers are gated exactly as the evaluator gated them: semantic/resolution on
    ``structural_ok``; wiring and the terminal rule on ``semantic_ok AND resolution_ok``. The
    runtime tuple (resolution + wiring + terminal) is returned in the evaluator's deterministic
    ordering; the evaluator re-sorts it together with its down-converted structural/semantic
    diagnostics, so this ordering never changes the evaluator's output.
    """
    structural_result = validate_strategy_document(document)
    structural = structural_result.errors
    structural_ok = structural_result.ok

    semantic: tuple[SemanticDiagnostic, ...] = ()
    semantic_ok = False
    resolution = ResolvedStrategy(ok=True, diagnostics=(), instances={})
    resolution_ok = False
    runtime: list[RuntimeDiagnostic] = []

    if structural_ok:
        semantic_result = validate_strategy_semantics(document, registry)
        semantic = semantic_result.diagnostics
        semantic_ok = semantic_result.ok
        resolution = resolve_strategy_components(
            document, components or ComponentCatalog(), registry
        )
        resolution_ok = resolution.ok
        runtime.extend(resolution.diagnostics)

        if semantic_ok and resolution_ok:
            runtime.extend(toplevel_component_wiring(document, registry, resolution))
            terminals = terminal_nodes(document)
            if not terminals:
                runtime.append(
                    RuntimeDiagnostic(
                        MISSING_TERMINAL_NODE,
                        f"the graph must terminate in one {TERMINAL_TYPE_ID!r} node",
                        subject=TERMINAL_TYPE_ID,
                    )
                )
            elif len(terminals) > 1:
                runtime.append(
                    RuntimeDiagnostic(
                        MULTIPLE_TERMINAL_NODES,
                        f"the graph declares {len(terminals)} {TERMINAL_TYPE_ID!r} nodes; "
                        "exactly one is required",
                        subject=TERMINAL_TYPE_ID,
                    )
                )

    return PreflightResult(
        structural=structural,
        semantic=semantic,
        runtime=sort_runtime_diagnostics(runtime),
        resolution=resolution,
        structural_ok=structural_ok,
        semantic_ok=semantic_ok,
        resolution_ok=resolution_ok,
    )
