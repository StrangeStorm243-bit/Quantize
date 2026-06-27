"""M1.2 structural validation — graph, component-reference, and component-set checks.

**Structural-only.** No node registry, catalog, descriptor, store, or resolver is consulted; those
are M2/M3. This layer accepts already-parsed M1.1 models (which guarantee required fields, value
types, ``extra="forbid"``, and portable JSON) and adds the *cross-element* invariants Pydantic
cannot express: id uniqueness, edge-endpoint existence, acyclicity, local component-ref resolution,
and (over a supplied set) component-dependency acyclicity. See ``M1_IMPLEMENTATION_PLAN.md`` §4–§5.

In particular this layer **does not** check that a node ``type_id`` exists, that a ``type_version``
is available, that port names exist or are connected, port-type compatibility, parameters, or any
runtime/portfolio behavior. A structurally valid document may reference an unknown future
``type_id`` (the extensibility seam); M2 rejects unresolved types.

The functions are pure: they never mutate their inputs. Graph algorithms (cycle finding) are kept
separate from error presentation.
"""

from __future__ import annotations

from collections.abc import Hashable, Iterable, Iterator, Sequence

from quantize.schema.components import ComponentDefinition, ComponentRef
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import ComponentRefNode, Edge, NodeInstance
from quantize.schema.version import SUPPORTED_SCHEMA_VERSIONS, is_supported_schema_version
from quantize.validation.errors import (
    COMPONENT_CYCLE,
    COMPONENT_DIRECT_RECURSION,
    DUPLICATE_COMPONENT_DEFINITION,
    DUPLICATE_NODE_ID,
    DUPLICATE_REF_ID,
    EDGE_ENDPOINT_UNKNOWN_NODE,
    GRAPH_CYCLE,
    SELF_EDGE,
    UNKNOWN_COMPONENT_REF,
    UNSUPPORTED_SCHEMA_VERSION,
    ComponentKey,
    ComponentSetValidation,
    StructuralError,
    StructuralValidation,
)

# --- Deterministic ordering ------------------------------------------------------------------


def _error_sort_key(error: StructuralError) -> tuple[object, ...]:
    # Map each loc element to (type_rank, value) so mixed int/str paths order deterministically
    # regardless of input dict/list ordering, then break ties by code and subject.
    loc = tuple((0, element) if isinstance(element, int) else (1, element) for element in error.loc)
    return (loc, error.code, error.subject or "")


def _sorted(errors: Iterable[StructuralError]) -> tuple[StructuralError, ...]:
    return tuple(sorted(errors, key=_error_sort_key))


# --- Pure cycle detection (algorithm, no presentation) ---------------------------------------


def _find_cycle[H: Hashable](adjacency: dict[H, list[H]]) -> list[H] | None:
    """Return one cycle as a node path ``[n, ..., n]`` (deterministic), or ``None`` if acyclic.

    Three-colour DFS over a pre-built adjacency map. Nodes and neighbours are visited in sorted
    order so the cycle found for a given graph is always the same one. The traversal uses an
    explicit stack (not recursion) so a deep acyclic chain cannot raise ``RecursionError``.
    """
    white, grey, black = 0, 1, 2
    colour: dict[H, int] = dict.fromkeys(adjacency, white)

    for root in sorted(adjacency):  # type: ignore[type-var]  # keys are sortable in practice
        if colour[root] != white:
            continue
        colour[root] = grey
        path: list[H] = [root]
        iterators: list[Iterator[H]] = [iter(adjacency[root])]
        while path:
            descended = False
            for neighbour in iterators[-1]:
                if colour[neighbour] == grey:  # back edge → a cycle on the current path
                    start = path.index(neighbour)
                    return [*path[start:], neighbour]
                if colour[neighbour] == white:
                    colour[neighbour] = grey
                    path.append(neighbour)
                    iterators.append(iter(adjacency[neighbour]))
                    descended = True
                    break  # resume this neighbour's iterator after the child is fully explored
            if not descended:  # node exhausted → finalize and backtrack
                colour[path.pop()] = black
                iterators.pop()
    return None


# --- Graph-structural checks (shared by strategy docs and component-definition bodies) --------


def _node_ids(nodes: Sequence[NodeInstance]) -> set[str]:
    return {node.id for node in nodes}


