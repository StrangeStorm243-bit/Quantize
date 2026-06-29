"""Synthetic node descriptors for registry tests. NOT real product nodes."""

from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.registry import NodeRegistry
from quantize.schema.types import CrossSectionType, ScalarType

_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")
_SCALAR_NUM = ScalarType(kind="Scalar", dtype="Number")


def _source(version: str) -> NodeDescriptor:
    return NodeDescriptor(
        type_id="test.source",
        type_version=version,
        inputs=(),
        outputs=(OutputPortSpec(name="out", port_type=_CS_NUM),),
        metadata=NodeMetadata(display_name="Source", description="Synthetic source."),
    )


def _sink() -> NodeDescriptor:
    return NodeDescriptor(
        type_id="test.sink",
        type_version="1.0.0",
        inputs=(
            InputPortSpec(name="in", port_type=_CS_NUM),
            InputPortSpec(name="opt", port_type=_SCALAR_NUM, required=False),
        ),
        outputs=(),
        metadata=NodeMetadata(display_name="Sink", description="Synthetic sink."),
    )


def build_fixture_registry() -> NodeRegistry:
    registry = NodeRegistry()
    registry.register(_source("1.0.0"))
    registry.register(_source("1.1.0"))
    registry.register(_sink())
    return registry
