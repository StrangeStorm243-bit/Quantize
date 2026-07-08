"""``universe.fixed_list`` — a fixed asset universe, emitted in canonical order."""

from __future__ import annotations

from collections.abc import Mapping

from quantize.registry.descriptor import (
    NodeDescriptor,
    NodeDoc,
    NodeMetadata,
    OutputPortSpec,
    ParamDoc,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import AssetSetValue, RuntimeValue
from quantize.schema.types import AssetSetType
from quantize.tracing.spec import ASSET_LIST, TraceEventSpec, combined_trace_schema

_TRACE_EVENTS = (TraceEventSpec.of("universe.selected", 1, {"assets": ASSET_LIST}, ("assets",)),)


def _evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    tickers = invocation.params["tickers"]
    assert isinstance(tickers, list)
    assets = [ticker for ticker in tickers if isinstance(ticker, str)]
    # Canonical (ascending ticker) order is applied by AssetSetValue itself.
    value = AssetSetValue.of(assets)
    invocation.trace("universe.selected", {"v": 1, "assets": list(value.assets)})
    return {"assets": value}


FIXED_LIST = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="universe.fixed_list",
        type_version="1.0.0",
        inputs=(),
        outputs=(OutputPortSpec(name="assets", port_type=AssetSetType(kind="AssetSet")),),
        metadata=NodeMetadata(
            display_name="Fixed Universe",
            description="A fixed list of asset tickers, emitted in canonical (ascending) order.",
            category="universe",
            doc=NodeDoc(
                summary=(
                    "Defines the machine's investable universe — the fixed set of asset tickers "
                    "every downstream stage is allowed to consider. This is where the strategy "
                    "declares what it can trade."
                ),
                semantics=(
                    "Emits the tickers in canonical (ascending) order. Reads no market data; the "
                    "list is taken verbatim from the tickers parameter."
                ),
                parameters={
                    "tickers": ParamDoc(
                        label="Tickers",
                        help="Asset symbols in the universe (e.g. SPY, QQQ); emitted ascending.",
                    ),
                },
            ),
        ),
        parameter_schema=JsonSchemaSpec(
            {
                "type": "object",
                "properties": {
                    "tickers": {
                        "type": "array",
                        "items": {"type": "string", "minLength": 1},
                        "minItems": 1,
                        "uniqueItems": True,
                    }
                },
                "required": ["tickers"],
                "additionalProperties": False,
            }
        ),
        trace_schema=combined_trace_schema(_TRACE_EVENTS),
        trace_events=_TRACE_EVENTS,
    ),
    evaluate=_evaluate,
)
