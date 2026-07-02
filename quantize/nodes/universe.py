"""``universe.fixed_list`` — a fixed asset universe, emitted in canonical order."""

from __future__ import annotations

from collections.abc import Mapping

from quantize.registry.descriptor import NodeDescriptor, NodeMetadata, OutputPortSpec
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import AssetSetValue, RuntimeValue
from quantize.schema.types import AssetSetType


def _evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    tickers = invocation.params["tickers"]
    assert isinstance(tickers, list)
    assets = [ticker for ticker in tickers if isinstance(ticker, str)]
    # Canonical (ascending ticker) order is applied by AssetSetValue itself.
    return {"assets": AssetSetValue.of(assets)}


FIXED_LIST = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="universe.fixed_list",
        type_version="1.0.0",
        inputs=(),
        outputs=(OutputPortSpec(name="assets", port_type=AssetSetType(kind="AssetSet")),),
        metadata=NodeMetadata(
            display_name="Fixed Universe",
            description="A fixed list of asset tickers, emitted in canonical (ascending) order.",
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
    ),
    evaluate=_evaluate,
)
