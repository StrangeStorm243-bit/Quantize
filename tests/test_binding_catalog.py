"""M3: executable binding catalog — exact resolution, duplicate rejection, descriptor lockstep."""

from __future__ import annotations

from collections.abc import Mapping

import pytest

from quantize.registry.descriptor import NodeDescriptor, NodeMetadata, OutputPortSpec
from quantize.registry.errors import DuplicateRegistrationError
from quantize.registry.registry import ResolutionStatus
from quantize.runtime.binding import (
    ImplementationCatalog,
    NodeImplementation,
    NodeInvocation,
)
from quantize.runtime.values import RuntimeValue, ScalarValue
from quantize.schema.primitives import JsonValue
from quantize.schema.types import ScalarType


def _descriptor(type_id: str = "test.const", version: str = "1.0.0") -> NodeDescriptor:
    return NodeDescriptor(
        type_id=type_id,
        type_version=version,
        inputs=(),
        outputs=(OutputPortSpec(name="out", port_type=ScalarType(kind="Scalar", dtype="Number")),),
        metadata=NodeMetadata(
            display_name="Const", description="Synthetic constant.", category="transform"
        ),
    )


def _evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    return {"out": ScalarValue(dtype="Number", value=1.0)}


def _implementation(type_id: str = "test.const", version: str = "1.0.0") -> NodeImplementation:
    return NodeImplementation(descriptor=_descriptor(type_id, version), evaluate=_evaluate)


def test_resolve_exact_version_only() -> None:
    catalog = ImplementationCatalog()
    catalog.register(_implementation(version="1.0.0"))
    catalog.register(_implementation(version="1.1.0"))

    ok = catalog.resolve("test.const", "1.1.0")
    assert ok.status is ResolutionStatus.OK
    assert ok.implementation is not None
    assert ok.implementation.type_version == "1.1.0"

    unavailable = catalog.resolve("test.const", "2.0.0")
    assert unavailable.status is ResolutionStatus.VERSION_UNAVAILABLE
    assert unavailable.implementation is None
    assert unavailable.available_versions == ("1.0.0", "1.1.0")

    unknown = catalog.resolve("test.other", "1.0.0")
    assert unknown.status is ResolutionStatus.UNKNOWN_TYPE
    assert unknown.available_versions == ()


def test_duplicate_registration_fails_loud() -> None:
    catalog = ImplementationCatalog()
    catalog.register(_implementation())
    with pytest.raises(DuplicateRegistrationError):
        catalog.register(_implementation())


def test_descriptor_registry_stays_in_lockstep() -> None:
    catalog = ImplementationCatalog()
    catalog.register(_implementation())
    resolution = catalog.descriptor_registry.resolve("test.const", "1.0.0")
    assert resolution.status is ResolutionStatus.OK
    assert resolution.descriptor is not None
    assert resolution.descriptor.type_id == "test.const"


def test_descriptor_registry_is_read_only_at_runtime() -> None:
    catalog = ImplementationCatalog()
    catalog.register(_implementation())
    view = catalog.descriptor_registry
    assert not hasattr(view, "register")  # runtime-enforced, not just typing discipline
    assert view.contains("test.const", "1.0.0")
    assert not view.contains("test.const", "9.9.9")


def test_implementation_defaults_are_pure_with_zero_warmup() -> None:
    implementation = _implementation()
    params: Mapping[str, JsonValue] = {}
    assert implementation.purity == "pure"
    assert implementation.warmup(params) == 0


def test_implementations_listing_is_sorted() -> None:
    catalog = ImplementationCatalog()
    catalog.register(_implementation("test.b_node"))
    catalog.register(_implementation("test.a_node"))
    assert [i.type_id for i in catalog.implementations()] == ["test.a_node", "test.b_node"]
