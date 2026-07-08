"""M2.1 — errors, NodeResolution, NodeRegistry, and the NodeRegistryView Protocol."""

import pytest

from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.errors import DuplicateRegistrationError
from quantize.registry.registry import (
    NodeRegistry,
    NodeRegistryView,
    NodeResolution,
    ResolutionStatus,
)
from quantize.schema.types import CrossSectionType

_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")


def _descriptor(version: str = "1.0.0") -> NodeDescriptor:
    return NodeDescriptor(
        type_id="test.source",
        type_version=version,
        inputs=(),
        outputs=(OutputPortSpec(name="out", port_type=_CS_NUM),),
        metadata=NodeMetadata(
            display_name="Source", description="Synthetic.", category="transform"
        ),
    )


def _sink() -> NodeDescriptor:
    return NodeDescriptor(
        type_id="test.sink",
        type_version="1.0.0",
        inputs=(InputPortSpec(name="in", port_type=_CS_NUM),),
        outputs=(),
        metadata=NodeMetadata(display_name="Sink", description="Synthetic.", category="transform"),
    )


def _registry() -> NodeRegistry:
    r = NodeRegistry()
    r.register(_descriptor("1.0.0"))
    r.register(_descriptor("1.1.0"))
    r.register(_sink())
    return r


# --- NodeResolution invariants ---------------------------------------------------------------


def test_ok_resolution_carries_descriptor_and_no_versions() -> None:
    r = NodeResolution.ok(_descriptor())
    assert r.status is ResolutionStatus.OK
    assert r.descriptor is not None
    assert r.available_versions == ()


def test_unknown_type_resolution_is_empty() -> None:
    r = NodeResolution.unknown_type()
    assert r.status is ResolutionStatus.UNKNOWN_TYPE
    assert r.descriptor is None and r.available_versions == ()


def test_version_unavailable_sorts_versions_and_has_no_descriptor() -> None:
    r = NodeResolution.version_unavailable(("1.1.0", "1.0.0"))
    assert r.status is ResolutionStatus.VERSION_UNAVAILABLE
    assert r.descriptor is None
    assert r.available_versions == ("1.0.0", "1.1.0")


def test_invalid_ok_resolution_is_rejected() -> None:
    with pytest.raises(ValueError):
        NodeResolution(ResolutionStatus.OK, None, ())


def test_non_enum_status_is_rejected() -> None:
    with pytest.raises(ValueError):
        NodeResolution("bad")  # type: ignore[arg-type]


def test_version_unavailable_requires_at_least_one_version() -> None:
    with pytest.raises(ValueError):
        NodeResolution.version_unavailable(())


# --- NodeRegistry ----------------------------------------------------------------------------


def test_register_then_resolve_ok() -> None:
    res = _registry().resolve("test.source", "1.0.0")
    assert res.status is ResolutionStatus.OK
    assert res.descriptor is not None and res.descriptor.type_version == "1.0.0"


def test_duplicate_registration_raises() -> None:
    r = NodeRegistry()
    r.register(_descriptor("1.0.0"))
    with pytest.raises(DuplicateRegistrationError):
        r.register(_descriptor("1.0.0"))


def test_resolve_unknown_type() -> None:
    res = _registry().resolve("test.missing", "1.0.0")
    assert res.status is ResolutionStatus.UNKNOWN_TYPE
    assert res.descriptor is None and res.available_versions == ()


def test_resolve_version_unavailable_reports_sorted_versions() -> None:
    res = _registry().resolve("test.source", "9.9.9")
    assert res.status is ResolutionStatus.VERSION_UNAVAILABLE
    assert res.available_versions == ("1.0.0", "1.1.0")


def test_resolve_is_exact_no_fallback() -> None:
    res = _registry().resolve("test.source", "1.0.1")  # must NOT fall back to 1.0.0
    assert res.status is ResolutionStatus.VERSION_UNAVAILABLE


def test_contains() -> None:
    r = _registry()
    assert r.contains("test.source", "1.0.0") is True
    assert r.contains("test.source", "2.0.0") is False


def test_descriptors_sorted_by_type_id_then_version() -> None:
    keys = [(d.type_id, d.type_version) for d in _registry().descriptors()]
    assert keys == sorted(keys)


def test_available_versions_order_is_semantic_not_lexical() -> None:
    """1.9.0 < 1.10.0 < 2.0.0 — numeric component order, deterministic, multi-major; and
    exact resolution stays mandatory (the ordering is DISPLAY-ONLY, never a fallback)."""
    r = NodeRegistry()
    for version in ("1.10.0", "2.0.0", "1.9.0", "10.0.1"):
        r.register(_descriptor(version))
    assert r.available_versions("test.source") == ("1.9.0", "1.10.0", "2.0.0", "10.0.1")
    assert r.available_versions("test.source") == r.available_versions("test.source")
    # No "latest" behavior crept in: an inexact version still refuses to resolve.
    assert r.resolve("test.source", "1.9.1").status is ResolutionStatus.VERSION_UNAVAILABLE


def test_catalog_available_versions_order_matches_the_registry() -> None:
    """The ImplementationCatalog twin (binding.py) uses the same semantic ordering."""
    from quantize.runtime.binding import ImplementationCatalog, NodeImplementation

    catalog = ImplementationCatalog()
    for version in ("1.10.0", "1.9.0"):
        catalog.register(
            NodeImplementation(descriptor=_descriptor(version), evaluate=lambda invocation: {})
        )
    resolution = catalog.resolve("test.source", "9.9.9")
    assert resolution.available_versions == ("1.9.0", "1.10.0")


# --- NodeRegistryView (DI) -------------------------------------------------------------------


def _consume(view: NodeRegistryView, type_id: str, version: str) -> ResolutionStatus:
    return view.resolve(type_id, version).status


def test_concrete_registry_satisfies_view_protocol() -> None:
    # mypy verifies the *structural* conformance via this assignment; the assert checks behavior.
    view: NodeRegistryView = _registry()
    assert _consume(view, "test.source", "1.0.0") is ResolutionStatus.OK


def test_view_accepts_a_minimal_fake() -> None:
    class _Fake:
        def resolve(self, type_id: str, type_version: str) -> NodeResolution:
            return NodeResolution.unknown_type()

        def contains(self, type_id: str, type_version: str) -> bool:
            return False

    assert _consume(_Fake(), "x.y", "1.0.0") is ResolutionStatus.UNKNOWN_TYPE
