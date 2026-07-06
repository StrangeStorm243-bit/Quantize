"""Component resolution: fetch the pinned closure, validate it, and build the instance tree.

Resolution completes what M1 deliberately left bounded: M1 rejects recursion only over a
caller-supplied set; here the full closure is *fetched* from a ``ComponentCatalog`` and direct +
transitive recursion is rejected over the fetched definitions. Resolution also performs the
component-side semantic checks M2 deferred (internal-graph wiring, exposed port mappings and
types, parameter bindings), and instantiates each component node: exposed-parameter overrides are
applied to copies of internal node params — the persisted documents are never mutated.

Failure layering mirrors M1 -> M2: definition-level faults (missing/cyclic/invalid definitions,
bad mappings) are accumulated first; instance-level faults (unknown/invalid instance params,
invalid effective params) are only reported once every definition is sound. Evaluation requires
``ResolvedStrategy.ok``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from quantize.compatibility import is_compatible
from quantize.registry.registry import NodeRegistryView, ResolutionStatus
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.diagnostics import RuntimeDiagnostic, sort_runtime_diagnostics
from quantize.schema.components import ComponentDefinition, ComponentRef
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import ComponentRefNode, Edge, NodeInstance, RegisteredNode
from quantize.schema.primitives import JsonValue
from quantize.schema.types import PortType
from quantize.validation.errors import (
    INCOMPATIBLE_PORT_TYPES,
    INVALID_PARAMETERS,
    NODE_VERSION_UNAVAILABLE,
    REQUIRED_INPUT_UNCONNECTED,
    UNKNOWN_INPUT_PORT,
    UNKNOWN_NODE_TYPE,
    UNKNOWN_OUTPUT_PORT,
    ComponentKey,
)
from quantize.validation.structural import validate_component_definition, validate_component_set

# --- Stable runtime-diagnostic codes owned by component resolution ----------------------------
COMPONENT_DEFINITION_UNAVAILABLE = "component_definition_unavailable"
COMPONENT_DEFINITION_INVALID = "component_definition_invalid"
DUPLICATE_EXPOSED_PORT = "duplicate_exposed_port"
DUPLICATE_EXPOSED_PARAM = "duplicate_exposed_param"
EXPOSED_PORT_TARGET_MISSING = "exposed_port_target_missing"
EXPOSED_PORT_TYPE_INCOMPATIBLE = "exposed_port_type_incompatible"
EXPOSED_PARAM_TARGET_MISSING = "exposed_param_target_missing"
EXPOSED_PARAM_SCHEMA_INVALID = "exposed_param_schema_invalid"
UNKNOWN_COMPONENT_PARAM = "unknown_component_param"
INVALID_COMPONENT_PARAM = "invalid_component_param"
AMBIGUOUS_INPUT = "ambiguous_input"


class ComponentCatalog:
    """An immutable set of fetched component definitions keyed by pinned identity."""

    def __init__(self, definitions: Iterable[ComponentDefinition] = ()) -> None:
        self._by_key: dict[ComponentKey, ComponentDefinition] = {}
        for definition in definitions:
            key = ComponentKey(definition.component_id, definition.version)
            if key in self._by_key:
                raise ValueError(f"component {key} supplied more than once")
            self._by_key[key] = definition

    def get(self, key: ComponentKey) -> ComponentDefinition | None:
        return self._by_key.get(key)


@dataclass(frozen=True)
class ResolvedComponentInstance:
    """One component-instance node, fully resolved: its definition, effective internal params
    (authored params with exposed-parameter overrides applied), and nested instances."""

    instance_id: str
    path: tuple[str, ...]
    definition: ComponentDefinition
    effective_params: Mapping[str, Mapping[str, JsonValue]]
    children: Mapping[str, ResolvedComponentInstance]


@dataclass(frozen=True)
class ResolvedStrategy:
    """The outcome of resolving a strategy's components. Evaluation requires ``ok``."""

    ok: bool
    diagnostics: tuple[RuntimeDiagnostic, ...]
    instances: Mapping[str, ResolvedComponentInstance]