def _validate_graph(
    nodes: Sequence[NodeInstance],
    edges: Sequence[Edge],
    declared_ref_ids: set[str],
    base_loc: tuple[str | int, ...],
) -> list[StructuralError]:
    """Validate a node/edge graph in isolation (no registry). ``base_loc`` prefixes every loc so a
    component-definition body reports under ``("implementation", "graph", ...)``."""
    errors: list[StructuralError] = []
    known_ids: set[str] = set()

    # Unique node ids — flag each repeat occurrence at its own index.
    for index, node in enumerate(nodes):
        if node.id in known_ids:
            errors.append(
                StructuralError(
                    DUPLICATE_NODE_ID,
                    f"duplicate node id {node.id!r}",
                    (*base_loc, "nodes", index),
                    node.id,
                )
            )
        known_ids.add(node.id)

    # Component nodes must resolve to a declared local component_refs entry.
    for index, node in enumerate(nodes):
        if isinstance(node, ComponentRefNode) and node.ref not in declared_ref_ids:
            errors.append(
                StructuralError(
                    UNKNOWN_COMPONENT_REF,
                    f"component node {node.id!r} references undeclared ref {node.ref!r}",
                    (*base_loc, "nodes", index),
                    node.ref,
                )
            )

    existing = _node_ids(nodes)
    adjacency: dict[str, list[str]] = {node_id: [] for node_id in existing}
    for index, edge in enumerate(edges):
        source, destination = edge.from_[0], edge.to[0]
        source_known = source in existing
        destination_known = destination in existing
        if not source_known:
            errors.append(
                StructuralError(
                    EDGE_ENDPOINT_UNKNOWN_NODE,
                    f"edge source references unknown node {source!r}",
                    (*base_loc, "edges", index, "from"),
                    source,
                )
            )
        if not destination_known:
            errors.append(
                StructuralError(
                    EDGE_ENDPOINT_UNKNOWN_NODE,
                    f"edge destination references unknown node {destination!r}",
                    (*base_loc, "edges", index, "to"),
                    destination,
                )
            )
        if source == destination:
            errors.append(
                StructuralError(
                    SELF_EDGE,
                    f"node {source!r} has an edge to itself",
                    (*base_loc, "edges", index),
                    source,
                )
            )
        # Only well-formed, non-self edges contribute to cycle detection.
        elif source_known and destination_known:
            adjacency[source].append(destination)

    for neighbours in adjacency.values():
        neighbours.sort()
    cycle = _find_cycle(adjacency)
    if cycle is not None:
        errors.append(
            StructuralError(
                GRAPH_CYCLE,
                "graph contains a cycle: " + " -> ".join(cycle),
                (*base_loc, "nodes"),
                cycle[0],
            )
        )

    return errors


def _duplicate_ref_id_errors(
    refs: Sequence[ComponentRef],
    base_loc: tuple[str | int, ...],
) -> list[StructuralError]:
    """Flag duplicate ``id``s within a single document's ``component_refs`` list."""
    errors: list[StructuralError] = []
    seen: set[str] = set()
    for index, ref in enumerate(refs):
        ref_id = ref.id
        if ref_id in seen:
            errors.append(
                StructuralError(
                    DUPLICATE_REF_ID,
                    f"duplicate component_refs id {ref_id!r}",
                    (*base_loc, "component_refs", index),
                    ref_id,
                )
            )
        seen.add(ref_id)
    return errors


def _schema_version_errors(version: str) -> list[StructuralError]:
    """Reject a ``schema_version`` this build does not support (plan §4, M1 column).

    Operates on an already-parsed document; a future raw-document loader may instead inspect
    ``schema_version`` *before* selecting a parser (see ``quantize.schema.version``).
    """
    if is_supported_schema_version(version):
        return []
    supported = ", ".join(sorted(SUPPORTED_SCHEMA_VERSIONS))
    return [
        StructuralError(
            UNSUPPORTED_SCHEMA_VERSION,
            f"schema_version {version!r} is not supported (supported: {supported})",
            ("schema_version",),
            version,
        )
    ]


# --- Public API: single documents ------------------------------------------------------------
#
# Diagnostic policy (both single-document validators): independently-detectable structural errors
# are **accumulated** (unsupported schema version, duplicate ids, dangling endpoints, self-edges,
# unresolved component refs). Cycle analysis is the one exception — it emits a **single
# deterministic representative** ``graph_cycle`` for the graph rather than enumerating every cycle.


def validate_strategy_document(document: StrategyDocument) -> StructuralValidation:
    """Structurally validate a parsed ``StrategyDocument`` (see the diagnostic policy above)."""
    errors: list[StructuralError] = []
    errors += _schema_version_errors(document.schema_version)
    errors += _duplicate_ref_id_errors(document.component_refs, ())
    declared_ref_ids = {ref.id for ref in document.component_refs}
    errors += _validate_graph(document.nodes, document.edges, declared_ref_ids, ())
    ordered = _sorted(errors)
    return StructuralValidation(ok=not ordered, errors=ordered)


