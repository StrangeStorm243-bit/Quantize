"""Pinned component-closure fetch — the single fastapi-free home for the closure walk.

``load_component_catalog`` breadth-first fetches a document's pinned component closure from the
store into a ``ComponentCatalog``. It lives here (not in ``quantize.api.service``) so both the API
run/validate handlers and the read-only value-tap recompute service can share ONE implementation:
importing ``quantize.api.service`` drags fastapi in transitively (via ``quantize.api.errors``), and
the recompute service must stay API-free. ``quantize.api.service`` re-exports this function so its
existing callers are unaffected.
"""

from __future__ import annotations

from quantize.components.resolve import ComponentCatalog
from quantize.persistence.database import Database
from quantize.persistence.documents import ComponentRepository
from quantize.persistence.errors import ARTIFACT_NOT_FOUND, PersistenceError
from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument


def load_component_catalog(
    db: Database, document: StrategyDocument | ComponentDefinition
) -> ComponentCatalog:
    """Fetch a document's pinned component closure from the store into a ``ComponentCatalog``.

    Mirrors the closure walk ``resolve_strategy_components`` performs internally: breadth-first over
    ``document.component_refs`` and, transitively, each fetched definition's own ``component_refs``.
    *document* is anything holding ``component_refs`` — a ``StrategyDocument`` (the run/validate
    callers) or a ``ComponentDefinition`` (the save-boundary validation), whose OWN nested closure
    is fetched so its definition can be diagnosed before it is persisted.
    A ``(component_id, version)`` that is not stored is left ABSENT — never an HTTP error — so
    resolution emits ``component_definition_unavailable`` (fail-loud preserved at the run layer).
    Visited keys are tracked so a shared or self-referential pin is fetched once (no refetch, and no
    duplicate-key ``ValueError`` when the catalog is constructed)."""
    repository = ComponentRepository(db)
    definitions: list[ComponentDefinition] = []
    visited: set[tuple[str, str]] = set()
    queue: list[tuple[str, str]] = [
        (ref.component_id, ref.version) for ref in document.component_refs
    ]
    while queue:
        key = queue.pop(0)
        if key in visited:
            continue
        visited.add(key)
        try:
            definition = repository.load(key[0], key[1])
        except PersistenceError as error:
            if error.code == ARTIFACT_NOT_FOUND:
                continue  # absent → resolution reports component_definition_unavailable
            raise
        definitions.append(definition)
        queue.extend((ref.component_id, ref.version) for ref in definition.component_refs)
    return ComponentCatalog(definitions)
