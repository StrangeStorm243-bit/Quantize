"""Synthetic node descriptors and documents for registry/semantic tests. NOT real product nodes."""

from collections.abc import Sequence
from datetime import UTC, datetime

from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.registry import NodeRegistry
from quantize.schema.components import ComponentRef
from quantize.schema.document import (
    ExecutionPolicy,
    StrategyDocument,
    StrategyMeta,
    TransactionCosts,
)
from quantize.schema.nodes import ComponentRefNode, Edge, NodeInstance, RegisteredNode
from quantize.schema.provenance import Provenance, StrategyForkRef
from quantize.schema.schedule import ScheduleDaily
from quantize.schema.types import (
    AssetSetType,
    CrossSectionType,
    PortfolioTargetsType,
    PortType,
    ScalarType,
    TimeSeriesType,
)

_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")
_CS_BOOL = CrossSectionType(kind="CrossSection", dtype="Boolean")
_SCALAR_NUM = ScalarType(kind="Scalar", dtype="Number")
_AS = AssetSetType(kind="AssetSet")
_TS_NUM = TimeSeriesType(kind="TimeSeries", dtype="Number")
_PT = PortfolioTargetsType(kind="PortfolioTargets")

_OWNER = "22222222-2222-2222-2222-222222222222"


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


def _tsource() -> NodeDescriptor:
    return NodeDescriptor(
        type_id="test.tsource",
        type_version="1.0.0",
        inputs=(),
        outputs=(OutputPortSpec(name="out", port_type=_TS_NUM),),
        metadata=NodeMetadata(display_name="TSource", description="Synthetic TimeSeries source."),
    )


def build_fixture_registry() -> NodeRegistry:
    registry = NodeRegistry()
    registry.register(_source("1.0.0"))
    registry.register(_source("1.1.0"))
    registry.register(_sink())
    registry.register(_tsource())
    return registry


# --- synthetic strategy documents (real StrategyDocument, not dicts) -------------------------


def _provenance() -> Provenance[StrategyForkRef]:
    return Provenance[StrategyForkRef](
        owner=_OWNER,
        creator=_OWNER,
        contributors=[],
        visibility="private",
        duplicable=False,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )


def _document(
    nodes: list[NodeInstance],
    edges: list[Edge],
    component_refs: list[ComponentRef] | None = None,
) -> StrategyDocument:
    return StrategyDocument(
        schema_version="0.1.0",
        strategy=StrategyMeta(id=_OWNER, version=1, name="fixture", provenance=_provenance()),
        execution_policy=ExecutionPolicy(
            policy="close_signal_next_session_open",
            valuation="session_close",
            transaction_costs=TransactionCosts(model="bps", bps=5),
        ),
        schedule=ScheduleDaily(kind="daily"),
        nodes=nodes,
        edges=edges,
        component_refs=component_refs or [],
    )


def build_wired_document(
    *,
    source_type_version: str = "1.0.0",
    sink_in_port: str = "in",
    source_out_port: str = "out",
) -> StrategyDocument:
    """A real StrategyDocument wiring test.source.out -> test.sink.in (endpoints overridable)."""
    nodes: list[NodeInstance] = [
        RegisteredNode(id="s", type_id="test.source", type_version=source_type_version, params={}),
        RegisteredNode(id="k", type_id="test.sink", type_version="1.0.0", params={}),
    ]
    edges = [Edge.model_validate({"from": ("s", source_out_port), "to": ("k", sink_in_port)})]
    return _document(nodes, edges)


def build_unknown_source_document() -> StrategyDocument:
    """An unknown-type source feeding test.sink.in: connectivity is satisfied though the source
    fails resolution (exercises the no-cascade connectivity rule)."""
    nodes: list[NodeInstance] = [
        RegisteredNode(id="s", type_id="unknown.thing", type_version="1.0.0", params={}),
        RegisteredNode(id="k", type_id="test.sink", type_version="1.0.0", params={}),
    ]
    edges = [Edge.model_validate({"from": ("s", "out"), "to": ("k", "in")})]
    return _document(nodes, edges)


def build_incompatible_document() -> StrategyDocument:
    """Incompatible edge: a TimeSeries[Number] output wired into a CrossSection[Number] input."""
    nodes: list[NodeInstance] = [
        RegisteredNode(id="s", type_id="test.tsource", type_version="1.0.0", params={}),
        RegisteredNode(id="k", type_id="test.sink", type_version="1.0.0", params={}),
    ]
    edges = [Edge.model_validate({"from": ("s", "out"), "to": ("k", "in")})]
    return _document(nodes, edges)


def build_component_edge_document(*, sink_in_port: str = "in") -> StrategyDocument:
    """A component node's output feeding test.sink. The component endpoint is skipped (not
    registry-resolved), but the registered sink endpoint's port name is still validated."""
    nodes: list[NodeInstance] = [
        ComponentRefNode(id="c", type_id="component", ref="r", params={}),
        RegisteredNode(id="k", type_id="test.sink", type_version="1.0.0", params={}),
    ]
    edges = [Edge.model_validate({"from": ("c", "out"), "to": ("k", sink_in_port)})]
    refs = [
        ComponentRef(id="r", component_id="33333333-3333-3333-3333-333333333333", version="1.0.0")
    ]
    return _document(nodes, edges, refs)


# --- reference-strategy registry (descriptor doubles for Strategy A & B node types) ----------
# Port NAMES match the committed strategy_a.json / strategy_b.json edges exactly; port TYPES are the
# plausible STRATEGY_LANGUAGE.md lattice types (M2.2 checks names, not types; M2.3 will reuse this).

_PortList = Sequence[tuple[str, PortType]]


def _ref(type_id: str, inputs: _PortList, outputs: _PortList) -> NodeDescriptor:
    return NodeDescriptor(
        type_id=type_id,
        type_version="1.0.0",
        inputs=tuple(InputPortSpec(name=n, port_type=t) for n, t in inputs),
        outputs=tuple(OutputPortSpec(name=n, port_type=t) for n, t in outputs),
        metadata=NodeMetadata(display_name=type_id, description=type_id),
    )


def build_reference_registry() -> NodeRegistry:
    registry = NodeRegistry()
    for descriptor in (
        _ref("universe.fixed_list", [], [("assets", _AS)]),
        _ref("data.price", [("assets", _AS)], [("series", _TS_NUM)]),
        _ref("transform.trailing_return", [("series", _TS_NUM)], [("values", _CS_NUM)]),
        _ref("transform.rank", [("values", _CS_NUM)], [("values", _CS_NUM)]),
        _ref(
            "portfolio.select_top_n",
            [("scores", _CS_NUM), ("universe", _AS)],
            [("assets", _AS)],
        ),
        _ref("portfolio.equal_weight", [("assets", _AS)], [("targets", _PT)]),
        _ref("risk.max_weight", [("targets", _PT)], [("targets", _PT)]),
        _ref("output.target_portfolio", [("targets", _PT)], []),
        _ref("transform.moving_average", [("series", _TS_NUM)], [("series", _TS_NUM)]),
        _ref("transform.latest", [("series", _TS_NUM)], [("values", _CS_NUM)]),
        _ref(
            "logic.greater_than",
            [("left", _CS_NUM), ("right", _CS_NUM)],
            [("values", _CS_BOOL)],
        ),
        _ref("portfolio.fixed_weight", [("assets", _AS)], [("targets", _PT)]),
        _ref(
            "portfolio.apply_mask",
            [("targets", _PT), ("mask", _CS_BOOL)],
            [("targets", _PT)],
        ),
    ):
        registry.register(descriptor)
    return registry
