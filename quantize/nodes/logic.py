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
    NodeDoc,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import CrossSectionValue, RuntimeValue
from quantize.schema.primitives import JsonValue
from quantize.schema.types import CrossSectionType
from quantize.tracing.spec import ASSET_LIST, STRING, TraceEventSpec, combined_trace_schema

_TRACE_EVENTS = (
    TraceEventSpec.of(
        "logic.evaluated",
        1,
        {"passed": ASSET_LIST, "failed": ASSET_LIST, "defaulted_missing": ASSET_LIST},
        ("passed", "failed", "defaulted_missing"),
    ),
    TraceEventSpec.of(
        "logic.missing_operand",
        1,
        {"asset": STRING, "missing": ASSET_LIST},
        ("asset", "missing"),
    ),
)

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
    passed: list[JsonValue] = []
    failed: list[JsonValue] = []
    defaulted: list[JsonValue] = []
    for asset in domain:
        left_value = left_values.get(asset)
        right_value = right_values.get(asset)
        if left_value is None or right_value is None:
            missing: list[JsonValue] = [
                side
                for side, value in (("left", left_value), ("right", right_value))
                if value is None
            ]
            invocation.trace("logic.missing_operand", {"v": 1, "asset": asset, "missing": missing})
            mask[asset] = False
            defaulted.append(asset)
        else:
            result = bool(left_value > right_value)
            mask[asset] = result
            (passed if result else failed).append(asset)
    # The three-way condition distinction: genuinely-false vs defaulted-false-on-missing.
    invocation.trace(
        "logic.evaluated",
        {"v": 1, "passed": passed, "failed": failed, "defaulted_missing": defaulted},
    )
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
            category="signal",
            doc=NodeDoc(
                summary=(
                    "Turns two cross-sections into a per-asset yes/no signal — asks 'is left "
                    "greater than right?' for every asset (e.g. price above its moving average). "
                    "This is the machine's condition/gate stage."
                ),
                formula="mask(asset) = left(asset) > right(asset)",
                semantics=(
                    "Preserves the full bound domain: every asset appears in the output mask. If "
                    "either operand is missing for an asset, its result is false (never omitted), "
                    "with a missing-operand trace event."
                ),
            ),
        ),
        parameter_schema=JsonSchemaSpec({"type": "object", "additionalProperties": False}),
        trace_schema=combined_trace_schema(_TRACE_EVENTS),
        trace_events=_TRACE_EVENTS,
    ),
    evaluate=_evaluate,
)
