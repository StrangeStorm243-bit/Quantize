"""``risk.max_weight`` — cap each weight and redistribute the excess (ratified waterfall).

The ratified deterministic waterfall (STRATEGY_LANGUAGE.md §3):
1. cap every asset exceeding ``max`` at ``max``;
2. redistribute the excess proportionally (by current weight) across eligible UNCAPPED assets
   still below the cap;
3. repeat until no asset exceeds the cap;
4. if no eligible asset has remaining proportional capacity, the unresolved remainder stays in
   cash — the cap is never violated to force full investment.

Each iteration permanently caps at least one more asset, so the loop terminates in at most
``|assets|`` iterations. Assets are always visited in canonical order.
"""

from __future__ import annotations

from collections.abc import Mapping

from quantize.nodes._params import require_number
from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import WEIGHT_TOLERANCE, PortfolioTargetsValue, RuntimeValue
from quantize.schema.primitives import JsonValue
from quantize.schema.types import PortfolioTargetsType

_PT = PortfolioTargetsType(kind="PortfolioTargets")


def _evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    cap = require_number(invocation.params, "max")
    targets = invocation.inputs["targets"]
    assert isinstance(targets, PortfolioTargetsValue)

    assets = [asset for asset, _ in targets.weights]  # canonical order
    weights = dict(targets.weights)
    capped: set[str] = set()
    iterations = 0

    while True:
        over = [asset for asset in assets if weights[asset] > cap + WEIGHT_TOLERANCE]
        if not over:
            break
        iterations += 1
        excess = sum(weights[asset] - cap for asset in over)
        for asset in over:
            weights[asset] = cap
            capped.add(asset)
        eligible = [
            asset
            for asset in assets
            if asset not in capped and 0.0 < weights[asset] < cap - WEIGHT_TOLERANCE
        ]
        eligible_total = sum(weights[asset] for asset in eligible)
        if eligible_total <= 0.0:
            # No proportional capacity left: the remainder stays in cash (rule 4/5).
            break
        for asset in eligible:
            weights[asset] += excess * weights[asset] / eligible_total

    if iterations:
        unallocated = targets.invested_weight - sum(weights.values())
        capped_assets: list[JsonValue] = [asset for asset in sorted(capped)]
        invocation.trace(
            "risk.cap_applied",
            {
                "capped_assets": capped_assets,
                "iterations": iterations,
                "left_in_cash": max(0.0, unallocated),
            },
        )
    return {"targets": PortfolioTargetsValue.of(weights)}


MAX_WEIGHT = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="risk.max_weight",
        type_version="1.0.0",
        inputs=(InputPortSpec(name="targets", port_type=_PT),),
        outputs=(OutputPortSpec(name="targets", port_type=_PT),),
        metadata=NodeMetadata(
            display_name="Max Weight Cap",
            description=(
                "Caps each weight at max and redistributes the excess via the deterministic "
                "proportional waterfall; an unresolvable remainder stays in cash."
            ),
        ),
        parameter_schema=JsonSchemaSpec(
            {
                "type": "object",
                "properties": {"max": {"type": "number", "exclusiveMinimum": 0, "maximum": 1}},
                "required": ["max"],
                "additionalProperties": False,
            }
        ),
    ),
    evaluate=_evaluate,
)
