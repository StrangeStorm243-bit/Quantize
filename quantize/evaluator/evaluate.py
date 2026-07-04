"""Single-instant strategy evaluation (M3).

``evaluate_strategy`` evaluates a strategy document at ONE evaluation instant over an
availability-gated ``DataView`` and returns a structured ``EvaluationOutcome``. The engine (M4)
will call this per scheduled instant; nothing here advances sessions, reconciles orders, fills,
or persists.

**Precondition & defensive pre-flight.** The caller should already have validated the document,
but the evaluator re-runs the M1/M2 validators (by *calling* them — no re-implementation) plus the
M3 checks they defer (component resolution; wiring of edges that touch component instances;
ambiguous fan-in; the terminal rule) and refuses to execute an invalid document, returning the
findings as runtime diagnostics with their original stable codes.

**Failure policy.** Pre-flight faults ACCUMULATE (all reported, deterministic order). Execution
faults STOP the run at the first failing node — every downstream value would be undefined — and
the outcome carries one diagnostic identifying the node plus whatever outputs completed.

**Determinism.** Node order is the deterministic topological plan; inputs are assembled in
descriptor port order; trace events are appended in evaluation order and stamped with the
evaluation instant (never wall-clock); no step depends on dict/set iteration order.

**Terminal.** The graph terminates in the single ``output.target_portfolio`` node; the outcome's
``targets`` is the ``PortfolioTargetsValue`` delivered to it. ``OrderList`` does not exist here —
reconciliation is engine-owned (M4, ADR-0005).
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime

from quantize.components.resolve import ComponentCatalog, ResolvedComponentInstance
from quantize.evaluator.errors import (
    IMPLEMENTATION_UNAVAILABLE,
    INVALID_TERMINAL_NODE,
    MISSING_RUNTIME_INPUT,
    NO_VISIBLE_SESSION,
    NODE_EXECUTION_FAILED,
    WRONG_OUTPUT_PORTS,
    WRONG_OUTPUT_TYPE,
)
from quantize.evaluator.plan import topological_order
from quantize.evaluator.preflight import run_document_preflight, terminal_nodes
from quantize.market.calendar import require_aware_utc
from quantize.market.data import DataView, MarketDataSet
from quantize.registry.registry import ResolutionStatus
from quantize.runtime.binding import EvaluationMemo, ImplementationCatalog, NodeInvocation
from quantize.runtime.diagnostics import RuntimeDiagnostic, sort_runtime_diagnostics
from quantize.runtime.values import (
    AssetSetValue,
    CrossSectionValue,
    PortfolioTargetsValue,
    RuntimeValue,
    ScalarValue,
    TimeSeriesValue,
)
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import ComponentRefNode, Edge, NodeInstance, RegisteredNode
from quantize.schema.primitives import JsonValue
from quantize.tracing.events import TraceEvent
from quantize.tracing.recorder import TraceRecorder

_RUNTIME_VALUE_TYPES = (
    ScalarValue,
    AssetSetValue,
    CrossSectionValue,
    TimeSeriesValue,
    PortfolioTargetsValue,
)

# (node_path, port_name) -> value. node_path = (*component_instance_ids, node_id).
ValueStore = dict[tuple[tuple[str, ...], str], RuntimeValue]


@dataclass(frozen=True)
class EvaluationOutcome:
    """The structured result of one single-instant evaluation."""

    ok: bool
    run_id: str
    evaluation_instant: datetime
    diagnostics: tuple[RuntimeDiagnostic, ...]
    targets: PortfolioTargetsValue | None
    outputs: Mapping[tuple[tuple[str, ...], str], RuntimeValue]
    trace: tuple[TraceEvent, ...]

    def output_value(self, node_path: Sequence[str], port: str) -> RuntimeValue:
        """The stored output at ``node_path`` (component ids + node id) and ``port``."""
        return self.outputs[(tuple(node_path), port)]


def _edge_sources(edges: Sequence[Edge]) -> dict[tuple[str, str], tuple[str, str]]:
    """(target node, input port) -> (source node, output port). Pre-flight rejects fan-in."""
    return {(edge.to[0], edge.to[1]): (edge.from_[0], edge.from_[1]) for edge in edges}


class _Executor:
    """One run's execution state: the value store, trace recorder, and abort-on-first-failure."""

    def __init__(
        self,
        catalog: ImplementationCatalog,
        view: DataView,
        recorder: TraceRecorder,
        memo: EvaluationMemo | None = None,
    ) -> None:
        self.catalog = catalog
        self.view = view
        self.recorder = recorder
        self.memo = memo
        self.store: ValueStore = {}

    def execute_graph(
        self,
        nodes: Sequence[NodeInstance],
        edges: Sequence[Edge],
        component_path: tuple[str, ...],
        params_by_node: Mapping[str, Mapping[str, JsonValue]],
        instances: Mapping[str, ResolvedComponentInstance],
        external_inputs: Mapping[tuple[str, str], RuntimeValue],
    ) -> RuntimeDiagnostic | None:
        by_id = {node.id: node for node in nodes}
        sources = _edge_sources(edges)

        for node_id in topological_order(nodes, edges):
            node = by_id[node_id]
            failure = (
                self._run_registered(node, component_path, sources, params_by_node, external_inputs)
                if isinstance(node, RegisteredNode)
                else self._run_component(node, component_path, sources, instances, external_inputs)
            )
            if failure is not None:
                return failure
        return None

    def _input_value(
        self,
        node_id: str,
        port_name: str,
        component_path: tuple[str, ...],
        sources: Mapping[tuple[str, str], tuple[str, str]],
        external_inputs: Mapping[tuple[str, str], RuntimeValue],
    ) -> RuntimeValue | None:
        key = (node_id, port_name)
        if key in sources:
            src_id, src_port = sources[key]
            return self.store.get(((*component_path, src_id), src_port))
        return external_inputs.get(key)

    def _run_registered(
        self,
        node: RegisteredNode,
        component_path: tuple[str, ...],
        sources: Mapping[tuple[str, str], tuple[str, str]],
        params_by_node: Mapping[str, Mapping[str, JsonValue]],
        external_inputs: Mapping[tuple[str, str], RuntimeValue],
    ) -> RuntimeDiagnostic | None:
        path = (*component_path, node.id)
        resolution = self.catalog.resolve(node.type_id, node.type_version)
        if resolution.status is not ResolutionStatus.OK or resolution.implementation is None:
            # Defensive: pre-flight semantic validation resolves against the catalog's own
            # descriptor registry, so this indicates a caller bypassed the pre-flight.
            return RuntimeDiagnostic(
                IMPLEMENTATION_UNAVAILABLE,
                f"no executable implementation for {node.type_id!r} {node.type_version!r}",
                node_path=path,
                subject=node.type_id,
            )
        implementation = resolution.implementation

        inputs: dict[str, RuntimeValue] = {}
        for port in implementation.descriptor.inputs:
            value = self._input_value(node.id, port.name, component_path, sources, external_inputs)
            if value is None:
                if port.required:
                    return RuntimeDiagnostic(
                        MISSING_RUNTIME_INPUT,
                        f"required input {port.name!r} of node {node.id!r} has no runtime value",
                        node_path=path,
                        subject=port.name,
                    )
                continue
            inputs[port.name] = value

        invocation = NodeInvocation(
            node_id=node.id,
            component_path=component_path,
            params=params_by_node.get(node.id, {}),
            inputs=inputs,
            view=self.view,
            trace=self.recorder.sink_for(node.id, component_path),
            memo=self.memo,
        )
        try:
            outputs = implementation.evaluate(invocation)
        except Exception as exc:  # a node bug is an expected *run* failure, reported structured
            return RuntimeDiagnostic(
                NODE_EXECUTION_FAILED,
                f"node {node.id!r} ({node.type_id}) failed: {type(exc).__name__}: {exc}",
                node_path=path,
                subject=node.type_id,
            )

        declared = {port.name: port.port_type for port in implementation.descriptor.outputs}
        if set(outputs) != set(declared):
            return RuntimeDiagnostic(
                WRONG_OUTPUT_PORTS,
                f"node {node.id!r} produced ports {sorted(outputs)!r}, "
                f"declared {sorted(declared)!r}",
                node_path=path,
                subject=node.type_id,
            )
        for name in sorted(declared):
            value = outputs[name]
            if not isinstance(value, _RUNTIME_VALUE_TYPES) or value.port_type != declared[name]:
                produced = (
                    type(value).__name__
                    if not isinstance(value, _RUNTIME_VALUE_TYPES)
                    else repr(value.port_type)
                )
                return RuntimeDiagnostic(
                    WRONG_OUTPUT_TYPE,
                    f"node {node.id!r} output {name!r} produced {produced}, "
                    f"declared {declared[name]!r}",
                    node_path=path,
                    subject=name,
                )
            self.store[(path, name)] = value
        return None

    def _run_component(
        self,
        node: ComponentRefNode,
        component_path: tuple[str, ...],
        sources: Mapping[tuple[str, str], tuple[str, str]],
        instances: Mapping[str, ResolvedComponentInstance],
        external_inputs: Mapping[tuple[str, str], RuntimeValue],
    ) -> RuntimeDiagnostic | None:
        path = (*component_path, node.id)
        resolved = instances[node.id]
        definition = resolved.definition
        graph = definition.implementation.graph

        nested_external: dict[tuple[str, str], RuntimeValue] = {}
        for exposed in definition.exposed_inputs:
            value = self._input_value(
                node.id, exposed.name, component_path, sources, external_inputs
            )
            if value is None:
                return RuntimeDiagnostic(
                    MISSING_RUNTIME_INPUT,
                    f"exposed input {exposed.name!r} of component node {node.id!r} has no "
                    "runtime value",
                    node_path=path,
                    subject=exposed.name,
                )
            nested_external[(exposed.maps_to[0], exposed.maps_to[1])] = value

        failure = self.execute_graph(
            graph.nodes,
            graph.edges,
            path,
            resolved.effective_params,
            resolved.children,
            nested_external,
        )
        if failure is not None:
            return failure

        for exposed in definition.exposed_outputs:
            target_node, target_port = exposed.maps_to
            value = self.store.get(((*path, target_node), target_port))
            if value is None:  # defensive: resolution verified the mapping statically
                return RuntimeDiagnostic(
                    MISSING_RUNTIME_INPUT,
                    f"exposed output {exposed.name!r} of component node {node.id!r} has no "
                    "runtime value",
                    node_path=path,
                    subject=exposed.name,
                )
            self.store[(path, exposed.name)] = value
        return None


