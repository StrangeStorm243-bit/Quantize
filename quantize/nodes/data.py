"""``data.price`` — per-asset close history, as available at the evaluation instant.

The bound ``AssetSet`` input decides which assets to load; the availability-gated ``DataView``
decides what is knowable. An asset with no visible observations stays in the output domain with
an empty history (and a trace event) — exclusion happens downstream by each consumer's documented
rule, never by silently dropping the asset here.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date

from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import AssetSetValue, RuntimeValue, TimeSeriesValue
from quantize.schema.types import AssetSetType, TimeSeriesType


def _evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    assets = invocation.inputs["assets"]
    assert isinstance(assets, AssetSetValue)
    series: dict[str, list[tuple[date, float]]] = {}
    for asset in assets.assets:  # canonical order
        history = invocation.view.close_history(asset)
        if not history:
            invocation.trace("data.missing_asset", {"asset": asset})
        series[asset] = list(history)
    return {"series": TimeSeriesValue.of(series)}


PRICE = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="data.price",
        type_version="1.0.0",
        inputs=(InputPortSpec(name="assets", port_type=AssetSetType(kind="AssetSet")),),
        outputs=(
            OutputPortSpec(
                name="series", port_type=TimeSeriesType(kind="TimeSeries", dtype="Number")
            ),
        ),
        metadata=NodeMetadata(
            display_name="Price History",
            description=(
                "Per-asset close-price history visible at the evaluation instant "
                "(availability-gated; assets without data keep an empty history)."
            ),
        ),
        parameter_schema=JsonSchemaSpec({"type": "object", "additionalProperties": False}),
    ),
    evaluate=_evaluate,
)
