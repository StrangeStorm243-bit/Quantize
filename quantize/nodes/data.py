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
    NodeDoc,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import AssetSetValue, RuntimeValue, TimeSeriesValue
from quantize.schema.primitives import JsonValue
from quantize.schema.types import AssetSetType, TimeSeriesType
from quantize.tracing.spec import STRING, TraceEventSpec, combined_trace_schema

_TRACE_EVENTS = (
    TraceEventSpec.of("data.missing_asset", 1, {"asset": STRING}, ("asset",)),
    TraceEventSpec.of(
        "data.observed",
        1,
        {
            "per_asset": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "asset": STRING,
                        "observations": {"type": "integer", "minimum": 0},
                        "first": {"type": ["string", "null"]},
                        "last": {"type": ["string", "null"]},
                    },
                    "required": ["asset", "observations", "first", "last"],
                    "additionalProperties": False,
                },
            }
        },
        ("per_asset",),
    ),
)


def _evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    assets = invocation.inputs["assets"]
    assert isinstance(assets, AssetSetValue)
    series: dict[str, list[tuple[date, float]]] = {}
    observed: list[JsonValue] = []
    for asset in assets.assets:  # canonical order
        history = invocation.view.close_history(asset)
        if not history:
            invocation.trace("data.missing_asset", {"v": 1, "asset": asset})
        series[asset] = list(history)
        observed.append(
            {
                "asset": asset,
                "observations": len(history),
                "first": history[0][0].isoformat() if history else None,
                "last": history[-1][0].isoformat() if history else None,
            }
        )
    # Inputs observed, bounded: per-asset counts + endpoint dates — never the series itself.
    invocation.trace("data.observed", {"v": 1, "per_asset": observed})
    # Histories are verbatim DataView tuples (validated once at dataset construction), so the
    # trusted constructor skips only the duplicate per-point re-validation (pre-M9 C3).
    return {"series": TimeSeriesValue.from_view_history(series)}


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
            category="data",
            doc=NodeDoc(
                summary=(
                    "The machine's data entry point — loads each universe asset's close-price "
                    "history as it was known at the evaluation instant. Everything the strategy "
                    "computes flows from here."
                ),
                semantics=(
                    "Availability-gated: only observations knowable at or before the evaluation "
                    "instant are visible (no look-ahead). An asset with no visible observations "
                    "keeps an empty history rather than being dropped; nothing is forward-filled."
                ),
            ),
        ),
        parameter_schema=JsonSchemaSpec({"type": "object", "additionalProperties": False}),
        trace_schema=combined_trace_schema(_TRACE_EVENTS),
        trace_events=_TRACE_EVENTS,
    ),
    evaluate=_evaluate,
)
