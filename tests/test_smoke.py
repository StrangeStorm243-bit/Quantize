"""M1.0 smoke test — verifies the toolchain gate, not the IR itself.

This test is deliberately *meaningful*: it exercises the exact capability stack M1 depends on —
Pydantic v2 model definition + validation + JSON-Schema emission + portable JSON round-trip — on the
selected Python interpreter. If this passes, the chosen Python can author the IR and generate its
schema (the core of M1.1/M1.3). No IR models exist yet; those arrive in M1.1.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class _Daily(BaseModel):
    """A miniature discriminated variant, mirroring the IR's `schedule.kind` shape."""

    kind: Literal["daily"]


def test_pydantic_validates_and_roundtrips() -> None:
    model = _Daily.model_validate({"kind": "daily"})
    assert model.kind == "daily"
    # Portable JSON round-trip: serialize then parse must reconstruct an equal model.
    restored = _Daily.model_validate_json(model.model_dump_json())
    assert restored == model


def test_pydantic_emits_json_schema() -> None:
    schema = _Daily.model_json_schema()
    # The capability M1.3 relies on: Pydantic emits a JSON Schema describing the model.
    assert schema["type"] == "object"
    assert schema["properties"]["kind"]["const"] == "daily"
    assert "kind" in schema["required"]