def validate_component_definition(definition: ComponentDefinition) -> StructuralValidation:
    """Structurally validate a parsed ``ComponentDefinition`` (see the diagnostic policy above).

    Detects **direct** self-reference (a ``component_refs`` entry pinning the definition's own
    identity). **Transitive** cycles require the surrounding set — use ``validate_component_set``.
    """
    errors: list[StructuralError] = []
    errors += _schema_version_errors(definition.schema_version)
    errors += _duplicate_ref_id_errors(definition.component_refs, ())

    own_key = ComponentKey(definition.component_id, definition.version)
    for index, ref in enumerate(definition.component_refs):
        if ComponentKey(ref.component_id, ref.version) == own_key:
            errors.append(
                StructuralError(
                    COMPONENT_DIRECT_RECURSION,
                    f"component {own_key} references itself",
                    ("component_refs", index),
                    str(own_key),
                )
            )

    declared_ref_ids = {ref.id for ref in definition.component_refs}
    graph = definition.implementation.graph
    errors += _validate_graph(
        graph.nodes, graph.edges, declared_ref_ids, ("implementation", "graph")
    )
    ordered = _sorted(errors)
    return StructuralValidation(ok=not ordered, errors=ordered)


# --- Public API: component sets (plan §5 / decision H) ---------------------------------------


def validate_component_set(definitions: Sequence[ComponentDefinition]) -> ComponentSetValidation:
    """Validate a caller-supplied set of component definitions for recursion (plan §5).

    Builds the directed dependency graph over ``(component_id, version)`` from each definition's
    ``component_refs`` and detects direct + transitive cycles **within the supplied closure**. It
    does **not** fetch or resolve definitions from any store and consults no node catalog.
    References to identities outside the supplied set are **permitted as unresolved external
    dependencies** (reported in ``unresolved_refs``, deferred to M2/M3) — not failures.

    Diagnostic policy: duplicate-identity and direct-recursion diagnostics are accumulated (one per
    identity); transitive-cycle analysis emits a **single deterministic representative**
    ``component_cycle`` for the set rather than enumerating every cycle.
    """
    errors: list[StructuralError] = []

    # Duplicate identity (same component_id + version supplied more than once).
    seen_keys: set[ComponentKey] = set()
    for index, definition in enumerate(definitions):
        key = ComponentKey(definition.component_id, definition.version)
        if key in seen_keys:
            errors.append(
                StructuralError(
                    DUPLICATE_COMPONENT_DEFINITION,
                    f"component {key} supplied more than once",
                    ("definitions", index),
                    str(key),
                )
            )
        seen_keys.add(key)

    supplied = {ComponentKey(d.component_id, d.version) for d in definitions}
    unresolved: set[ComponentKey] = set()
    adjacency: dict[ComponentKey, set[ComponentKey]] = {key: set() for key in supplied}
    # LOW-2 policy: emit exactly one direct-recursion diagnostic per component identity, even if a
    # definition declares several self-referencing component_refs (they share loc/subject, so extra
    # copies would be pure noise). Distinct identities still each get their own diagnostic.
    flagged_direct: set[ComponentKey] = set()

    for definition in definitions:
        key = ComponentKey(definition.component_id, definition.version)
        for ref in definition.component_refs:
            target = ComponentKey(ref.component_id, ref.version)
            if target == key:
                if key not in flagged_direct:
                    flagged_direct.add(key)
                    errors.append(
                        StructuralError(
                            COMPONENT_DIRECT_RECURSION,
                            f"component {key} references itself",
                            ("definitions",),
                            str(key),
                        )
                    )
            elif target in supplied:
                adjacency[key].add(target)
            else:
                unresolved.add(target)

    sorted_adjacency = {key: sorted(targets) for key, targets in adjacency.items()}
    cycle = _find_cycle(sorted_adjacency)
    if cycle is not None:
        errors.append(
            StructuralError(
                COMPONENT_CYCLE,
                "component dependency cycle: " + " -> ".join(str(key) for key in cycle),
                ("definitions",),
                str(cycle[0]),
            )
        )

    ordered = _sorted(errors)
    return ComponentSetValidation(
        ok=not ordered,
        errors=ordered,
        unresolved_refs=tuple(sorted(unresolved)),
    )
