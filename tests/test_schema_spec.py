"""M2.4 — JsonSchemaSpec (immutable Draft 2020-12 schema)."""

from typing import Any

import pytest
from jsonschema.exceptions import SchemaError
from pydantic import ValidationError

from quantize.registry.schema_spec import JsonSchemaSpec

_SCHEMA = {
    "type": "object",
    "properties": {"n": {"type": "integer", "minimum": 1}},
    "required": ["n"],
    "additionalProperties": False,
}


def test_valid_instance_has_no_issues() -> None:
    assert JsonSchemaSpec(_SCHEMA).errors({"n": 3}) == ()


def test_invalid_instance_reports_structured_issues() -> None:
    issues = JsonSchemaSpec(_SCHEMA).errors({})  # missing required "n"
    assert issues
    assert issues[0].message
    assert isinstance(issues[0].path, tuple)


def test_minimum_violation_has_path() -> None:
    issues = JsonSchemaSpec(_SCHEMA).errors({"n": 0})
    assert any(issue.path == ("n",) for issue in issues)


def test_malformed_schema_raises() -> None:
    with pytest.raises(SchemaError):
        JsonSchemaSpec({"type": "not_a_real_type"})


def test_rejects_references_so_errors_cannot_throw() -> None:
    # an unresolvable $ref passes check_schema but would throw during iter_errors; reject up front
    with pytest.raises(ValueError):
        JsonSchemaSpec({"$ref": "#/$defs/missing"})


def test_rejects_non_portable_schema_content() -> None:
    with pytest.raises(ValidationError):
        JsonSchemaSpec({"type": "object", "x-python": object()})


def test_validates_non_object_instance() -> None:
    spec = JsonSchemaSpec({"type": "integer"})
    assert spec.errors(5) == ()
    assert spec.errors("x")


def test_deep_copy_ownership() -> None:
    raw: dict[str, Any] = {"type": "object", "properties": {"n": {"type": "integer"}}}
    spec = JsonSchemaSpec(raw)
    raw["properties"]["n"]["type"] = "string"  # mutate the caller's dict after construction
    assert spec.errors({"n": 1}) == ()  # unaffected — spec owns a deep copy


def test_document_returns_constructed_schema() -> None:
    assert JsonSchemaSpec(_SCHEMA).document == _SCHEMA


def _nested_minimum(document: dict[str, Any]) -> Any:
    """Read the nested ``properties.n.minimum`` with step-wise narrowing (JsonValue union)."""
    properties = document["properties"]
    assert isinstance(properties, dict)
    n_schema = properties["n"]
    assert isinstance(n_schema, dict)
    return n_schema["minimum"]


def test_document_return_is_a_deep_copy() -> None:
    spec = JsonSchemaSpec(_SCHEMA)
    returned = spec.document
    properties = returned["properties"]
    assert isinstance(properties, dict)
    n_schema = properties["n"]
    assert isinstance(n_schema, dict)
    n_schema["minimum"] = 999  # mutate a NESTED value of the returned dict
    # the held copy is untouched, so validation still uses minimum 1 (n=1 stays valid)
    assert spec.errors({"n": 1}) == ()
    # each read is a fresh deep copy, so a later document read is untouched too
    assert _nested_minimum(spec.document) == 1
