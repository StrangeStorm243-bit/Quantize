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
    NodeDoc,
    NodeMetadata,
    OutputPortSpec,
    ParamDoc,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import WEIGHT_TOLERANCE, PortfolioTargetsValue, RuntimeValue
from quantize.schema.primitives import JsonValue
from quantize.schema.types import PortfolioTargetsType
from quantize.tracing.spec import (
    ASSET_LIST,
    NUMBER,
    TraceEventSpec,
    combined_trace_schema,
)

_PT = PortfolioTargetsType(kind="PortfolioTargets")

_TRACE_EVENTS = (
    TraceEventSpec.of(
        "risk.cap_applied",
        1,
        {
            "capped_assets": ASSET_LIST,
            "iterations": {"type": "integer", "minimum": 1},
            "left_in_cash": NUMBER,
            # EVERY asset whose weight changed: capped assets AND redistribution
            # recipients, as [asset, before, after] triples.
            "adjusted": {
                "type": "array",
                "items": {
                    "type": "array",
                    "prefixItems": [
                        {"type": "string", "minLength": 1},
                        {"type": "number"},
                        {"type": "number"},
                    ],
                    "minItems": 3,
                    "maxItems": 3,
                    "items": False,
                },
            },
        },
        ("capped_assets", "iterations", "left_in_cash", "adjusted"),
    ),
)


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
        original = dict(targets.weights)
        adjusted: list[JsonValue] = [
            [asset, original[asset], weights[asset]]
            for asset in assets
            if weights[asset] != original[asset]
        ]
        invocation.trace(
            "risk.cap_applied",
            {
                "v": 1,
                "capped_assets": capped_assets,
                "iterations": iterations,
                "left_in_cash": max(0.0, unallocated),
                "adjusted": adjusted,
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
            category="risk",
            doc=NodeDoc(
                summary=(
                    "Caps concentration — limits any single asset's weight to max and "
                    "redistributes the excess across the others. The machine's risk-control stage."
                ),
                formula="w(asset) ≤ max;  excess redistributed proportionally to uncapped assets",
                semantics=(
                    "Deterministic waterfall: cap every over-limit asset at max, redistribute the "
                    "excess proportionally across eligible uncapped assets, repeat until no asset "
                    "exceeds the cap. If no eligible capacity remains, the remainder stays in cash "
                    "— the cap is never violated to force full investment."
                ),
                parameters={
                    "max": ParamDoc(
                        label="Max weight",
                        help="Ceiling on any single asset's weight (0–1); excess is redistributed.",
                    ),
                },
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
        trace_schema=combined_trace_schema(_TRACE_EVENTS),
        trace_events=_TRACE_EVENTS,
    ),
    evaluate=_evaluate,
)
