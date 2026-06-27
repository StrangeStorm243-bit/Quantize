"""Semantic projection of strategy and component documents.

``semantic_projection`` produces a canonical form for comparison: it removes only presentation-only
fields (``ui``), preserves all executable content (incl. ``extensions``), and canonicalizes
declared-non-semantic ordering (nodes by id, edges by endpoints, component refs by id, object keys
sorted). It builds on the canonical serializer, so a mutated/non-portable document is rejected, not
silently projected. It makes **no** claim of graph isomorphism or algebraic equivalence.
"""

from __future__ import annotations

import json
from typing import Any

from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument
from quantize.schema.serialization import to_ir_dict


def _without_ui(node: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in node.items() if key != "ui"}


def _canonicalize_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    projected = [_without_ui(node) for node in nodes]
    projected.sort(key=lambda node: node["id"])
    return projected


def _sort_edges(edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(edges, key=lambda e: (e["from"][0], e["from"][1], e["to"][0], e["to"][1]))


def _canonical_json(data: dict[str, Any]) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def semantic_projection(document: StrategyDocument) -> str:
    """Return the canonical-JSON projection of a strategy *document* used for semantic equality."""
    data = to_ir_dict(document)
    data["nodes"] = _canonicalize_nodes(data["nodes"])
    data["edges"] = _sort_edges(data["edges"])
    data["component_refs"] = sorted(data["component_refs"], key=lambda ref: ref["id"])
    return _canonical_json(data)


def documents_semantically_equal(a: StrategyDocument, b: StrategyDocument) -> bool:
    """True iff *a* and *b* have the same strategy semantic projection."""
    return semantic_projection(a) == semantic_projection(b)


def component_semantic_projection(component: ComponentDefinition) -> str:
    """Return the canonical-JSON projection of a *component* (internal node ``ui`` removed)."""
    data = to_ir_dict(component)
    graph: dict[str, Any] = data["implementation"]["graph"]
    graph["nodes"] = _canonicalize_nodes(graph["nodes"])
    graph["edges"] = _sort_edges(graph["edges"])
    data["component_refs"] = sorted(data["component_refs"], key=lambda ref: ref["id"])
    return _canonical_json(data)


def components_semantically_equal(a: ComponentDefinition, b: ComponentDefinition) -> bool:
    """True iff *a* and *b* have the same component semantic projection."""
    return component_semantic_projection(a) == component_semantic_projection(b)
