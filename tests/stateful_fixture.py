"""M8 test-only stateful accumulator node (STRATEGY_LANGUAGE §5).

Defined in the TEST SUITE, never the product registry: v0 ships no stateful nodes and the
engine has no stateful-state plumbing — this node exercises TIMING equivalence between the
historical and forward modes, not checkpointable node state. It is an ``AssetSet`` passthrough
declaring ``purity="stateful"`` / cadence ``evaluation_only`` in its metadata; at every firing
it appends one trajectory row to a TEST-OWNED store:

    (evaluation instant, firing count, last visible session per asset, sum of visible closes)

The last-visible-session column doubles as the M8 direct lookahead witness: an evaluation at
session k must never have seen k+1. Build a FRESH catalog + store per run — a shared closure
would concatenate trajectories across runs and silently compare doubled lists.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime

from quantize.nodes import core_node_implementations
from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import (
    ImplementationCatalog,
    NodeImplementation,
    NodeInvocation,
)
from quantize.runtime.values import AssetSetValue, RuntimeValue
from quantize.schema.types import AssetSetType

ACCUMULATOR_TYPE_ID = "test.accumulator"


@dataclass(frozen=True)
class TrajectoryPoint:
    instant: datetime
    count: int
    last_visible: tuple[tuple[str, date], ...]  # per asset — the lookahead witness
    close_sum: float


@dataclass
class TrajectoryStore:
    """The test-owned serializable state of the accumulator (one per run)."""

    points: list[TrajectoryPoint] = field(default_factory=list)


def build_accumulator_catalog() -> tuple[ImplementationCatalog, TrajectoryStore]:
    """Core catalog + the test-only stateful accumulator, with a FRESH trajectory store."""
    store = TrajectoryStore()
    asset_set = AssetSetType(kind="AssetSet")

    def evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        assets = invocation.inputs["assets"]
        assert isinstance(assets, AssetSetValue)
        last_visible: list[tuple[str, date]] = []
        close_sum = 0.0
        for asset in assets.assets:  # canonical order — deterministic
            history = invocation.view.close_history(asset)
            if history:
                last_visible.append((asset, history[-1][0]))
                close_sum += history[-1][1]
        store.points.append(
            TrajectoryPoint(
                instant=invocation.view.instant,
                count=len(store.points) + 1,
                last_visible=tuple(last_visible),
                close_sum=close_sum,
            )
        )
        return {"assets": assets}

    descriptor = NodeDescriptor(
        type_id=ACCUMULATOR_TYPE_ID,
        type_version="1.0.0",
        inputs=(InputPortSpec(name="assets", port_type=asset_set),),
        outputs=(OutputPortSpec(name="assets", port_type=asset_set),),
        metadata=NodeMetadata(
            display_name="Test accumulator",
            description=(
                "TEST-ONLY stateful counter/accumulator (purity=stateful, "
                "cadence=evaluation_only); exercises M8 timing equivalence."
            ),
            category="transform",
        ),
        parameter_schema=JsonSchemaSpec({"type": "object", "additionalProperties": False}),
    )
    catalog = ImplementationCatalog()
    for implementation in core_node_implementations():
        catalog.register(implementation)
    catalog.register(NodeImplementation(descriptor=descriptor, evaluate=evaluate))
    return catalog, store
