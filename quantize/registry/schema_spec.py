"""Immutable, Draft 2020-12-validated JSON Schema for validating JSON instances.

Runtime infrastructure (descriptor ``parameter_schema`` / ``trace_schema``) — NOT persisted IR.
Construction validates the schema and takes ownership via a deep copy; the schema lives only inside a
private validator, so the caller's mapping cannot mutate it afterward (practical immutability — not
hardened against a deliberate reach-in, which is acceptable for runtime infra).
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from jsonschema import Draft202012Validator


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
