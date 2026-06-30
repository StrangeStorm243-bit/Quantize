"""Immutable, Draft 2020-12-validated JSON Schema for validating JSON instances.

Runtime infrastructure (descriptor ``parameter_schema`` / ``trace_schema``); not persisted IR.
Construction fully checks the schema and deep-copies it; the schema lives only inside a private
validator, so the caller's mapping cannot mutate it afterward (practical immutability — not hardened
against a deliberate reach-in, which is acceptable for runtime infra).

Construction guarantees ``errors()`` never raises, by rejecting up front:

* **non-portable JSON** content (e.g. a stray Python object) — descriptor schemas are
  language-neutral fragments the future editor/API consumes; and
* **references** (``$ref``/``$dynamicRef``/``$recursiveRef``) — v0 schemas must be self-contained;
  an unresolvable reference passes ``check_schema`` but then throws during ``iter_errors``.
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from jsonschema import Draft202012Validator
from pydantic import TypeAdapter

from quantize.schema.primitives import JsonObject

# Reuse the IR's portable-JSON gate to reject non-portable content inside a schema fragment.
_PORTABLE_JSON: TypeAdapter[Any] = TypeAdapter(JsonObject)

# Reference keywords whose targets cannot be resolved for a self-contained v0 schema.
_REFERENCE_KEYWORDS = frozenset({"$ref", "$dynamicRef", "$recursiveRef"})


def _reject_references(node: object) -> None:
    """Raise if *node* (or any descendant) uses a JSON Schema reference keyword."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in _REFERENCE_KEYWORDS:
                raise ValueError(
                    f"JSON Schema references ({key}) are unsupported in v0; "
                    "descriptor schemas must be self-contained"
                )
            _reject_references(value)
    elif isinstance(node, list):
        for item in node:
            _reject_references(item)


@dataclass(frozen=True)
class JsonSchemaIssue:
    """One validation failure of a JSON instance against a schema."""

    path: tuple[str | int, ...]
    json_path: str
    message: str


class JsonSchemaSpec:
    """A validated, immutable Draft 2020-12 schema. See the module docstring."""

    __slots__ = ("_validator",)

    def __init__(self, schema: Mapping[str, Any]) -> None:
        owned = deepcopy(dict(schema))
        _PORTABLE_JSON.validate_python(owned)  # reject non-portable JSON content (ValidationError)
        _reject_references(owned)  # reject references so errors() cannot throw (ValueError)
        Draft202012Validator.check_schema(owned)  # SchemaError on a malformed schema
        self._validator = Draft202012Validator(owned)

    def errors(self, instance: object) -> tuple[JsonSchemaIssue, ...]:
        """Return the validation issues for *instance*, sorted deterministically. Never raises."""
        return tuple(
            JsonSchemaIssue(tuple(e.absolute_path), e.json_path, e.message)
            for e in sorted(
                self._validator.iter_errors(instance), key=lambda e: (e.json_path, e.message)
            )
        )
