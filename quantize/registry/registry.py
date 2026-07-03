"""The node-type registry: an explicit in-memory catalog, a non-throwing resolution result, and a
narrow read-only injection Protocol.

The registry gives the open ``type_id`` (M1) its meaning. Lookup is non-throwing so a later semantic
validator can accumulate deterministic diagnostics; registration misuse (a duplicate key) fails loud
via ``DuplicateRegistrationError``. Version resolution is exact: a pinned IR node matches its exact
``(type_id, type_version)`` or yields ``VERSION_UNAVAILABLE`` — never latest, ranges, or fallback.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from quantize.registry.descriptor import NodeDescriptor
from quantize.registry.errors import DuplicateRegistrationError


def semantic_version_sort_key(version: str) -> tuple[int, tuple[int, ...], str]:
    """Sort key ordering ``X.Y.Z`` versions numerically (1.9.0 < 1.10.0 < 2.0.0).

    DISPLAY ordering only — resolution stays exact-match. A key that is not plain dotted
    integers (none exist in v0; prereleases are outside the current version contract) sorts
    after the conforming ones, lexically, so nothing is ever dropped or mis-grouped.
    """
    parts = version.split(".")
    if parts and all(part.isdigit() for part in parts):
        return (0, tuple(int(part) for part in parts), version)
    return (1, (), version)


class ResolutionStatus(Enum):
    """The kind of outcome of resolving a node type against the registry."""

    OK = "ok"
    UNKNOWN_TYPE = "unknown_type"
    VERSION_UNAVAILABLE = "version_unavailable"


@dataclass(frozen=True)
class NodeResolution:
    """The outcome of resolving a ``(type_id, type_version)`` against the registry.

    Invariants (enforced in ``__post_init__``):

    * ``OK`` -> ``descriptor`` present and ``available_versions == ()``
    * ``UNKNOWN_TYPE`` -> ``descriptor is None`` and ``available_versions == ()``
    * ``VERSION_UNAVAILABLE`` -> ``descriptor is None`` and ``available_versions`` sorted
    """

    status: ResolutionStatus
    descriptor: NodeDescriptor | None = None
    available_versions: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.status, ResolutionStatus):
            raise ValueError(f"status must be a ResolutionStatus, got {self.status!r}")
        if self.status is ResolutionStatus.OK:
            if self.descriptor is None or self.available_versions != ():
                raise ValueError("OK resolution must carry a descriptor and no available_versions")
        elif self.status is ResolutionStatus.UNKNOWN_TYPE:
            if self.descriptor is not None or self.available_versions != ():
                raise ValueError("UNKNOWN_TYPE resolution must have no descriptor and no versions")
        else:  # VERSION_UNAVAILABLE
            if self.descriptor is not None:
                raise ValueError("VERSION_UNAVAILABLE resolution must have no descriptor")
            if not self.available_versions:
                raise ValueError("VERSION_UNAVAILABLE resolution must report >=1 available version")
            if list(self.available_versions) != sorted(
                self.available_versions, key=semantic_version_sort_key
            ):
                raise ValueError("available_versions must be in semantic version order")

    @classmethod
    def ok(cls, descriptor: NodeDescriptor) -> NodeResolution:
        return cls(ResolutionStatus.OK, descriptor, ())

    @classmethod
    def unknown_type(cls) -> NodeResolution:
        return cls(ResolutionStatus.UNKNOWN_TYPE, None, ())

    @classmethod
    def version_unavailable(cls, available_versions: tuple[str, ...]) -> NodeResolution:
        return cls(
            ResolutionStatus.VERSION_UNAVAILABLE,
            None,
            tuple(sorted(available_versions, key=semantic_version_sort_key)),
        )


class NodeRegistry:
    """Explicit, in-memory catalog of node descriptors keyed by ``(type_id, type_version)``."""

    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str], NodeDescriptor] = {}

    def register(self, descriptor: NodeDescriptor) -> None:
        key = (descriptor.type_id, descriptor.type_version)
        if key in self._by_key:
            raise DuplicateRegistrationError(descriptor.type_id, descriptor.type_version)
        self._by_key[key] = descriptor

    def resolve(self, type_id: str, type_version: str) -> NodeResolution:
        descriptor = self._by_key.get((type_id, type_version))
        if descriptor is not None:
            return NodeResolution.ok(descriptor)
        versions = self.available_versions(type_id)
        if not versions:
            return NodeResolution.unknown_type()
        return NodeResolution.version_unavailable(versions)

    def contains(self, type_id: str, type_version: str) -> bool:
        return (type_id, type_version) in self._by_key

    def available_versions(self, type_id: str) -> tuple[str, ...]:
        return tuple(
            sorted(
                (version for (tid, version) in self._by_key if tid == type_id),
                key=semantic_version_sort_key,
            )
        )

    def descriptors(self) -> tuple[NodeDescriptor, ...]:
        return tuple(self._by_key[key] for key in sorted(self._by_key))


class NodeRegistryView(Protocol):
    """Read-only registry surface consumers depend on.

    Deliberately omits ``register`` so a consumer (validator/evaluator) receives a read-only
    capability and cannot mutate the catalog while resolving — keeping semantic validation
    deterministic (same document + same view -> same diagnostics).
    """

    def resolve(self, type_id: str, type_version: str) -> NodeResolution: ...

    def contains(self, type_id: str, type_version: str) -> bool: ...
