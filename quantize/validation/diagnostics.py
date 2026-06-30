"""Shared deterministic ordering for validation diagnostics.

Structural (M1.2) and semantic (M2.2) layers sort findings by one policy — loc, then code, then
subject — so output never depends on dict/set iteration order. Extracted here so the two layers
share one policy and cannot drift.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol


class HasLocCodeSubject(Protocol):
    # Read-only members (properties) so frozen dataclasses (StructuralError, SemanticDiagnostic),
    # whose fields are read-only, structurally satisfy the protocol.
    @property
    def loc(self) -> tuple[str | int, ...]: ...

    @property
    def code(self) -> str: ...

    @property
    def subject(self) -> str | None: ...


def diagnostic_sort_key(diagnostic: HasLocCodeSubject) -> tuple[object, ...]:
    # Map each loc element to (type_rank, value) so mixed int/str paths order deterministically
    # regardless of input dict/list ordering, then break ties by code and subject.
    loc = tuple(
        (0, element) if isinstance(element, int) else (1, element) for element in diagnostic.loc
    )
    return (loc, diagnostic.code, diagnostic.subject or "")


def sort_diagnostics[T: HasLocCodeSubject](items: Iterable[T]) -> tuple[T, ...]:
    return tuple(sorted(items, key=diagnostic_sort_key))