@dataclass(frozen=True)
class PortTables:
    """Per-node port-name -> type lookups for one graph (registered + component nodes)."""

    outputs: Mapping[str, Mapping[str, PortType]]
    inputs: Mapping[str, Mapping[str, PortType]]


def _definition_key(definition: ComponentDefinition) -> ComponentKey:
    return ComponentKey(definition.component_id, definition.version)


def _ref_key_for(node: ComponentRefNode, owner_refs: Sequence[ComponentRef]) -> ComponentKey:
    """The pinned identity a component node points at (structural validation guarantees the
    ref id exists in the owner's ``component_refs``)."""
    for ref in owner_refs:
        if ref.id == node.ref:
            return ComponentKey(ref.component_id, ref.version)
    raise ValueError(f"component node {node.id!r} has undeclared ref {node.ref!r}")


def build_port_tables(
    nodes: Sequence[NodeInstance],
    registry: NodeRegistryView,
    definitions_for: Mapping[str, ComponentDefinition],
) -> PortTables:
    """Port tables for a graph. ``definitions_for`` maps component-node id -> its definition;
    nodes that resolve nowhere (unknown type / missing definition) are simply absent — their
    faults are diagnosed separately and wiring checks skip them (no cascade)."""
    outputs: dict[str, dict[str, PortType]] = {}
    inputs: dict[str, dict[str, PortType]] = {}
    for node in nodes:
        if isinstance(node, RegisteredNode):
            resolution = registry.resolve(node.type_id, node.type_version)
            if resolution.status is ResolutionStatus.OK and resolution.descriptor is not None:
                descriptor = resolution.descriptor
                outputs[node.id] = {p.name: p.port_type for p in descriptor.outputs}
                inputs[node.id] = {p.name: p.port_type for p in descriptor.inputs}
        else:
            definition = definitions_for.get(node.id)
            if definition is not None:
                outputs[node.id] = {p.name: p.type for p in definition.exposed_outputs}
                inputs[node.id] = {p.name: p.type for p in definition.exposed_inputs}
    return PortTables(outputs=outputs, inputs=inputs)


def duplicate_input_edges(edges: Sequence[Edge]) -> tuple[tuple[str, str], ...]:
    """Input ports targeted by more than one edge (ambiguous fan-in), deterministically ordered."""
    seen: set[tuple[str, str]] = set()
    duplicated: set[tuple[str, str]] = set()
    for edge in edges:
        target = (edge.to[0], edge.to[1])
        if target in seen:
            duplicated.add(target)
        seen.add(target)
    return tuple(sorted(duplicated))


