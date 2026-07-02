"""M3: component resolution — closure fetching, recursion rejection, mappings, param binding."""

from __future__ import annotations

import pytest

from quantize.components.resolve import (
    ComponentCatalog,
    ResolvedStrategy,
    resolve_strategy_components,
)
from quantize.schema.components import ComponentRef, ExposedParam, ExposedPort
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import ComponentRefNode, NodeInstance
from quantize.schema.primitives import JsonValue
from quantize.schema.types import AssetSetType, ScalarType
from tests.component_fixtures import (
    OUTER_ID,
    SCALER_ID,
    cyclic_definitions,
    definition,
    outer_definition,
    scaler_definition,
)
from tests.runtime_fixtures import build_synthetic_catalog, synthetic_document

_NUM = ScalarType(kind="Scalar", dtype="Number")


def _component_node(ref: str = "r1", params: dict[str, JsonValue] | None = None) -> NodeInstance:
    return ComponentRefNode(id="sc", type_id="component", ref=ref, params=params or {})


def _strategy_with_scaler(params: dict[str, JsonValue] | None = None) -> StrategyDocument:
    return synthetic_document(
        [_component_node(params=params)],
        [],
        [ComponentRef(id="r1", component_id=SCALER_ID, version="1.0.0")],
    )


def _codes(resolution: ResolvedStrategy) -> list[str]:
    return [d.code for d in resolution.diagnostics]


