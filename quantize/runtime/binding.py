"""Executable node bindings and the implementation catalog (M3).

A ``NodeImplementation`` pairs a static M2 ``NodeDescriptor`` with the executable contract the
evaluator invokes: a pure ``evaluate`` function over a ``NodeInvocation``, an honest purity
declaration (v0 ships only pure nodes), and the node's declared warm-up (sessions of history
needed, as a function of params).

The ``ImplementationCatalog`` mirrors the M2 ``NodeRegistry``: explicit in-memory registration,
exact ``(type_id, type_version)`` resolution (never "latest"), non-throwing lookup, loud duplicate
registration. It also *owns* a descriptor registry derived from its bindings, so semantic
validation and execution can never disagree about a node type's contract.

The binding is deliberately a boundary, not a base class: future implementation forms (formulas,
sandboxed code, model artifacts, external services) become new ways to *construct* a
``NodeImplementation``, without the evaluator changing.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Literal

from quantize.market.data import DataView
from quantize.registry.descriptor import NodeDescriptor
from quantize.registry.errors import DuplicateRegistrationError
from quantize.registry.registry import (
    NodeRegistry,
    NodeRegistryView,
    NodeResolution,
    ResolutionStatus,
)
from quantize.runtime.values import RuntimeValue
from quantize.schema.primitives import JsonValue
from quantize.tracing.recorder import TraceSink


@dataclass(frozen=True)
class NodeInvocation:
    """Everything one node evaluation may see — nothing else is reachable.

    ``params`` are the node's effective parameters (instance params, after any component
    parameter binding). ``inputs`` holds runtime values keyed by input-port name; optional
    unconnected ports are absent. ``view`` is the availability-gated as-of ``DataView``.
    ``trace`` is bound to this node's identity and the run's deterministic timestamp.
    """

    node_id: str
    component_path: tuple[str, ...]
    params: Mapping[str, JsonValue]
    inputs: Mapping[str, RuntimeValue]
    view: DataView
    trace: TraceSink


EvaluateFn = Callable[[NodeInvocation], Mapping[str, RuntimeValue]]
WarmupFn = Callable[[Mapping[str, JsonValue]], int]


def _no_warmup(params: Mapping[str, JsonValue]) -> int:
    return 0


@dataclass(frozen=True)
class NodeImplementation:
    """One node type's executable contract, keyed by its descriptor's exact identity."""

    descriptor: NodeDescriptor
    evaluate: EvaluateFn
    purity: Literal["pure"] = "pure"  # v0 ships no stateful nodes; the field keeps this honest
    warmup: WarmupFn = field(default=_no_warmup)

    @property
    def type_id(self) -> str:
        return self.descriptor.type_id

    @property
    def type_version(self) -> str:
        return self.descriptor.type_version


@dataclass(frozen=True)
class _ReadOnlyRegistry:
    """A runtime-enforced read-only facade over the catalog's descriptor registry.

    ``NodeRegistryView`` is a typing Protocol, so returning the mutable ``NodeRegistry`` typed as
    the view would still allow mutation at runtime; this facade exposes only the read surface.
    """

    _registry: NodeRegistry

    def resolve(self, type_id: str, type_version: str) -> NodeResolution:
        return self._registry.resolve(type_id, type_version)

    def contains(self, type_id: str, type_version: str) -> bool:
        return self._registry.contains(type_id, type_version)


@dataclass(frozen=True)
class ImplementationResolution:
    """The outcome of resolving a ``(type_id, type_version)`` against the catalog."""

    status: ResolutionStatus
    implementation: NodeImplementation | None = None
    available_versions: tuple[str, ...] = ()


class ImplementationCatalog:
    """Explicit in-memory catalog of executable bindings keyed by ``(type_id, type_version)``."""

    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str], NodeImplementation] = {}
        self._descriptors = NodeRegistry()

    def register(self, implementation: NodeImplementation) -> None:
        key = (implementation.type_id, implementation.type_version)
        if key in self._by_key:
            raise DuplicateRegistrationError(*key)
        # Register the descriptor first: it shares the duplicate check and keeps the two
        # catalogs in lockstep (a binding is never visible without its descriptor).
        self._descriptors.register(implementation.descriptor)
        self._by_key[key] = implementation

    def resolve(self, type_id: str, type_version: str) -> ImplementationResolution:
        implementation = self._by_key.get((type_id, type_version))
        if implementation is not None:
            return ImplementationResolution(ResolutionStatus.OK, implementation, ())
        versions = tuple(sorted(version for (tid, version) in self._by_key if tid == type_id))
        if not versions:
            return ImplementationResolution(ResolutionStatus.UNKNOWN_TYPE, None, ())
        return ImplementationResolution(ResolutionStatus.VERSION_UNAVAILABLE, None, versions)

    def contains(self, type_id: str, type_version: str) -> bool:
        return (type_id, type_version) in self._by_key

    @property
    def descriptor_registry(self) -> NodeRegistryView:
        """The read-only descriptor registry derived from the registered bindings."""
        return _ReadOnlyRegistry(self._descriptors)

    def implementations(self) -> tuple[NodeImplementation, ...]:
        return tuple(self._by_key[key] for key in sorted(self._by_key))
