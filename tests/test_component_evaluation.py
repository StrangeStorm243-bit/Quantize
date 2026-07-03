"""M3: compositional component evaluation — real sub-graph execution, no flattening."""

from __future__ import annotations

from quantize.components.resolve import ComponentCatalog, resolve_strategy_components
from quantize.evaluator.evaluate import EvaluationOutcome, evaluate_strategy
from quantize.evaluator.plan import resolve_warmup
from quantize.runtime.values import ScalarValue
from quantize.schema.components import ComponentRef
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import ComponentRefNode, NodeInstance
from tests.component_fixtures import (
    FAILER_ID,
    NESTED_TRACER_ID,
    OUTER_ID,
    SCALER_ID,
    TRACER_ID,
    failer_definition,
    nested_tracer_definition,
    outer_definition,
    scaler_definition,
    tracer_definition,
)
from tests.runtime_fixtures import (
    EVAL_INSTANT,
    RUN_ID,
    build_synthetic_catalog,
    edge,
    node,
    synthetic_document,
    two_session_dataset,
)


def _evaluate(document: StrategyDocument, components: ComponentCatalog) -> EvaluationOutcome:
    return evaluate_strategy(
        document,
        catalog=build_synthetic_catalog(),
        market_data=two_session_dataset(),
        run_id=RUN_ID,
        evaluation_instant=EVAL_INSTANT,
        components=components,
    )


def _scaler_strategy(offset: float = 3.0) -> StrategyDocument:
    nodes: list[NodeInstance] = [
        node("src", "test.const", {"value": 10}),
        ComponentRefNode(id="sc", type_id="component", ref="r1", params={"offset": offset}),
    ]
    edges = [edge(("src", "out"), ("sc", "value"))]
    return synthetic_document(
        nodes, edges, [ComponentRef(id="r1", component_id=SCALER_ID, version="1.0.0")]
    )


def test_component_evaluates_end_to_end() -> None:
    outcome = _evaluate(_scaler_strategy(offset=3.0), ComponentCatalog([scaler_definition()]))
    assert outcome.ok, outcome.diagnostics
    result = outcome.output_value(["sc"], "result")
    assert isinstance(result, ScalarValue)
    assert result.value == 7.0  # 10 - 3: input mapping, param binding, output mapping


def test_component_internal_outputs_are_stored_under_their_hierarchical_path() -> None:
    outcome = _evaluate(_scaler_strategy(offset=3.0), ComponentCatalog([scaler_definition()]))
    assert outcome.ok
    # Compositional evaluation: the internal nodes really ran, under the instance's path —
    # they were not flattened into anonymous top-level nodes.
    inner_const = outcome.output_value(["sc", "inner_c"], "out")
    assert isinstance(inner_const, ScalarValue) and inner_const.value == 3.0
    inner_sub = outcome.output_value(["sc", "inner_sub"], "out")
    assert isinstance(inner_sub, ScalarValue) and inner_sub.value == 7.0
    assert (("sc",), "result") in outcome.outputs
    top_level_ids = {path[0] for path, _ in outcome.outputs}
    assert "inner_sub" not in top_level_ids  # no flattening


def test_default_params_apply_when_instance_does_not_override() -> None:
    document = _scaler_strategy()
    # Rebuild without the override: authored internal default (value=1) must apply.
    nodes: list[NodeInstance] = [
        node("src", "test.const", {"value": 10}),
        ComponentRefNode(id="sc", type_id="component", ref="r1", params={}),
    ]
    edges = [edge(("src", "out"), ("sc", "value"))]
    document = synthetic_document(
        nodes, edges, [ComponentRef(id="r1", component_id=SCALER_ID, version="1.0.0")]
    )
    outcome = _evaluate(document, ComponentCatalog([scaler_definition()]))
    assert outcome.ok
    result = outcome.output_value(["sc"], "result")
    assert isinstance(result, ScalarValue)
    assert result.value == 9.0  # 10 - 1


def test_nested_components_evaluate_compositionally() -> None:
    nodes: list[NodeInstance] = [
        node("src", "test.const", {"value": 10}),
        ComponentRefNode(id="outer", type_id="component", ref="r1", params={"offset": 4}),
    ]
    edges = [edge(("src", "out"), ("outer", "value"))]
    document = synthetic_document(
        nodes, edges, [ComponentRef(id="r1", component_id=OUTER_ID, version="1.0.0")]
    )
    outcome = _evaluate(document, ComponentCatalog([outer_definition(), scaler_definition()]))
    assert outcome.ok, outcome.diagnostics
    result = outcome.output_value(["outer"], "result")
    assert isinstance(result, ScalarValue)
    assert result.value == 6.0  # 10 - 4, offset bound through two component levels
    two_deep = outcome.output_value(["outer", "inner_scaler", "inner_sub"], "out")
    assert isinstance(two_deep, ScalarValue) and two_deep.value == 6.0


def test_trace_events_carry_hierarchical_component_paths() -> None:
    nodes: list[NodeInstance] = [
        ComponentRefNode(id="tc", type_id="component", ref="r1", params={})
    ]
    document = synthetic_document(
        nodes, [], [ComponentRef(id="r1", component_id=TRACER_ID, version="1.0.0")]
    )
    outcome = _evaluate(document, ComponentCatalog([tracer_definition()]))
    assert outcome.ok, outcome.diagnostics
    event = next(e for e in outcome.trace if e.event_type == "tracer.ping")
    assert event.node_id == "inner_trace"
    assert event.component_path == ("tc",)  # the enclosing component-instance chain


