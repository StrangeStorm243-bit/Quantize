"""Deterministic per-instant trace trees (M6), assembled from the flat event stream.

Identity is ``(component_path, node_id)``; hierarchy follows component-path prefixes (a
component-instance node is materialized even if it emitted nothing); sibling order is first
emission — deterministic because emission order is (topological node order inside the M3
evaluator; the engine's session loop outside). Engine-origin events (the reserved ``engine.``
event-type namespace) are separated into their own root, placed AFTER node roots at the same
instant — the within-instant ordering contract — even if a strategy node happens to be named
``engine``. Pure function; nothing here re-reads market data or re-makes decisions.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime

from quantize.tracing.events import TraceEvent
from quantize.tracing.spec import ENGINE_EVENT_PREFIX, ENGINE_NODE_ID


@dataclass(frozen=True)
class TraceTreeNode:
    """Events of one node (or component instance, or the engine) plus nested children."""

    node_id: str
    component_path: tuple[str, ...]
    origin: str  # "node" | "engine"
    events: tuple[TraceEvent, ...]
    children: tuple[TraceTreeNode, ...] = ()


@dataclass(frozen=True)
class TraceTree:
    """All events of one instant, nested by component hierarchy."""

    run_id: str
    instant: datetime
    roots: tuple[TraceTreeNode, ...]


@dataclass
class _Builder:
    node_id: str
    component_path: tuple[str, ...]
    origin: str
    events: list[TraceEvent] = field(default_factory=list)
    children: dict[tuple[tuple[str, ...], str], _Builder] = field(default_factory=dict)

    def freeze(self) -> TraceTreeNode:
        return TraceTreeNode(
            node_id=self.node_id,
            component_path=self.component_path,
            origin=self.origin,
            events=tuple(self.events),
            children=tuple(child.freeze() for child in self.children.values()),
        )


def _is_engine_event(event: TraceEvent) -> bool:
    return event.event_type.startswith(ENGINE_EVENT_PREFIX)


def build_trace_trees(events: Sequence[TraceEvent]) -> tuple[TraceTree, ...]:
    """Group *events* (one run) into per-instant trees. Deterministic; input order preserved
    within each instant (first-emission sibling order)."""
    if not events:
        return ()
    run_ids = {event.run_id for event in events}
    if len(run_ids) != 1:
        raise ValueError(f"events span multiple runs: {sorted(run_ids)!r}")

    by_instant: dict[datetime, list[TraceEvent]] = {}
    for event in events:
        by_instant.setdefault(event.timestamp, []).append(event)

    trees: list[TraceTree] = []
    for instant in sorted(by_instant):
        node_roots: dict[tuple[tuple[str, ...], str], _Builder] = {}
        engine_root: _Builder | None = None
        for event in by_instant[instant]:
            if _is_engine_event(event):
                if engine_root is None:
                    engine_root = _Builder(ENGINE_NODE_ID, (), "engine")
                engine_root.events.append(event)
                continue
            # Materialize the instance chain: ("a","b") nests node under instance "a" -> "b".
            level = node_roots
            parent_path: tuple[str, ...] = ()
            for instance_id in event.component_path:
                key = (parent_path, instance_id)
                builder = level.get(key)
                if builder is None:
                    builder = _Builder(instance_id, parent_path, "node")
                    level[key] = builder
                level = builder.children
                parent_path = (*parent_path, instance_id)
            key = (parent_path, event.node_id)
            builder = level.get(key)
            if builder is None:
                builder = _Builder(event.node_id, parent_path, "node")
                level[key] = builder
            builder.events.append(event)
        roots = [builder.freeze() for builder in node_roots.values()]
        if engine_root is not None:
            roots.append(engine_root.freeze())  # engine sorts after node roots (contract)
        trees.append(TraceTree(run_id=events[0].run_id, instant=instant, roots=tuple(roots)))
    return tuple(trees)
