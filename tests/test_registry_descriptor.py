"""M2.1 — node descriptor model tests.

M13.1 extends ``NodeMetadata`` with a required machine-stage ``category`` and an optional ``doc``
block (``NodeDoc``/``ParamDoc``) — the registry-authored node meaning the editor renders.
"""

import pytest
from pydantic import ValidationError

from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeDoc,
    NodeMetadata,
    OutputPortSpec,
    ParamDoc,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.schema.types import CrossSectionType

_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")
_META = NodeMetadata(display_name="Rank", description="Cross-sectional rank.", category="selection")


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
        NodeMetadata(display_name="", description="x", category="selection")


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


# --- M13.1: category + doc metadata ------------------------------------------------------------

_PARAM_SCHEMA = JsonSchemaSpec(
    {
        "type": "object",
        "properties": {"n": {"type": "integer", "minimum": 1}},
        "required": ["n"],
        "additionalProperties": False,
    }
)


def test_metadata_requires_category() -> None:
    with pytest.raises(ValidationError):
        NodeMetadata(display_name="Rank", description="x")  # type: ignore[call-arg]


@pytest.mark.parametrize("category", ["Signal", "1selection", "sel-ection", "", "sel.ection"])
def test_metadata_rejects_bad_category_pattern(category: str) -> None:
    with pytest.raises(ValidationError):
        NodeMetadata(display_name="Rank", description="x", category=category)


@pytest.mark.parametrize("category", ["selection", "risk", "output", "ml", "optimization"])
def test_metadata_accepts_lowercase_category(category: str) -> None:
    meta = NodeMetadata(display_name="Rank", description="x", category=category)
    assert meta.category == category
    assert meta.doc is None  # doc is optional


def test_param_doc_rejects_empty_label() -> None:
    with pytest.raises(ValidationError):
        ParamDoc(label="")


def test_node_doc_rejects_empty_summary() -> None:
    with pytest.raises(ValidationError):
        NodeDoc(summary="")


def test_node_doc_defaults() -> None:
    doc = NodeDoc(summary="What it does.")
    assert doc.formula is None and doc.latex is None and doc.semantics is None
    assert doc.parameters == {}


def test_metadata_carries_doc_block() -> None:
    doc = NodeDoc(
        summary="Selects the n best.",
        formula="rank ∈ {1..k}",
        semantics="Excluded assets are not ranked.",
        parameters={"n": ParamDoc(label="Number to select", help="How many to keep.")},
    )
    meta = NodeMetadata(display_name="Rank", description="x", category="selection", doc=doc)
    assert meta.doc is doc
    assert meta.doc.parameters["n"].label == "Number to select"


def test_descriptor_rejects_param_doc_absent_from_schema() -> None:
    """A doc.parameters key with no matching parameter_schema property is a hard error."""
    doc = NodeDoc(summary="x", parameters={"nope": ParamDoc(label="Orphan")})
    with pytest.raises(ValidationError):
        _descriptor(
            metadata=NodeMetadata(
                display_name="Rank", description="x", category="selection", doc=doc
            ),
            parameter_schema=_PARAM_SCHEMA,
        )


def test_descriptor_rejects_param_doc_when_no_schema() -> None:
    """Any doc.parameters key is orphan when the node declares no parameter schema."""
    doc = NodeDoc(summary="x", parameters={"n": ParamDoc(label="N")})
    with pytest.raises(ValidationError):
        _descriptor(
            metadata=NodeMetadata(
                display_name="Rank", description="x", category="selection", doc=doc
            )
        )


def test_descriptor_accepts_param_doc_matching_schema() -> None:
    doc = NodeDoc(summary="x", parameters={"n": ParamDoc(label="Number to select")})
    d = _descriptor(
        metadata=NodeMetadata(display_name="Rank", description="x", category="selection", doc=doc),
        parameter_schema=_PARAM_SCHEMA,
    )
    assert d.metadata.doc is not None and "n" in d.metadata.doc.parameters
