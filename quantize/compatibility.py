"""The single, central port-type compatibility decision.

Supports the "one compatibility function" rule (docs/STRATEGY_LANGUAGE.md §2) and invariants 4/5/7:
the graph validator and (later) the editor both call this, so the frontend never reimplements type
logic. Allow-list semantics — only an exact match or the one explicit widening is compatible; every
other pairing (the "no implicit meaning change" cases) is rejected by falling through to False.
"""

from __future__ import annotations

from quantize.schema.types import PortType, ScalarType


def is_compatible(source: PortType, destination: PortType) -> bool:
    """True iff an edge from a *source* (output) port type to a *destination* (input) port type is
    allowed. Arguments follow edge direction: output -> input."""
    if source == destination:
        return True
    # the ONE explicit widening: Scalar[Integer] -> Scalar[Number]
    return (
        isinstance(source, ScalarType)
        and source.dtype == "Integer"
        and isinstance(destination, ScalarType)
        and destination.dtype == "Number"
    )