def _check_graph_wiring(
    nodes: Sequence[NodeInstance],
    edges: Sequence[Edge],
    tables: PortTables,
    externally_fed: frozenset[tuple[str, str]],
    context: str,
) -> list[RuntimeDiagnostic]:
    """Wiring checks for one internal component graph: port existence on both endpoint kinds,
    compatibility via the single ``is_compatible``, ambiguous fan-in, and required connectivity
    (an internal input may be fed by an internal edge or an exposed-input mapping)."""
    diagnostics: list[RuntimeDiagnostic] = []

    for node_id, port in duplicate_input_edges(edges):
        diagnostics.append(
            RuntimeDiagnostic(
                AMBIGUOUS_INPUT,
                f"{context}: input {port!r} of node {node_id!r} has more than one incoming edge",
                subject=node_id,
            )
        )

    connected: set[tuple[str, str]] = set(externally_fed)
    for edge in edges:
        src_id, src_port = edge.from_
        dst_id, dst_port = edge.to
        connected.add((dst_id, dst_port))
        src_outputs = tables.outputs.get(src_id)
        dst_inputs = tables.inputs.get(dst_id)
        if src_outputs is not None and src_port not in src_outputs:
            diagnostics.append(
                RuntimeDiagnostic(
                    UNKNOWN_OUTPUT_PORT,
                    f"{context}: node {src_id!r} has no output port {src_port!r}",
                    subject=src_port,
                )
            )
        if dst_inputs is not None and dst_port not in dst_inputs:
            diagnostics.append(
                RuntimeDiagnostic(
                    UNKNOWN_INPUT_PORT,
                    f"{context}: node {dst_id!r} has no input port {dst_port!r}",
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
                    f"{context}: edge {src_id!r}.{src_port!r} -> {dst_id!r}.{dst_port!r} "
                    "connects incompatible port types",
                    subject=dst_port,
                )
            )

    for node in nodes:
        node_inputs = tables.inputs.get(node.id)
        if node_inputs is None:
            continue
        if isinstance(node, RegisteredNode):
            # required flags live on the descriptor; the table has names/types only
            continue
        for port_name in node_inputs:
            # v0: every exposed input of a component instance is required.
            if (node.id, port_name) not in connected:
                diagnostics.append(
                    RuntimeDiagnostic(
                        REQUIRED_INPUT_UNCONNECTED,
                        f"{context}: exposed input {port_name!r} of component node {node.id!r} "
                        "is not connected",
                        subject=port_name,
                    )
                )
    return diagnostics


def _check_required_registered_inputs(
    nodes: Sequence[NodeInstance],
    edges: Sequence[Edge],
    registry: NodeRegistryView,
    externally_fed: frozenset[tuple[str, str]],
    context: str,
) -> list[RuntimeDiagnostic]:
    """Required-input connectivity for registered nodes inside a component graph (the M2
    validator covers only top-level strategy nodes)."""
    diagnostics: list[RuntimeDiagnostic] = []
    connected = {(edge.to[0], edge.to[1]) for edge in edges} | set(externally_fed)
    for node in nodes:
        if not isinstance(node, RegisteredNode):
            continue
        resolution = registry.resolve(node.type_id, node.type_version)
        if resolution.status is not ResolutionStatus.OK or resolution.descriptor is None:
            continue
        for port in resolution.descriptor.inputs:
            if port.required and (node.id, port.name) not in connected:
                diagnostics.append(
                    RuntimeDiagnostic(
                        REQUIRED_INPUT_UNCONNECTED,
                        f"{context}: required input {port.name!r} of node {node.id!r} "
                        "is not connected",
                        subject=port.name,
                    )
                )
    return diagnostics


