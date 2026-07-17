"""Node Value Tap — read-only recompute service (M14.1a).

Resolves the value a node's output port produced during a persisted run by deterministically
RE-EVALUATING the run's pinned strategy at the run's own recorded evaluation instant, through the
ONE existing evaluator (never a second evaluation path). No API surface, no DTO, no persistence
write — this slice is a pure projection over stored facts plus a bounded recompute.
"""

from __future__ import annotations

from quantize.valuetap.service import (
    AMBIGUOUS_OUTPUT_PORT,
    ENGINE_DRIFT,
    NO_EVALUATION_AT_SESSION,
    RECOMPUTE_FAILED,
    STATUS_FOR_VALUE_TAP_CODE,
    UNEXPECTED_FAILURE,
    VALUE_ADDRESS_NOT_FOUND,
    ResolvedNodeValue,
    ValueTapError,
    resolve_node_value,
)

__all__ = [
    "AMBIGUOUS_OUTPUT_PORT",
    "ENGINE_DRIFT",
    "NO_EVALUATION_AT_SESSION",
    "RECOMPUTE_FAILED",
    "STATUS_FOR_VALUE_TAP_CODE",
    "UNEXPECTED_FAILURE",
    "VALUE_ADDRESS_NOT_FOUND",
    "ResolvedNodeValue",
    "ValueTapError",
    "resolve_node_value",
]
