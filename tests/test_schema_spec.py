"""M2.4 — JsonSchemaSpec (immutable Draft 2020-12 schema)."""

from typing import Any

import pytest
from jsonschema.exceptions import SchemaError

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


def test_validates_non_object_instance() -> None:
    spec = JsonSchemaSpec({"type": "integer"})
    assert spec.errors(5) == ()
    assert spec.errors("x")


def test_deep_copy_ownership() -> None:
    raw: dict[str, Any] = {"type": "object", "properties": {"n": {"type": "integer"}}}
    spec = JsonSchemaSpec(raw)
    raw["properties"]["n"]["type"] = "string"  # mutate the caller's dict after construction
    assert spec.errors({"n": 1}) == ()  # unaffected — spec owns a deep copy