def test_trace_paths_go_two_component_levels_deep() -> None:
    nodes: list[NodeInstance] = [
        ComponentRefNode(id="nt", type_id="component", ref="r1", params={})
    ]
    document = synthetic_document(
        nodes, [], [ComponentRef(id="r1", component_id=NESTED_TRACER_ID, version="1.0.0")]
    )
    outcome = _evaluate(
        document, ComponentCatalog([nested_tracer_definition(), tracer_definition()])
    )
    assert outcome.ok, outcome.diagnostics
    event = next(e for e in outcome.trace if e.event_type == "tracer.ping")
    assert event.node_id == "inner_trace"
    assert event.component_path == ("nt", "tin")  # two nested instance levels


def test_node_failure_inside_a_component_reports_the_hierarchical_path() -> None:
    nodes: list[NodeInstance] = [
        ComponentRefNode(id="fc", type_id="component", ref="r1", params={})
    ]
    document = synthetic_document(
        nodes, [], [ComponentRef(id="r1", component_id=FAILER_ID, version="1.0.0")]
    )
    outcome = _evaluate(document, ComponentCatalog([failer_definition()]))
    assert not outcome.ok
    assert [d.code for d in outcome.diagnostics] == ["node_execution_failed"]
    assert outcome.diagnostics[0].node_path == ("fc", "inner_fail")


def test_unconnected_exposed_input_is_rejected() -> None:
    nodes: list[NodeInstance] = [
        ComponentRefNode(id="sc", type_id="component", ref="r1", params={})
    ]
    document = synthetic_document(
        nodes, [], [ComponentRef(id="r1", component_id=SCALER_ID, version="1.0.0")]
    )
    outcome = _evaluate(document, ComponentCatalog([scaler_definition()]))
    assert not outcome.ok
    assert "required_input_unconnected" in [d.code for d in outcome.diagnostics]


def test_edge_to_unknown_exposed_port_is_rejected() -> None:
    nodes: list[NodeInstance] = [
        node("src", "test.const", {"value": 10}),
        ComponentRefNode(id="sc", type_id="component", ref="r1", params={}),
    ]
    edges = [
        edge(("src", "out"), ("sc", "value")),
        edge(("src", "out"), ("sc", "ghost_port")),
    ]
    document = synthetic_document(
        nodes, edges, [ComponentRef(id="r1", component_id=SCALER_ID, version="1.0.0")]
    )
    outcome = _evaluate(document, ComponentCatalog([scaler_definition()]))
    assert not outcome.ok
    assert "unknown_input_port" in [d.code for d in outcome.diagnostics]


def test_repeated_component_runs_are_identical() -> None:
    document = _scaler_strategy(offset=3.0)
    components = ComponentCatalog([scaler_definition()])
    first = _evaluate(document, components)
    second = _evaluate(document, components)
    assert first.ok and second.ok
    assert first.outputs == second.outputs
    assert first.trace == second.trace


def test_warmup_resolution_descends_into_components() -> None:
    document = _scaler_strategy(offset=3.0)
    catalog = build_synthetic_catalog()
    resolution = resolve_strategy_components(
        document, ComponentCatalog([scaler_definition()]), catalog.descriptor_registry
    )
    assert resolution.ok
    warmup = resolve_warmup(document, catalog, resolution)
    # The Scaler's internal constant declares window=5 (see the fixture; the synthetic
    # test.const warm-up returns its window UNCHANGED — it is not a moving average).
    assert warmup.by_node[("sc", "inner_c")] == 5
    assert warmup.total == 5


def test_warmup_of_a_real_moving_average_inside_a_component() -> None:
    """Flat/componentized warm-up parity for the REAL node: a component wrapping
    transform.moving_average(window=5) resolves to the same declared warm-up (4 prior
    sessions) as a flat MA node would."""
    from quantize.nodes import build_core_catalog
    from quantize.schema.components import ExposedPort
    from quantize.schema.nodes import RegisteredNode
    from quantize.schema.types import TimeSeriesType
    from tests.component_fixtures import definition

    ts = TimeSeriesType(kind="TimeSeries", dtype="Number")
    ma_component_id = "12121212-1212-1212-1212-121212121212"
    ma_definition = definition(
        ma_component_id,
        "MAWrap",
        [
            RegisteredNode(
                id="inner_ma",
                type_id="transform.moving_average",
                type_version="1.0.0",
                params={"window": 5},
            )
        ],
        [],
        exposed_inputs=[ExposedPort(name="series", type=ts, maps_to=("inner_ma", "series"))],
        exposed_outputs=[ExposedPort(name="smoothed", type=ts, maps_to=("inner_ma", "series"))],
    )
    document = synthetic_document(
        [ComponentRefNode(id="mc", type_id="component", ref="r1", params={})],
        [],
        [ComponentRef(id="r1", component_id=ma_component_id, version="1.0.0")],
    )
    core = build_core_catalog()
    resolution = resolve_strategy_components(
        document, ComponentCatalog([ma_definition]), core.descriptor_registry
    )
    assert resolution.ok, resolution.diagnostics
    warmup = resolve_warmup(document, core, resolution)
    assert warmup.by_node[("mc", "inner_ma")] == 4  # window 5 -> 4 prior sessions
    assert warmup.total == 4
