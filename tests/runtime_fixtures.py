"""Synthetic node implementations and document/dataset builders for evaluator tests.

These establish the evaluator's *mechanics* (ordering, port mapping, failure handling,
determinism) independently of quantitative node correctness. NOT real product nodes.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime

from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataSet, PriceObservation
from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.runtime.binding import (
    EvaluateFn,
    ImplementationCatalog,
    NodeImplementation,
    NodeInvocation,
)
from quantize.runtime.values import AssetSetValue, PortfolioTargetsValue, RuntimeValue, ScalarValue
from quantize.schema.components import ComponentRef
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import Edge, NodeInstance, RegisteredNode
from quantize.schema.types import PortfolioTargetsType, ScalarType
from tests.registry_fixtures import _document

RUN_ID = "44444444-4444-4444-4444-444444444444"

_NUM = ScalarType(kind="Scalar", dtype="Number")
_PT = PortfolioTargetsType(kind="PortfolioTargets")

# The evaluation instant used by most evaluator tests: the close of the second session below.
EVAL_INSTANT = datetime(2026, 1, 6, 21, 0, tzinfo=UTC)


def two_session_dataset() -> MarketDataSet:
    """A minimal dataset (two sessions, one asset) so evaluator tests have a visible session."""
    sessions = tuple(
        MarketSession(
            session_date=day,
            open_at=datetime(day.year, day.month, day.day, 14, 30, tzinfo=UTC),
            close_at=datetime(day.year, day.month, day.day, 21, 0, tzinfo=UTC),
        )
        for day in (date(2026, 1, 5), date(2026, 1, 6))
    )
    calendar = ExchangeCalendar(exchange="QSE", timezone="UTC-05:00", sessions=sessions)
    observations = {
        "SPY": [
            PriceObservation(
                session_date=session.session_date,
                open_price=100.0,
                close_price=101.0,
                open_available_at=session.open_at,
                close_available_at=session.close_at,
            )
            for session in sessions
        ]
    }
    return MarketDataSet(calendar=calendar, observations=observations)


def _descriptor(
    type_id: str,
    inputs: tuple[InputPortSpec, ...],
    outputs: tuple[OutputPortSpec, ...],
    version: str = "1.0.0",
) -> NodeDescriptor:
    return NodeDescriptor(
        type_id=type_id,
        type_version=version,
        inputs=inputs,
        outputs=outputs,
        metadata=NodeMetadata(display_name=type_id, description=f"Synthetic {type_id}."),
    )


def _as_number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"expected a number param, got {type(value).__name__}")
    return float(value)


def build_synthetic_catalog(
    call_log: list[tuple[tuple[str, ...], str]] | None = None,
) -> ImplementationCatalog:
    """A fresh catalog of synthetic nodes. If *call_log* is given, every invocation appends
    ``(component_path, node_id)`` — the test-owned way to observe evaluation order without any
    global state."""

    def logged(evaluate: EvaluateFn) -> EvaluateFn:
        def wrapper(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
            if call_log is not None:
                call_log.append((invocation.component_path, invocation.node_id))
            return evaluate(invocation)

        return wrapper

    def const_eval(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        return {
            "out": ScalarValue(dtype="Number", value=_as_number(invocation.params.get("value", 1)))
        }

    def sub_eval(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        # Deliberately asymmetric (left - right) so a swapped port mapping changes the result.
        left = invocation.inputs["left"]
        right = invocation.inputs["right"]
        assert isinstance(left, ScalarValue) and isinstance(right, ScalarValue)
        return {
            "out": ScalarValue(
                dtype="Number", value=_as_number(left.value) - _as_number(right.value)
            )
        }

    def split_eval(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        source = invocation.inputs["in"]
        assert isinstance(source, ScalarValue)
        base = _as_number(source.value)
        return {
            "a": ScalarValue(dtype="Number", value=base + 1.0),
            "b": ScalarValue(dtype="Number", value=base * 2.0),
        }

    def opt_eval(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        bonus = invocation.inputs.get("opt")
        value = _as_number(bonus.value) if isinstance(bonus, ScalarValue) else 0.0
        return {"out": ScalarValue(dtype="Number", value=value)}

    def fail_eval(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        raise RuntimeError("synthetic node failure")

    def wrong_ports_eval(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        return {"other": ScalarValue(dtype="Number", value=1.0)}

    def wrong_type_eval(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        return {"out": AssetSetValue.of(["SPY"])}

    def trace_eval(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        events = invocation.params.get("events", [])
        assert isinstance(events, list)
        for index, event_type in enumerate(events):
            assert isinstance(event_type, str)
            invocation.trace(event_type, {"index": index})
        return {"out": ScalarValue(dtype="Number", value=float(len(events)))}

    def targets_eval(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        raw = invocation.params.get("weights", {})
        assert isinstance(raw, dict)
        weights = {asset: _as_number(value) for asset, value in raw.items()}
        return {"targets": PortfolioTargetsValue.of(weights)}

    def terminal_eval(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        return {}

    def warmup_from_params(params: Mapping[str, object]) -> int:
        window = params.get("window", 0)
        assert isinstance(window, int)
        return window

    catalog = ImplementationCatalog()
    out_num = (OutputPortSpec(name="out", port_type=_NUM),)
    for implementation in (
        NodeImplementation(
            descriptor=_descriptor("test.const", (), out_num),
            evaluate=logged(const_eval),
            warmup=warmup_from_params,
        ),
        NodeImplementation(
            descriptor=_descriptor(
                "test.sub",
                (
                    InputPortSpec(name="left", port_type=_NUM),
                    InputPortSpec(name="right", port_type=_NUM),
                ),
                out_num,
            ),
            evaluate=logged(sub_eval),
        ),
        NodeImplementation(
            descriptor=_descriptor(
                "test.split",
                (InputPortSpec(name="in", port_type=_NUM),),
                (
                    OutputPortSpec(name="a", port_type=_NUM),
                    OutputPortSpec(name="b", port_type=_NUM),
                ),
            ),
            evaluate=logged(split_eval),
        ),
        NodeImplementation(
            descriptor=_descriptor(
                "test.opt",
                (InputPortSpec(name="opt", port_type=_NUM, required=False),),
                out_num,
            ),
            evaluate=logged(opt_eval),
        ),
        NodeImplementation(
            descriptor=_descriptor("test.fail", (), out_num),
            evaluate=logged(fail_eval),
        ),
        NodeImplementation(
            descriptor=_descriptor("test.wrong_ports", (), out_num),
            evaluate=logged(wrong_ports_eval),
        ),
        NodeImplementation(
            descriptor=_descriptor("test.wrong_type", (), out_num),
            evaluate=logged(wrong_type_eval),
        ),
        NodeImplementation(
            descriptor=_descriptor("test.trace", (), out_num),
            evaluate=logged(trace_eval),
        ),
        NodeImplementation(
            descriptor=_descriptor(
                "test.targets", (), (OutputPortSpec(name="targets", port_type=_PT),)
            ),
            evaluate=logged(targets_eval),
        ),
        NodeImplementation(
            descriptor=_descriptor(
                "output.target_portfolio",
                (InputPortSpec(name="targets", port_type=_PT),),
                (),
            ),
            evaluate=logged(terminal_eval),
        ),
    ):
        catalog.register(implementation)
    return catalog


def _terminal_tail() -> tuple[list[NodeInstance], list[Edge]]:
    nodes: list[NodeInstance] = [
        RegisteredNode(
            id="ptsrc",
            type_id="test.targets",
            type_version="1.0.0",
            params={"weights": {"SPY": 0.5}},
        ),
        RegisteredNode(
            id="term", type_id="output.target_portfolio", type_version="1.0.0", params={}
        ),
    ]
    edges = [Edge.model_validate({"from": ("ptsrc", "targets"), "to": ("term", "targets")})]
    return nodes, edges


def synthetic_document(
    nodes: list[NodeInstance],
    edges: list[Edge],
    component_refs: list[ComponentRef] | None = None,
    *,
    with_terminal: bool = True,
) -> StrategyDocument:
    """A structurally valid strategy document over synthetic nodes. Unless disabled, a constant
    targets source + the terminal node are appended so the strategy-level contract is satisfied."""
    if with_terminal:
        tail_nodes, tail_edges = _terminal_tail()
        nodes = [*nodes, *tail_nodes]
        edges = [*edges, *tail_edges]
    return _document(nodes, edges, component_refs)


def node(node_id: str, type_id: str, params: dict[str, object] | None = None) -> NodeInstance:
    return RegisteredNode(
        id=node_id,
        type_id=type_id,
        type_version="1.0.0",
        params=params or {},  # type: ignore[arg-type]
    )


def edge(source: tuple[str, str], target: tuple[str, str]) -> Edge:
    return Edge.model_validate({"from": source, "to": target})
