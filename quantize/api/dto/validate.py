"""Validate-endpoint DTOs — the wire projection of ``PreflightResult``.

The diagnostic DTOs mirror the NATIVE pre-flight shapes so the loc-aware, per-layer detail survives
to the client: structural/semantic diagnostics locate faults by document ``loc``; runtime
diagnostics locate them by execution ``node_path``. These are domain values (safe to expose) —
distinct from the infrastructure ``ApiError``.
"""

from __future__ import annotations

from quantize.api.dto.common import _Dto


class StructuralDiagnosticDto(_Dto):
    """One structural (M1.2) fault: located by document ``loc`` (e.g. ``("edges", 2, "from")``)."""

    code: str
    message: str
    loc: tuple[str | int, ...]
    subject: str | None = None


class SemanticDiagnosticDto(_Dto):
    """One semantic (M2) fault. Same shape as the structural DTO; kept a distinct type."""

    code: str
    message: str
    loc: tuple[str | int, ...]
    subject: str | None = None


class RuntimeDiagnosticDto(_Dto):
    """One resolution/wiring/terminal fault: located by execution ``node_path``, not ``loc``."""

    code: str
    message: str
    node_path: tuple[str, ...]
    subject: str | None = None


class ValidateResponse(_Dto):
    """The run-faithful validation verdict. ``ok`` is true only when every layer is clean; on ok
    it additionally reports ``warmup_sessions`` (the resolved warm-up the run would require)."""

    ok: bool
    structural: tuple[StructuralDiagnosticDto, ...]
    semantic: tuple[SemanticDiagnosticDto, ...]
    runtime: tuple[RuntimeDiagnosticDto, ...]
    warmup_sessions: int | None = None