def _check_definition(
    definition: ComponentDefinition,
    registry: NodeRegistryView,
    fetched: Mapping[ComponentKey, ComponentDefinition],
) -> list[RuntimeDiagnostic]:
    """Definition-level semantic checks (independent of any particular instantiation)."""
    key = _definition_key(definition)
    context = f"component {key}"
    diagnostics: list[RuntimeDiagnostic] = []
    graph = definition.implementation.graph

    # Internal registered nodes must resolve (M2's rule applied to the internal graph).
    for node in graph.nodes:
        if not isinstance(node, RegisteredNode):
            continue
        resolution = registry.resolve(node.type_id, node.type_version)
        if resolution.status is ResolutionStatus.UNKNOWN_TYPE:
            diagnostics.append(
                RuntimeDiagnostic(
                    UNKNOWN_NODE_TYPE,
                    f"{context}: internal node {node.id!r} has unregistered type {node.type_id!r}",
                    subject=node.type_id,
                )
            )
        elif resolution.status is ResolutionStatus.VERSION_UNAVAILABLE:
            diagnostics.append(
                RuntimeDiagnostic(
                    NODE_VERSION_UNAVAILABLE,
                    f"{context}: internal node {node.id!r} pins unavailable version "
                    f"{node.type_version!r} of {node.type_id!r}",
                    subject=node.type_id,
                )
            )

    # Nested definitions this graph's component nodes point at (absent ones already diagnosed).
    definitions_for: dict[str, ComponentDefinition] = {}
    for node in graph.nodes:
        if isinstance(node, ComponentRefNode):
            nested_key = _ref_key_for(node, definition.component_refs)
            nested = fetched.get(nested_key)
            if nested is not None:
                definitions_for[node.id] = nested

    tables = build_port_tables(graph.nodes, registry, definitions_for)

    # Duplicate exposed names.
    for label, code, names in (
        ("exposed input", DUPLICATE_EXPOSED_PORT, [p.name for p in definition.exposed_inputs]),
        ("exposed output", DUPLICATE_EXPOSED_PORT, [p.name for p in definition.exposed_outputs]),
        ("exposed param", DUPLICATE_EXPOSED_PARAM, [p.name for p in definition.exposed_params]),
    ):
        seen: set[str] = set()
        for name in names:
            if name in seen:
                diagnostics.append(
                    RuntimeDiagnostic(code, f"{context}: duplicate {label} {name!r}", subject=name)
                )
            seen.add(name)

    # Exposed input mappings: target must be an existing internal INPUT port of compatible type,
    # and must not collide with another feed of the same internal port.
    fed_by_exposure: set[tuple[str, str]] = set()
    edge_targets = {(edge.to[0], edge.to[1]) for edge in graph.edges}
    for exposed in definition.exposed_inputs:
        target_node, target_port = exposed.maps_to
        node_inputs = tables.inputs.get(target_node)
        if node_inputs is None or target_port not in node_inputs:
            diagnostics.append(
                RuntimeDiagnostic(
                    EXPOSED_PORT_TARGET_MISSING,
                    f"{context}: exposed input {exposed.name!r} maps to unknown internal "
                    f"input {target_node!r}.{target_port!r}",
                    subject=exposed.name,
                )
            )
            continue
        if not is_compatible(exposed.type, node_inputs[target_port]):
            diagnostics.append(
                RuntimeDiagnostic(
                    EXPOSED_PORT_TYPE_INCOMPATIBLE,
                    f"{context}: exposed input {exposed.name!r} is not type-compatible with "
                    f"internal input {target_node!r}.{target_port!r}",
                    subject=exposed.name,
                )
            )
        target = (target_node, target_port)
        if target in fed_by_exposure or target in edge_targets:
            diagnostics.append(
                RuntimeDiagnostic(
                    AMBIGUOUS_INPUT,
                    f"{context}: internal input {target_node!r}.{target_port!r} is fed by "
                    "more than one exposed input or internal edge",
                    subject=exposed.name,
                )
            )
        fed_by_exposure.add(target)

    # Exposed output mappings: target must be an existing internal OUTPUT port, compatible.
    for exposed in definition.exposed_outputs:
        target_node, target_port = exposed.maps_to
        node_outputs = tables.outputs.get(target_node)
        if node_outputs is None or target_port not in node_outputs:
            diagnostics.append(
                RuntimeDiagnostic(
                    EXPOSED_PORT_TARGET_MISSING,
                    f"{context}: exposed output {exposed.name!r} maps to unknown internal "
                    f"output {target_node!r}.{target_port!r}",
                    subject=exposed.name,
                )
            )
            continue
        if not is_compatible(node_outputs[target_port], exposed.type):
            diagnostics.append(
                RuntimeDiagnostic(
                    EXPOSED_PORT_TYPE_INCOMPATIBLE,
                    f"{context}: exposed output {exposed.name!r} is not type-compatible with "
                    f"internal output {target_node!r}.{target_port!r}",
                    subject=exposed.name,
                )
            )

    # Exposed params: binding target must exist; the declared schema must itself be valid.
    internal_ids = {node.id for node in graph.nodes}
    nested_exposed_params = {
        node_id: {p.name for p in nested.exposed_params}
        for node_id, nested in definitions_for.items()
    }
    for param in definition.exposed_params:
        target_node, target_param = param.binds_to
        if target_node not in internal_ids:
            diagnostics.append(
                RuntimeDiagnostic(
                    EXPOSED_PARAM_TARGET_MISSING,
                    f"{context}: exposed param {param.name!r} binds to unknown internal node "
                    f"{target_node!r}",
                    subject=param.name,
                )
            )
            continue
        if target_node in nested_exposed_params and (
            target_param not in nested_exposed_params[target_node]
        ):
            diagnostics.append(
                RuntimeDiagnostic(
                    EXPOSED_PARAM_TARGET_MISSING,
                    f"{context}: exposed param {param.name!r} binds to {target_node!r}."
                    f"{target_param!r}, which is not an exposed param of that component",
                    subject=param.name,
                )
            )
        try:
            JsonSchemaSpec(param.schema_)
        except Exception:  # jsonschema SchemaError or portability ValueError — invalid either way
            diagnostics.append(
                RuntimeDiagnostic(
                    EXPOSED_PARAM_SCHEMA_INVALID,
                    f"{context}: exposed param {param.name!r} declares an invalid JSON Schema",
                    subject=param.name,
                )
            )

    # Wiring of the internal graph (edges + connectivity), with exposed mappings counted as feeds.
    externally_fed = frozenset(
        (exposed.maps_to[0], exposed.maps_to[1]) for exposed in definition.exposed_inputs
    )
    diagnostics += _check_graph_wiring(graph.nodes, graph.edges, tables, externally_fed, context)
    diagnostics += _check_required_registered_inputs(
        graph.nodes, graph.edges, registry, externally_fed, context
    )
    return diagnostics


