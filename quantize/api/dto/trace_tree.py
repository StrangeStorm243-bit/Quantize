"""Trace-tree endpoint DTOs (M13.6) — the wire mirror of ``quantize/tracing/tree.py``.

A pure read-only projection: ``TraceTreeNodeDto``/``TraceTreeDto`` mirror the frozen
``TraceTreeNode``/``TraceTree`` dataclasses field-for-field. Identity, the engine/node origin
split, first-emission sibling order, and ascending-instant order are all decided by
``build_trace_trees`` — never re-decided here. ``TraceEvent`` is REUSED from the tracing layer,
exactly as the flat ``TraceResponse`` reuses it. Every field is REQUIRED (no defaults): these are
response-only shapes the mapper always fills, so the generated TypeScript carries required fields
(a defaulted field would generate as optional — see ``TraceEvent.component_path``).
"""

from __future__ import annotations

from typing import Literal, cast

from quantize.api.dto.common import _Dto
from quantize.schema.primitives import EntityId, NodeId, Utc
from quantize.tracing.events import TraceEvent
from quantize.tracing.tree import TraceTree, TraceTreeNode


class TraceTreeNodeDto(_Dto):
    """One node (or component instance, or the engine) with its events and nested children."""

    node_id: NodeId
    component_path: tuple[NodeId, ...]
    origin: Literal["node", "engine"]
    events: tuple[TraceEvent, ...]
    children: tuple[TraceTreeNodeDto, ...]


class TraceTreeDto(_Dto):
    """All events of one instant, nested by component hierarchy."""

    run_id: EntityId
    instant: Utc
    roots: tuple[TraceTreeNodeDto, ...]


class TraceTreeResponse(_Dto):
    """The run's per-instant trace trees, ascending by instant (optionally session-filtered)."""

    trees: tuple[TraceTreeDto, ...]


def _node_dto(node: TraceTreeNode) -> TraceTreeNodeDto:
    # ``TraceTreeNode.origin`` is typed ``str`` but only ever the reserved pair; the tree builder
    # is the sole producer, so this cast documents the invariant rather than re-checking it.
    return TraceTreeNodeDto(
        node_id=node.node_id,
        component_path=node.component_path,
        origin=cast(Literal["node", "engine"], node.origin),
        events=node.events,
        children=tuple(_node_dto(child) for child in node.children),
    )


def trace_tree_dto(tree: TraceTree) -> TraceTreeDto:
    """Serialize one ``build_trace_trees`` tree. Order-preserving and pure."""
    return TraceTreeDto(
        run_id=tree.run_id,
        instant=tree.instant,
        roots=tuple(_node_dto(root) for root in tree.roots),
    )
