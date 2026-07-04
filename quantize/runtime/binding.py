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
from datetime import datetime
from typing import Any, Literal

from quantize.market.data import DataView
from quantize.registry.descriptor import NodeDescriptor
from quantize.registry.errors import DuplicateRegistrationError
from quantize.registry.registry import (
    NodeRegistry,
    NodeRegistryView,
    NodeResolution,
    ResolutionStatus,
    semantic_version_sort_key,
)
from quantize.runtime.values import RuntimeValue
from quantize.schema.primitives import JsonValue
from quantize.tracing.recorder import TraceSink


class EvaluationMemo:
    """Run-scoped, SPEED-ONLY reuse channel for pure nodes (pre-M9 remediation, C1).

    A pure node may stash intermediate results that are provably immutable for the REST of the
    run — e.g. a moving-average point whose whole window is visible: visibility is monotone in
    the cutoff and the dataset is frozen, so recomputation would be bit-identical. The memo can
    therefore never affect WHAT a run produces, only how fast (the engine's memo-on/memo-off
    bit-exactness battery proves it).

    Safety contract: one memo per (run, dataset), created and owned by the engine — never
    global, never shared across runs. Because a cached point is only guaranteed visible at the
    instant that computed it AND LATER, the memo refuses non-monotonic use loudly: feeding a
    strictly earlier evaluation instant is a programming error, not a recoverable state (a
    stale-cutoff read-through would be look-ahead).
    """

    def __init__(self) -> None:
        self._slots: dict[tuple[object, ...], dict[Any, Any]] = {}
        self._high_water: datetime | None = None

    def assert_monotonic(self, instant: datetime) -> None:
        """Reject a strictly earlier evaluation instant (see the class safety contract)."""
        if self._high_water is not None and instant < self._high_water:
            raise ValueError(
                "EvaluationMemo requires non-decreasing evaluation instants: "
                f"{instant.isoformat()} < {self._high_water.isoformat()}"
            )
        self._high_water = instant

    def slot(self, *key: object) -> dict[Any, Any]:
        """The mutable dict owned by *key* (namespace + node path + node-chosen parts)."""
        slot = self._slots.get(key)
        if slot is None:
            slot = {}
            self._slots[key] = slot
        return slot

    def is_empty(self) -> bool:
        return not self._slots


@dataclass(frozen=True)
class NodeInvocation:
    """Everything one node evaluation may see — nothing else is reachable.

    ``params`` are the node's effective parameters (instance params, after any component
    parameter binding). ``inputs`` holds runtime values keyed by input-port name; optional
    unconnected ports are absent. ``view`` is the availability-gated as-of ``DataView``.
    ``trace`` is bound to this node's identity and the run's deterministic timestamp.
    ``memo`` is the run's optional speed-only reuse channel (``EvaluationMemo``); a node must
    behave bit-identically with and without it.
    """

    node_id: str
    component_path: tuple[str, ...]
    params: Mapping[str, JsonValue]
    inputs: Mapping[str, RuntimeValue]
    view: DataView
    trace: TraceSink
    memo: EvaluationMemo | None = None


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
        versions = tuple(
            sorted(
                (version for (tid, version) in self._by_key if tid == type_id),
                key=semantic_version_sort_key,
            )
        )
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

    def descriptors(self) -> tuple[NodeDescriptor, ...]:
        """The registered descriptors, sorted by ``(type_id, type_version)`` (via the registry)."""
        return self._descriptors.descriptors()
