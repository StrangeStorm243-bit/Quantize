"""Synthetic ``ComponentDefinition`` builders for M3 component resolution/evaluation tests."""

from __future__ import annotations

from datetime import UTC, datetime

from quantize.schema.components import (
    ComponentDefinition,
    ComponentRef,
    ExposedParam,
    ExposedPort,
    Graph,
    GraphImplementation,
)
from quantize.schema.nodes import ComponentRefNode, Edge, NodeInstance, RegisteredNode
from quantize.schema.provenance import ComponentForkRef, Provenance
from quantize.schema.types import ScalarType

_OWNER = "22222222-2222-2222-2222-222222222222"
_NUM = ScalarType(kind="Scalar", dtype="Number")

SCALER_ID = "55555555-5555-5555-5555-555555555555"
OUTER_ID = "66666666-6666-6666-6666-666666666666"
TRACER_ID = "77777777-7777-7777-7777-777777777777"
CYCLE_A_ID = "88888888-8888-8888-8888-888888888888"
CYCLE_B_ID = "99999999-9999-9999-9999-999999999999"


def _provenance() -> Provenance[ComponentForkRef]:
    return Provenance[ComponentForkRef](
        owner=_OWNER,
        creator=_OWNER,
        contributors=[],
        visibility="private",
        duplicable=False,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )


def definition(
    component_id: str,
    name: str,
    nodes: list[NodeInstance],
    edges: list[Edge],
    *,
    version: str = "1.0.0",
    component_refs: list[ComponentRef] | None = None,
    exposed_inputs: list[ExposedPort] | None = None,
    exposed_outputs: list[ExposedPort] | None = None,
    exposed_params: list[ExposedParam] | None = None,
) -> ComponentDefinition:
    return ComponentDefinition(
        component_id=component_id,
        version=version,
        schema_version="0.1.0",
        name=name,
        component_refs=component_refs or [],
        implementation=GraphImplementation(kind="graph", graph=Graph(nodes=nodes, edges=edges)),
        exposed_inputs=exposed_inputs or [],
        exposed_outputs=exposed_outputs or [],
        exposed_params=exposed_params or [],
        provenance=_provenance(),
    )


def scaler_definition() -> ComponentDefinition:
    """``result = value - offset``: one exposed input, output, and param over synthetic nodes.

    The internal constant also declares ``window: 5`` so nested warm-up resolution is testable.
    """
    nodes: list[NodeInstance] = [
        RegisteredNode(
            id="inner_c",
            type_id="test.const",
            type_version="1.0.0",
            params={"value": 1, "window": 5},
        ),
        RegisteredNode(id="inner_sub", type_id="test.sub", type_version="1.0.0", params={}),
    ]
    edges = [Edge.model_validate({"from": ("inner_c", "out"), "to": ("inner_sub", "right")})]
    return definition(
        SCALER_ID,
        "Scaler",
        nodes,
        edges,
        exposed_inputs=[ExposedPort(name="value", type=_NUM, maps_to=("inner_sub", "left"))],
        exposed_outputs=[ExposedPort(name="result", type=_NUM, maps_to=("inner_sub", "out"))],
        exposed_params=[
            ExposedParam.model_validate(
                {"name": "offset", "binds_to": ("inner_c", "value"), "schema": {"type": "number"}}
            )
        ],
    )


def outer_definition() -> ComponentDefinition:
    """A component nesting a Scaler instance; re-exposes its ports and its offset param."""
    nodes: list[NodeInstance] = [
        ComponentRefNode(id="inner_scaler", type_id="component", ref="dep", params={"offset": 2})
    ]
    return definition(
        OUTER_ID,
        "Outer",
        nodes,
        [],
        component_refs=[ComponentRef(id="dep", component_id=SCALER_ID, version="1.0.0")],
        exposed_inputs=[ExposedPort(name="value", type=_NUM, maps_to=("inner_scaler", "value"))],
        exposed_outputs=[ExposedPort(name="result", type=_NUM, maps_to=("inner_scaler", "result"))],
        exposed_params=[
            ExposedParam.model_validate(
                {
                    "name": "offset",
                    "binds_to": ("inner_scaler", "offset"),
                    "schema": {"type": "number"},
                }
            )
        ],
    )


def tracer_definition() -> ComponentDefinition:
    """A component whose internal node emits trace events (hierarchy-path plumbing)."""
    nodes: list[NodeInstance] = [
        RegisteredNode(
            id="inner_trace",
            type_id="test.trace",
            type_version="1.0.0",
            params={"events": ["tracer.ping"]},
        )
    ]
    return definition(
        TRACER_ID,
        "Tracer",
        nodes,
        [],
        exposed_outputs=[ExposedPort(name="count", type=_NUM, maps_to=("inner_trace", "out"))],
    )


FAILER_ID = "abababab-abab-abab-abab-abababababab"
NESTED_TRACER_ID = "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd"


def failer_definition() -> ComponentDefinition:
    """A component whose internal node raises during evaluation (failure-path identity)."""
    nodes: list[NodeInstance] = [
        RegisteredNode(id="inner_fail", type_id="test.fail", type_version="1.0.0", params={})
    ]
    return definition(
        FAILER_ID,
        "Failer",
        nodes,
        [],
        exposed_outputs=[ExposedPort(name="out", type=_NUM, maps_to=("inner_fail", "out"))],
    )


def nested_tracer_definition() -> ComponentDefinition:
    """A component wrapping a Tracer instance — trace paths must go two levels deep."""
    nodes: list[NodeInstance] = [
        ComponentRefNode(id="tin", type_id="component", ref="dep", params={})
    ]
    return definition(
        NESTED_TRACER_ID,
        "NestedTracer",
        nodes,
        [],
        component_refs=[ComponentRef(id="dep", component_id=TRACER_ID, version="1.0.0")],
        exposed_outputs=[ExposedPort(name="count", type=_NUM, maps_to=("tin", "count"))],
    )


def cyclic_definitions() -> tuple[ComponentDefinition, ComponentDefinition]:
    """Two definitions referencing each other — transitive recursion."""
    a = definition(
        CYCLE_A_ID,
        "CycleA",
        [ComponentRefNode(id="b", type_id="component", ref="rb", params={})],
        [],
        component_refs=[ComponentRef(id="rb", component_id=CYCLE_B_ID, version="1.0.0")],
    )
    b = definition(
        CYCLE_B_ID,
        "CycleB",
        [ComponentRefNode(id="a", type_id="component", ref="ra", params={})],
        [],
        component_refs=[ComponentRef(id="ra", component_id=CYCLE_A_ID, version="1.0.0")],
    )
    return a, b