def _validate_effective_params(
    definition: ComponentDefinition,
    effective: Mapping[str, Mapping[str, JsonValue]],
    registry: NodeRegistryView,
    path: tuple[str, ...],
) -> list[RuntimeDiagnostic]:
    """Effective (post-binding) params of internal registered nodes must satisfy their
    descriptors' parameter schemas — checked per instantiation, since bindings differ."""
    diagnostics: list[RuntimeDiagnostic] = []
    for node in definition.implementation.graph.nodes:
        if not isinstance(node, RegisteredNode):
            continue
        resolution = registry.resolve(node.type_id, node.type_version)
        if resolution.status is not ResolutionStatus.OK or resolution.descriptor is None:
            continue
        schema = resolution.descriptor.parameter_schema
        if schema is None:
            continue
        for issue in schema.errors(dict(effective[node.id])):
            diagnostics.append(
                RuntimeDiagnostic(
                    INVALID_PARAMETERS,
                    f"effective params of internal node {node.id!r}: "
                    f"{issue.json_path}: {issue.message}",
                    node_path=(*path, node.id),
                    subject=node.id,
                )
            )
    return diagnostics


def _instantiate(
    instance_id: str,
    provided_params: Mapping[str, JsonValue],
    definition: ComponentDefinition,
    path: tuple[str, ...],
    fetched: Mapping[ComponentKey, ComponentDefinition],
    registry: NodeRegistryView,
    diagnostics: list[RuntimeDiagnostic],
) -> ResolvedComponentInstance:
    """Build one resolved instance: apply exposed-param overrides to copies of internal params,
    validate them, and recurse into nested component nodes."""
    exposed_by_name = {param.name: param for param in definition.exposed_params}

    for name in sorted(provided_params):
        if name not in exposed_by_name:
            diagnostics.append(
                RuntimeDiagnostic(
                    UNKNOWN_COMPONENT_PARAM,
                    f"param {name!r} is not an exposed param of component "
                    f"{_definition_key(definition)}",
                    node_path=path,
                    subject=name,
                )
            )

    # Effective params: authored internal params, then exposed overrides (copies throughout).
    graph = definition.implementation.graph
    effective: dict[str, dict[str, JsonValue]] = {
        node.id: dict(node.params) for node in graph.nodes
    }
    for name in sorted(provided_params):
        param = exposed_by_name.get(name)
        if param is None:
            continue
        value = provided_params[name]
        try:
            spec = JsonSchemaSpec(param.schema_)
        except Exception:
            spec = None  # invalid schema already diagnosed at the definition level
        if spec is not None and spec.errors(value):
            diagnostics.append(
                RuntimeDiagnostic(
                    INVALID_COMPONENT_PARAM,
                    f"param {name!r} does not satisfy the exposed param schema of component "
                    f"{_definition_key(definition)}",
                    node_path=path,
                    subject=name,
                )
            )
            continue
        target_node, target_param = param.binds_to
        if target_node in effective:
            effective[target_node][target_param] = value

    diagnostics += _validate_effective_params(definition, effective, registry, path)

    children: dict[str, ResolvedComponentInstance] = {}
    for node in graph.nodes:
        if not isinstance(node, ComponentRefNode):
            continue
        nested_key = _ref_key_for(node, definition.component_refs)
        nested = fetched.get(nested_key)
        if nested is None:
            continue  # missing definition already diagnosed; resolution will not be ok
        children[node.id] = _instantiate(
            instance_id=node.id,
            provided_params=effective[node.id],
            definition=nested,
            path=(*path, node.id),
            fetched=fetched,
            registry=registry,
            diagnostics=diagnostics,
        )

    return ResolvedComponentInstance(
        instance_id=instance_id,
        path=path,
        definition=definition,
        effective_params={node_id: dict(params) for node_id, params in effective.items()},
        children=children,
    )