def test_resolves_a_simple_component() -> None:
    document = _strategy_with_scaler({"offset": 3})
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([scaler_definition()]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert resolution.ok, resolution.diagnostics
    instance = resolution.instances["sc"]
    assert instance.path == ("sc",)
    assert instance.definition.component_id == SCALER_ID
    # The exposed param override reached the bound internal node's effective params.
    assert instance.effective_params["inner_c"]["value"] == 3
    # The authored document itself is untouched (binding operates on copies).
    scaler = scaler_definition()
    internal = scaler.implementation.graph.nodes[0]
    assert internal.params == {"value": 1, "window": 5}


def test_missing_definition_is_diagnosed() -> None:
    document = _strategy_with_scaler()
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog(),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    assert "component_definition_unavailable" in _codes(resolution)


def test_transitive_recursion_is_rejected_over_the_fetched_closure() -> None:
    cycle_a, cycle_b = cyclic_definitions()
    document = synthetic_document(
        [ComponentRefNode(id="ca", type_id="component", ref="ra", params={})],
        [],
        [ComponentRef(id="ra", component_id=cycle_a.component_id, version="1.0.0")],
    )
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([cycle_a, cycle_b]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    assert "component_cycle" in _codes(resolution)
    assert resolution.instances == {}  # no instantiation over a cyclic closure


def test_direct_recursion_is_rejected() -> None:
    selfref = definition(
        SCALER_ID,
        "SelfRef",
        [ComponentRefNode(id="me", type_id="component", ref="self", params={})],
        [],
        component_refs=[ComponentRef(id="self", component_id=SCALER_ID, version="1.0.0")],
    )
    document = _strategy_with_scaler()
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([selfref]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    codes = _codes(resolution)
    assert "component_direct_recursion" in codes


def test_nested_dependency_resolves_transitively() -> None:
    document = synthetic_document(
        [ComponentRefNode(id="outer", type_id="component", ref="r1", params={"offset": 4})],
        [],
        [ComponentRef(id="r1", component_id=OUTER_ID, version="1.0.0")],
    )
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([outer_definition(), scaler_definition()]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert resolution.ok, resolution.diagnostics
    outer = resolution.instances["outer"]
    nested = outer.children["inner_scaler"]
    assert nested.path == ("outer", "inner_scaler")
    # offset=4 flowed outer -> inner_scaler -> inner_c.value (two levels of binding).
    assert nested.effective_params["inner_c"]["value"] == 4


def test_unknown_instance_param_is_diagnosed() -> None:
    document = _strategy_with_scaler({"bogus": 1})
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([scaler_definition()]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    diagnostic = next(d for d in resolution.diagnostics if d.code == "unknown_component_param")
    assert diagnostic.node_path == ("sc",)
    assert diagnostic.subject == "bogus"


def test_instance_param_violating_exposed_schema_is_diagnosed() -> None:
    document = _strategy_with_scaler({"offset": "not-a-number"})
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([scaler_definition()]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    assert "invalid_component_param" in _codes(resolution)


def test_exposed_input_mapping_to_unknown_port_is_diagnosed() -> None:
    broken = definition(
        SCALER_ID,
        "Broken",
        [
            # a lone registered node without the mapped port
        ],
        [],
        exposed_inputs=[ExposedPort(name="value", type=_NUM, maps_to=("ghost", "left"))],
    )
    document = _strategy_with_scaler()
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([broken]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    assert "exposed_port_target_missing" in _codes(resolution)


def test_exposed_port_type_incompatibility_is_diagnosed() -> None:
    scaler = scaler_definition()
    wrong_type = definition(
        SCALER_ID,
        "WrongType",
        list(scaler.implementation.graph.nodes),
        list(scaler.implementation.graph.edges),
        exposed_inputs=[
            ExposedPort(
                name="value",
                type=AssetSetType(kind="AssetSet"),
                maps_to=("inner_sub", "left"),
            )
        ],
        exposed_outputs=list(scaler.exposed_outputs),
    )
    document = _strategy_with_scaler()
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([wrong_type]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    assert "exposed_port_type_incompatible" in _codes(resolution)


def test_exposed_output_mapping_to_unknown_port_is_diagnosed() -> None:
    scaler = scaler_definition()
    broken = definition(
        SCALER_ID,
        "BrokenOutput",
        list(scaler.implementation.graph.nodes),
        list(scaler.implementation.graph.edges),
        exposed_inputs=list(scaler.exposed_inputs),
        exposed_outputs=[ExposedPort(name="result", type=_NUM, maps_to=("ghost", "out"))],
    )
    document = _strategy_with_scaler()
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([broken]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    diagnostic = next(d for d in resolution.diagnostics if d.code == "exposed_port_target_missing")
    assert diagnostic.subject == "result"


def test_exposed_output_type_incompatibility_is_diagnosed() -> None:
    scaler = scaler_definition()
    wrong_type = definition(
        SCALER_ID,
        "WrongOutputType",
        list(scaler.implementation.graph.nodes),
        list(scaler.implementation.graph.edges),
        exposed_inputs=list(scaler.exposed_inputs),
        exposed_outputs=[
            ExposedPort(
                name="result",
                type=AssetSetType(kind="AssetSet"),
                maps_to=("inner_sub", "out"),  # a Scalar[Number] internal output
            )
        ],
    )
    document = _strategy_with_scaler()
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([wrong_type]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    assert "exposed_port_type_incompatible" in _codes(resolution)


def test_internal_graph_cycle_in_a_fetched_definition_is_diagnosed() -> None:
    from quantize.schema.nodes import Edge, RegisteredNode

    cyclic_graph = definition(
        SCALER_ID,
        "InternalCycle",
        [
            RegisteredNode(id="a", type_id="test.opt", type_version="1.0.0", params={}),
            RegisteredNode(id="b", type_id="test.opt", type_version="1.0.0", params={}),
        ],
        [
            Edge.model_validate({"from": ("a", "out"), "to": ("b", "opt")}),
            Edge.model_validate({"from": ("b", "out"), "to": ("a", "opt")}),
        ],
    )
    document = _strategy_with_scaler()
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([cyclic_graph]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    diagnostic = next(d for d in resolution.diagnostics if d.code == "component_definition_invalid")
    assert "graph_cycle" in diagnostic.message


def test_exposed_param_binding_to_unknown_node_is_diagnosed() -> None:
    scaler = scaler_definition()
    broken = definition(
        SCALER_ID,
        "BrokenParam",
        list(scaler.implementation.graph.nodes),
        list(scaler.implementation.graph.edges),
        exposed_inputs=list(scaler.exposed_inputs),
        exposed_outputs=list(scaler.exposed_outputs),
        exposed_params=[
            ExposedParam.model_validate(
                {"name": "offset", "binds_to": ("ghost", "value"), "schema": {"type": "number"}}
            )
        ],
    )
    document = _strategy_with_scaler()
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([broken]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    assert "exposed_param_target_missing" in _codes(resolution)


def test_invalid_exposed_param_schema_is_diagnosed() -> None:
    scaler = scaler_definition()
    broken = definition(
        SCALER_ID,
        "BrokenSchema",
        list(scaler.implementation.graph.nodes),
        list(scaler.implementation.graph.edges),
        exposed_inputs=list(scaler.exposed_inputs),
        exposed_outputs=list(scaler.exposed_outputs),
        exposed_params=[
            ExposedParam.model_validate(
                {
                    "name": "offset",
                    "binds_to": ("inner_c", "value"),
                    "schema": {"type": "not_a_real_type"},
                }
            )
        ],
    )
    document = _strategy_with_scaler()
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([broken]),
        build_synthetic_catalog().descriptor_registry,
    )
    assert not resolution.ok
    assert "exposed_param_schema_invalid" in _codes(resolution)


def test_effective_params_are_validated_against_node_schemas() -> None:
    # test.param requires {"n": int >= 1}; expose a param that can inject an invalid value.
    from quantize.schema.nodes import RegisteredNode
    from tests.registry_fixtures import build_fixture_registry

    param_component = definition(
        SCALER_ID,
        "ParamHolder",
        [RegisteredNode(id="p", type_id="test.param", type_version="1.0.0", params={"n": 1})],
        [],
        exposed_params=[
            ExposedParam.model_validate(
                {"name": "n", "binds_to": ("p", "n"), "schema": {"type": "integer"}}
            )
        ],
    )
    document = _strategy_with_scaler({"n": 0})  # violates test.param's minimum of 1
    resolution = resolve_strategy_components(
        document,
        ComponentCatalog([param_component]),
        build_fixture_registry(),
    )
    assert not resolution.ok
    diagnostic = next(d for d in resolution.diagnostics if d.code == "invalid_parameters")
    assert diagnostic.node_path == ("sc", "p")


def test_catalog_rejects_duplicate_identities() -> None:
    with pytest.raises(ValueError, match="more than once"):
        ComponentCatalog([scaler_definition(), scaler_definition()])
