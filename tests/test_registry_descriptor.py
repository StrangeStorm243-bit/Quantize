"""M2.1 — node descriptor model tests."""

import pytest
from pydantic import ValidationError

from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.schema.types import CrossSectionType

_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")
_META = NodeMetadata(display_name="Rank", description="Cross-sectional rank.")


def test_input_port_defaults_to_required() -> None:
    port = InputPortSpec(name="values", port_type=_CS_NUM)
    assert port.required is True


def test_output_port_has_no_required_field() -> None:
    with pytest.raises(ValidationError):
        OutputPortSpec(name="values", port_type=_CS_NUM, required=True)  # type: ignore[call-arg]


def test_port_spec_is_frozen() -> None:
    port = InputPortSpec(name="values", port_type=_CS_NUM)
    with pytest.raises(ValidationError):
        port.name = "other"


def test_required_rejects_string_coercion() -> None:
    with pytest.raises(ValidationError):
        InputPortSpec(name="x", port_type=_CS_NUM, required="false")  # type: ignore[arg-type]


def _descriptor(**overrides: object) -> NodeDescriptor:
    base: dict[str, object] = dict(
        type_id="transform.rank",
        type_version="1.0.0",
        inputs=(InputPortSpec(name="values", port_type=_CS_NUM),),
        outputs=(OutputPortSpec(name="values", port_type=_CS_NUM),),
        metadata=_META,
    )
    base.update(overrides)
    return NodeDescriptor(**base)  # type: ignore[arg-type]


def test_valid_descriptor_constructs() -> None:
    d = _descriptor()
    assert d.type_id == "transform.rank"
    # input and output sharing a name is allowed
    assert d.inputs[0].name == d.outputs[0].name == "values"


def test_metadata_is_required() -> None:
    with pytest.raises(ValidationError):
        NodeDescriptor(  # type: ignore[call-arg]
            type_id="transform.rank", type_version="1.0.0", inputs=(), outputs=()
        )


def test_metadata_rejects_blank_fields() -> None:
    with pytest.raises(ValidationError):
        NodeMetadata(display_name="", description="x")


@pytest.mark.parametrize("type_id", ["rank", "", "component"])
def test_rejects_non_registered_type_id(type_id: str) -> None:
    with pytest.raises(ValidationError):
        _descriptor(type_id=type_id)


def test_rejects_bad_semver() -> None:
    with pytest.raises(ValidationError):
        _descriptor(type_version="1.0")


def test_rejects_duplicate_input_names() -> None:
    with pytest.raises(ValidationError):
        _descriptor(
            inputs=(
                InputPortSpec(name="values", port_type=_CS_NUM),
                InputPortSpec(name="values", port_type=_CS_NUM),
            )
        )


def test_rejects_duplicate_output_names() -> None:
    with pytest.raises(ValidationError):
        _descriptor(
            outputs=(
                OutputPortSpec(name="values", port_type=_CS_NUM),
                OutputPortSpec(name="values", port_type=_CS_NUM),
            )
        )


def test_rejects_unknown_field() -> None:
    with pytest.raises(ValidationError):
        _descriptor(flavor="spicy")


def test_node_metadata_is_frozen() -> None:
    with pytest.raises(ValidationError):
        _META.display_name = "other"


def test_node_descriptor_is_frozen() -> None:
    with pytest.raises(ValidationError):
        _descriptor().type_id = "transform.other"


def test_descriptor_schemas_default_none() -> None:
    d = _descriptor()
    assert d.parameter_schema is None and d.trace_schema is None


def test_descriptor_accepts_parameter_and_trace_schema() -> None:
    params = JsonSchemaSpec({"type": "object"})
    trace = JsonSchemaSpec({"type": "object"})
    d = _descriptor(parameter_schema=params, trace_schema=trace)
    assert d.parameter_schema is params and d.trace_schema is trace
