"""``output.target_portfolio`` — the one graph terminal.

The strategy graph ends here: the node consumes the final ``PortfolioTargets`` and produces no
outputs. Turning targets into orders (reconciliation) is ENGINE territory (M4, ADR-0005) — there
is deliberately no order-generation node and no ``OrderList`` port type.
"""

from __future__ import annotations

from collections.abc import Mapping

from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeDoc,
    NodeMetadata,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import PortfolioTargetsValue, RuntimeValue
from quantize.schema.primitives import JsonValue
from quantize.schema.types import PortfolioTargetsType
from quantize.tracing.spec import (
    NUMBER,
    TraceEventSpec,
    combined_trace_schema,
    pair_list,
)

_TRACE_EVENTS = (
    TraceEventSpec.of(
        "targets.finalized",
        1,
        {"weights": pair_list(NUMBER), "cash": NUMBER},
        ("weights", "cash"),
    ),
)


def _evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    targets = invocation.inputs["targets"]
    assert isinstance(targets, PortfolioTargetsValue)
    weights: list[JsonValue] = [[asset, weight] for asset, weight in targets.weights]
    invocation.trace("targets.finalized", {"v": 1, "weights": weights, "cash": targets.cash_weight})
    return {}


TARGET_PORTFOLIO = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="output.target_portfolio",
        type_version="1.0.0",
        inputs=(
            InputPortSpec(name="targets", port_type=PortfolioTargetsType(kind="PortfolioTargets")),
        ),
        outputs=(),
        metadata=NodeMetadata(
            display_name="Target Portfolio",
            description=(
                "The graph terminal: receives the final PortfolioTargets. The engine — not the "
                "graph — reconciles targets into orders."
            ),
            category="output",
            doc=NodeDoc(
                summary=(
                    "The machine's output — the final PortfolioTargets the strategy graph "
                    "produces. The engine (not the graph) reconciles these targets into orders "
                    "and fills."
                ),
                semantics=(
                    "The single graph terminal; consumes the final PortfolioTargets and emits no "
                    "value. Turning targets into orders is engine territory (there is no "
                    "order-generation node)."
                ),
            ),
        ),
        parameter_schema=JsonSchemaSpec({"type": "object", "additionalProperties": False}),
        trace_schema=combined_trace_schema(_TRACE_EVENTS),
        trace_events=_TRACE_EVENTS,
    ),
    evaluate=_evaluate,
)
