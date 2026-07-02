"""Structured runtime diagnostics (M3).

Expected document/data/runtime failures surface as ``RuntimeDiagnostic``s inside a run outcome —
stable machine codes, node identity via the hierarchical node path, deterministic ordering. They
are the runtime counterpart of ``StructuralError``/``SemanticDiagnostic`` (which locate faults by
*document* position; a runtime fault is located by *execution* identity instead). Unexpected
programmer errors still raise.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeDiagnostic:
    """One expected runtime fault.

    * ``code`` — a stable machine identifier (constants live beside their emitters).
    * ``message`` — a human-readable description.
    * ``node_path`` — hierarchical execution identity: component-instance ids then the node id
      (e.g. ``("cInst", "sel")``); ``()`` for run-level faults.
    * ``subject`` — the responsible entity (port, param, component key, …) when one applies.
    """

    code: str
    message: str
    node_path: tuple[str, ...] = ()
    subject: str | None = None


def sort_runtime_diagnostics(
    diagnostics: Iterable[RuntimeDiagnostic],
) -> tuple[RuntimeDiagnostic, ...]:
    """One deterministic ordering policy: node path, then code, then subject, then message."""
    return tuple(
        sorted(
            diagnostics,
            key=lambda d: (d.node_path, d.code, d.subject or "", d.message),
        )
    )