def evaluate_strategy(
    document: StrategyDocument,
    *,
    catalog: ImplementationCatalog,
    market_data: MarketDataSet,
    run_id: str,
    evaluation_instant: datetime,
    components: ComponentCatalog | None = None,
    collect_trace: bool = True,
    memo: EvaluationMemo | None = None,
) -> EvaluationOutcome:
    """Evaluate *document* at *evaluation_instant* (see module docstring for the contract).

    ``memo`` is the run-scoped speed-only reuse channel (``EvaluationMemo``): pass the SAME
    memo across a run's ascending evaluation instants (the engine does); it never changes what
    an evaluation produces, and it rejects a strictly earlier instant loudly.
    """
    run_id = str(uuid.UUID(run_id))  # caller contract: a UUID; garbage is a programming error
    instant = require_aware_utc(evaluation_instant, "evaluation_instant")
    if memo is not None:
        memo.assert_monotonic(instant)

    diagnostics: list[RuntimeDiagnostic] = []

    # Document pre-flight is the single shared implementation (also the M9 validate endpoint).
    # It returns native per-layer shapes; here we down-convert to the uniform runtime stream
    # (the structural:/semantic: prefixes are the evaluator's presentation), then add the
    # DATA-dependent NO_VISIBLE_SESSION check below. ``resolution`` is reused for execution.
    preflight = run_document_preflight(
        document, registry=catalog.descriptor_registry, components=components
    )
    resolution = preflight.resolution
    for error in preflight.structural:
        diagnostics.append(
            RuntimeDiagnostic(error.code, f"structural: {error.message}", subject=error.subject)
        )
    for finding in preflight.semantic:
        diagnostics.append(
            RuntimeDiagnostic(finding.code, f"semantic: {finding.message}", subject=finding.subject)
        )
    diagnostics.extend(preflight.runtime)

    view = market_data.as_of(instant)
    if view.latest_session_date is None:
        diagnostics.append(
            RuntimeDiagnostic(
                NO_VISIBLE_SESSION,
                "no market session has closed at or before the evaluation instant",
            )
        )

    def outcome(
        ok: bool,
        targets: PortfolioTargetsValue | None,
        outputs: Mapping[tuple[tuple[str, ...], str], RuntimeValue],
        trace: tuple[TraceEvent, ...],
    ) -> EvaluationOutcome:
        return EvaluationOutcome(
            ok=ok,
            run_id=run_id,
            evaluation_instant=instant,
            diagnostics=sort_runtime_diagnostics(diagnostics),
            targets=targets,
            outputs=dict(outputs),
            trace=trace,
        )

    if diagnostics:
        return outcome(False, None, {}, ())

    recorder = TraceRecorder(run_id, instant, enabled=collect_trace)
    executor = _Executor(catalog, view, recorder, memo)
    params_by_node: dict[str, Mapping[str, JsonValue]] = {
        node.id: node.params for node in document.nodes
    }
    failure = executor.execute_graph(
        document.nodes, document.edges, (), params_by_node, resolution.instances, {}
    )
    if failure is not None:
        diagnostics.append(failure)
        return outcome(False, None, executor.store, recorder.events)

    # Terminal extraction: the value delivered to the single terminal's single input.
    terminal = terminal_nodes(document)[0]
    terminal_resolution = catalog.resolve(terminal.type_id, terminal.type_version)
    assert terminal_resolution.implementation is not None  # pre-flight resolved it
    terminal_inputs = terminal_resolution.implementation.descriptor.inputs
    sources = _edge_sources(document.edges)
    targets: PortfolioTargetsValue | None = None
    if len(terminal_inputs) == 1 and (terminal.id, terminal_inputs[0].name) in sources:
        src_id, src_port = sources[(terminal.id, terminal_inputs[0].name)]
        candidate = executor.store.get(((src_id,), src_port))
        if isinstance(candidate, PortfolioTargetsValue):
            targets = candidate
    if targets is None:
        diagnostics.append(
            RuntimeDiagnostic(
                INVALID_TERMINAL_NODE,
                f"terminal node {terminal.id!r} did not receive a PortfolioTargets value on a "
                "single input port",
                node_path=(terminal.id,),
                subject=terminal.id,
            )
        )
        return outcome(False, None, executor.store, recorder.events)

    return outcome(True, targets, executor.store, recorder.events)
