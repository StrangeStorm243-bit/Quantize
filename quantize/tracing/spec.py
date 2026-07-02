"""Schema-versioned trace-event payload contracts (M6).

Every trace payload is an explicit versioned contract: a ``TraceEventSpec`` pairs an
``event_type`` with an integer schema version and a Draft 2020-12 schema for the payload. The
version lives INSIDE the payload as the required const field ``"v"`` — the M2 envelope is
untouched. Specs are declared in the module that emits them (node modules, the engine) — never
in a central switch — and aggregated through descriptors / the engine's own spec tuple.

The ``engine.`` event-type namespace is RESERVED for the engine (``node_id="engine"``,
``component_path=()``); ``validate_trace`` enforces the reservation, and the trace-tree builder
separates engine-origin events by this prefix even if a strategy node happens to be named
``engine``.
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from quantize.registry.schema_spec import JsonSchemaSpec

ENGINE_EVENT_PREFIX = "engine."
ENGINE_NODE_ID = "engine"


def versioned_payload_schema(
    version: int,
    properties: Mapping[str, Any],
    required: tuple[str, ...],
) -> dict[str, Any]:
    """The canonical payload-schema shape: ``v`` const-pinned, closed object."""
    return {
        "type": "object",
        "properties": {"v": {"const": version}, **deepcopy(dict(properties))},
        "required": ["v", *required],
        "additionalProperties": False,
    }


@dataclass(frozen=True)
class TraceEventSpec:
    """One event type's payload contract: version + validating schema.

    ``schema`` is the raw (portable JSON) schema document — kept so per-node combined schemas
    can be composed; ``payload_schema`` is its validating ``JsonSchemaSpec`` form.
    """

    event_type: str
    version: int
    schema: dict[str, Any]
    payload_schema: JsonSchemaSpec = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not self.event_type:
            raise ValueError("event_type must be non-empty")
        if self.version < 1:
            raise ValueError("version must be >= 1")
        object.__setattr__(self, "schema", deepcopy(self.schema))
        object.__setattr__(self, "payload_schema", JsonSchemaSpec(self.schema))

    @classmethod
    def of(
        cls,
        event_type: str,
        version: int,
        properties: Mapping[str, Any],
        required: tuple[str, ...],
    ) -> TraceEventSpec:
        return cls(
            event_type=event_type,
            version=version,
            schema=versioned_payload_schema(version, properties, required),
        )


# Shared schema fragments (deep-copied into each spec at construction).
ASSET_LIST: dict[str, Any] = {"type": "array", "items": {"type": "string", "minLength": 1}}
NUMBER: dict[str, Any] = {"type": "number"}
STRING: dict[str, Any] = {"type": "string", "minLength": 1}


def pair_list(second: Mapping[str, Any]) -> dict[str, Any]:
    """``[[asset, x], …]`` — a closed two-tuple list (e.g. weights, ranks)."""
    return {
        "type": "array",
        "items": {
            "type": "array",
            "prefixItems": [{"type": "string", "minLength": 1}, deepcopy(dict(second))],
            "minItems": 2,
            "maxItems": 2,
            "items": False,
        },
    }


def combined_trace_schema(specs: tuple[TraceEventSpec, ...]) -> JsonSchemaSpec | None:
    """The node-level ``trace_schema`` (M2 field, populated at M6): any declared payload.

    A ``oneOf`` over closed payload shapes — each valid payload matches exactly one branch
    because every branch is ``additionalProperties: false`` with distinct required fields.
    """
    if not specs:
        return None
    return JsonSchemaSpec({"oneOf": [deepcopy(spec.schema) for spec in specs]})
