"""Topological planning — the deterministic evaluation order of a validated DAG.

Kahn's algorithm with a sorted ready-set: dependencies always precede dependents, and whenever
several nodes are simultaneously ready the one with the lexicographically smallest node id runs
first. The order is therefore a pure function of the graph — never of dict/set iteration order.

Precondition: the graph already passed M1 structural validation (unique ids, endpoints exist,
acyclic). A cycle here means the caller skipped that layer, so it raises — it is a programming
error, not an expected runtime diagnostic.
"""

from __future__ import annotations

import heapq
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from quantize.components.resolve import ResolvedComponentInstance, ResolvedStrategy
from quantize.registry.registry import ResolutionStatus
from quantize.runtime.binding import ImplementationCatalog
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import Edge, NodeInstance, RegisteredNode
from quantize.schema.primitives import JsonValue


def topological_order(nodes: Sequence[NodeInstance], edges: Sequence[Edge]) -> tuple[str, ...]:
    """The deterministic dependency-respecting evaluation order of the node ids."""
    node_ids = [node.id for node in nodes]
    known = set(node_ids)
    if len(known) != len(node_ids):
        raise ValueError("graph has duplicate node ids; structural validation must run first")

    # Distinct dependency pairs only: parallel edges between the same nodes (e.g. two ports)
    # contribute a single ordering constraint.
    pairs = {(edge.from_[0], edge.to[0]) for edge in edges}
    for source, destination in pairs:
        if source not in known or destination not in known:
            raise ValueError(
                "edge references an unknown node; structural validation must run first"
            )

    dependents: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    indegree: dict[str, int] = dict.fromkeys(node_ids, 0)
    for source, destination in sorted(pairs):
        dependents[source].append(destination)
        indegree[destination] += 1

    ready = [node_id for node_id in node_ids if indegree[node_id] == 0]
    heapq.heapify(ready)
    order: list[str] = []
    while ready:
        node_id = heapq.heappop(ready)
        order.append(node_id)
        for dependent in dependents[node_id]:
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                heapq.heappush(ready, dependent)

    if len(order) != len(node_ids):
        raise ValueError("graph contains a cycle; structural validation must run first")
    return tuple(order)


# --- Warm-up resolution ------------------------------------------------------------------------


@dataclass(frozen=True)
class WarmupResolution:
    """Declared warm-up per node (by hierarchical node path) and the strategy-wide maximum.

    ``total`` is the number of history sessions the engine (M4) must see before this strategy's
    first meaningful evaluation. Per-asset warm-up *behavior* (excluding an asset that lacks the
    observations) is each node's documented missing-data rule, applied at evaluation time.
    """

    by_node: Mapping[tuple[str, ...], int]
    total: int


def resolve_warmup(
    document: StrategyDocument,
    catalog: ImplementationCatalog,
    resolution: ResolvedStrategy,
) -> WarmupResolution:
    """Resolve each node's declared warm-up (a function of its effective params)."""
    by_node: dict[tuple[str, ...], int] = {}

    def walk(
        nodes: Sequence[NodeInstance],
        params_by_node: Mapping[str, Mapping[str, JsonValue]],
        instances: Mapping[str, ResolvedComponentInstance],
        path: tuple[str, ...],
    ) -> None:
        for node in sorted(nodes, key=lambda n: n.id):
            if isinstance(node, RegisteredNode):
                resolved = catalog.resolve(node.type_id, node.type_version)
                if resolved.status is ResolutionStatus.OK and resolved.implementation is not None:
                    warmup = resolved.implementation.warmup(params_by_node.get(node.id, {}))
                    by_node[(*path, node.id)] = warmup
            else:
                instance = instances.get(node.id)
                if instance is not None:
                    walk(
                        instance.definition.implementation.graph.nodes,
                        instance.effective_params,
                        instance.children,
                        (*path, node.id),
                    )

    walk(
        document.nodes,
        {node.id: node.params for node in document.nodes},
        resolution.instances,
        (),
    )
    return WarmupResolution(by_node=by_node, total=max(by_node.values(), default=0))