def resolve_strategy_components(
    document: StrategyDocument,
    catalog: ComponentCatalog,
    registry: NodeRegistryView,
) -> ResolvedStrategy:
    """Resolve every pinned component reference of *document* (transitively) and instantiate the
    strategy's component nodes. See the module docstring for the failure layering."""
    diagnostics: list[RuntimeDiagnostic] = []

    # Fetch the full pinned closure, breadth-first over declared refs (used or not — the set of
    # pinned versions a strategy resolves is deterministic and complete).
    fetched: dict[ComponentKey, ComponentDefinition] = {}
    missing: set[ComponentKey] = set()
    queue: list[ComponentKey] = sorted(
        ComponentKey(ref.component_id, ref.version) for ref in document.component_refs
    )
    while queue:
        key = queue.pop(0)
        if key in fetched or key in missing:
            continue
        definition = catalog.get(key)
        if definition is None:
            missing.add(key)
            diagnostics.append(
                RuntimeDiagnostic(
                    COMPONENT_DEFINITION_UNAVAILABLE,
                    f"component definition {key} is not available",
                    subject=str(key),
                )
            )
            continue
        fetched[key] = definition
        queue.extend(
            sorted(ComponentKey(ref.component_id, ref.version) for ref in definition.component_refs)
        )

    ordered_definitions = [fetched[key] for key in sorted(fetched)]

    # Recursion rejection over the fetched closure (completes M1's bounded supplied-set check).
    set_validation = validate_component_set(ordered_definitions)
    for error in set_validation.errors:
        diagnostics.append(RuntimeDiagnostic(error.code, error.message, subject=error.subject))

    # Each fetched definition must be structurally valid (defensive: caller-supplied documents).
    for definition in ordered_definitions:
        structural = validate_component_definition(definition)
        for error in structural.errors:
            diagnostics.append(
                RuntimeDiagnostic(
                    COMPONENT_DEFINITION_INVALID,
                    f"component {_definition_key(definition)}: {error.code}: {error.message}",
                    subject=str(_definition_key(definition)),
                )
            )

    if not diagnostics:
        for definition in ordered_definitions:
            diagnostics += _check_definition(definition, registry, fetched)

    # Instantiate only over a sound closure — instance-level faults layer after definition-level
    # ones (like M1 -> M2), and instantiation must not recurse into a cyclic or missing closure.
    instances: dict[str, ResolvedComponentInstance] = {}
    if not diagnostics:
        for node in document.nodes:
            if not isinstance(node, ComponentRefNode):
                continue
            key = _ref_key_for(node, document.component_refs)
            definition = fetched[key]
            instances[node.id] = _instantiate(
                instance_id=node.id,
                provided_params=node.params,
                definition=definition,
                path=(node.id,),
                fetched=fetched,
                registry=registry,
                diagnostics=diagnostics,
            )

    ordered = sort_runtime_diagnostics(diagnostics)
    return ResolvedStrategy(ok=not ordered, diagnostics=ordered, instances=instances)


