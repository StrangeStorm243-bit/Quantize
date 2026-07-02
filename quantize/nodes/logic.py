"""``logic.greater_than`` — the v0 comparison primitive.

Domain-preserving comparison (ratified founder default): the output mask contains EVERY asset in
the bound domain (the union of both operands' domains). If either operand is unavailable for an
asset, that asset's result is ``false`` — not omitted — and a trace event explains the missing
operand. This is deliberately different from the scoring nodes' exclusion rule.
"""

from __future__ import annotations

from collections.abc import Mapping

from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import CrossSectionValue, RuntimeValue
from quantize.schema.primitives import JsonValue
from quantize.schema.types import CrossSectionType

_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")
_CS_BOOL = CrossSectionType(kind="CrossSection", dtype="Boolean")


def _evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    left = invocation.inputs["left"]
    right = invocation.inputs["right"]
    assert isinstance(left, CrossSectionValue) and isinstance(right, CrossSectionValue)

    domain = sorted(set(left.domain) | set(right.domain))
    left_values = left.as_dict()
    right_values = right.as_dict()
    mask: dict[str, bool] = {}
    for asset in domain:
        left_value = left_values.get(asset)
        right_value = right_values.get(asset)
        if left_value is None or right_value is None:
            missing: list[JsonValue] = [
                side
                for side, value in (("left", left_value), ("right", right_value))
                if value is None
            ]
            invocation.trace("logic.missing_operand", {"asset": asset, "missing": missing})
            mask[asset] = False
        else:
            mask[asset] = bool(left_value > right_value)
    return {"values": CrossSectionValue.booleans(domain, mask)}


GREATER_THAN = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="logic.greater_than",
        type_version="1.0.0",
        inputs=(
            InputPortSpec(name="left", port_type=_CS_NUM),
            InputPortSpec(name="right", port_type=_CS_NUM),
        ),
        outputs=(OutputPortSpec(name="values", port_type=_CS_BOOL),),
        metadata=NodeMetadata(
            display_name="Greater Than",
            description=(
                "Per-asset left > right over the full bound domain; a missing operand yields "
                "false (never omission), with a missing-data trace event."
            ),
        ),
        parameter_schema=JsonSchemaSpec({"type": "object", "additionalProperties": False}),
    ),
    evaluate=_evaluate,
)
