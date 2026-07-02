"""``output.target_portfolio`` — the one graph terminal.

The strategy graph ends here: the node consumes the final ``PortfolioTargets`` and produces no
outputs. Turning targets into orders (reconciliation) is ENGINE territory (M4, ADR-0005) — there
is deliberately no order-generation node and no ``OrderList`` port type.
"""

from __future__ import annotations

from collections.abc import Mapping

from quantize.registry.descriptor import InputPortSpec, NodeDescriptor, NodeMetadata
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import RuntimeValue
from quantize.schema.types import PortfolioTargetsType


def _evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
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
        ),
        parameter_schema=JsonSchemaSpec({"type": "object", "additionalProperties": False}),
    ),
    evaluate=_evaluate,
)