def diagnose_component_definition(
    definition: ComponentDefinition,
    catalog: ComponentCatalog,
    registry: NodeRegistryView,
) -> list[RuntimeDiagnostic]:
    """Validate a SINGLE component definition exactly as ``resolve_strategy_components`` validates
    each fetched definition — but seeded from the definition itself rather than a strategy.

    Fetches the definition's own transitive nested closure from *catalog* (breadth-first over its
    ``component_refs``; an absent nested pin is diagnosed ``component_definition_unavailable``),
    then over ``[definition] + closure`` runs the same three definition-level gates resolution
    runs: recursion rejection (``validate_component_set``), structural validity per definition
    (``COMPONENT_DEFINITION_INVALID``), and — only if still clean — the registry-semantic check
    (``_check_definition``: internal node types, exposed-port mappings/types, param bindings).

    Returns the sorted diagnostics; an EMPTY list means the definition is safe to persist. This is
    the save-boundary counterpart to resolution's run-time check, so an invalid definition fails
    loud BEFORE it can reach the immutable store (never a best-effort save of a broken component).
    """
    diagnostics: list[RuntimeDiagnostic] = []

    # Seed the closure with the definition itself under its own key so a self- or transitive
    # reference resolves to it (mirroring resolution, where the definition is part of the fetched
    # closure) rather than being mis-reported as "unavailable".
    own_key = _definition_key(definition)
    fetched: dict[ComponentKey, ComponentDefinition] = {own_key: definition}
    missing: set[ComponentKey] = set()
    queue: list[ComponentKey] = sorted(
        ComponentKey(ref.component_id, ref.version) for ref in definition.component_refs
    )
    while queue:
        key = queue.pop(0)
        if key in fetched or key in missing:
            continue
        nested = catalog.get(key)
        if nested is None:
            missing.add(key)
            diagnostics.append(
                RuntimeDiagnostic(
                    COMPONENT_DEFINITION_UNAVAILABLE,
                    f"component definition {key} is not available",
                    subject=str(key),
                )
            )
            continue
        fetched[key] = nested
        queue.extend(
            sorted(ComponentKey(ref.component_id, ref.version) for ref in nested.component_refs)
        )

    # The definition under scrutiny first, then the rest of the closure (deterministic order).
    ordered_definitions = [definition] + [fetched[key] for key in sorted(fetched) if key != own_key]

    # Recursion rejection over the closure (direct + transitive).
    set_validation = validate_component_set(ordered_definitions)
    for error in set_validation.errors:
        diagnostics.append(RuntimeDiagnostic(error.code, error.message, subject=error.subject))

    # Each definition must be structurally valid.
    for candidate in ordered_definitions:
        structural = validate_component_definition(candidate)
        for error in structural.errors:
            diagnostics.append(
                RuntimeDiagnostic(
                    COMPONENT_DEFINITION_INVALID,
                    f"component {_definition_key(candidate)}: {error.code}: {error.message}",
                    subject=str(_definition_key(candidate)),
                )
            )

    # Registry-semantic checks only once every definition is structurally sound (layered like the
    # strategy path so instance-level noise never precedes a definition-level fault).
    if not diagnostics:
        for candidate in ordered_definitions:
            diagnostics += _check_definition(candidate, registry, fetched)

    return list(sort_runtime_diagnostics(diagnostics))
