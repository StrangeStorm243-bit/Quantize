"""Tests for the canonical serialization boundary (to_ir_dict / to_ir_json)."""

from __future__ import annotations

import pytest

from quantize.schema.document import StrategyDocument
from quantize.schema.serialization import to_ir_dict, to_ir_json
from tests.helpers import load_fixture


def _doc() -> StrategyDocument:
    return StrategyDocument.model_validate(load_fixture("strategy_a"))


def test_canonical_json_uses_from_alias_not_python_name() -> None:
    # MEDIUM-6: the obvious persistence path must emit "from", not "from_".
    blob = to_ir_json(_doc())
    assert '"from":' in blob
    assert "from_" not in blob


def test_canonical_round_trips() -> None:
    doc = _doc()
    restored = StrategyDocument.model_validate_json(to_ir_json(doc))
    assert restored == doc


def test_canonical_datetime_is_rfc3339_utc() -> None:
    data = to_ir_dict(_doc())
    assert data["strategy"]["provenance"]["created_at"] == "2026-06-23T00:00:00+00:00"


# --- Adversarial: mutate a valid model, prove canonical serialization FAILS (not null) -------


def test_canonical_serialization_rejects_mutated_nan() -> None:
    doc = _doc()
    doc.nodes[1].params["bad"] = float("nan")  # bypasses parse-time validation
    with pytest.raises(ValueError, match="portable JSON"):
        to_ir_json(doc)


def test_canonical_serialization_rejects_mutated_infinity() -> None:
    doc = _doc()
    doc.nodes[1].params["bad"] = float("inf")
    with pytest.raises(ValueError, match="portable JSON"):
        to_ir_json(doc)


def test_canonical_serialization_rejects_mutated_unsafe_integer() -> None:
    doc = _doc()
    doc.nodes[1].params["big"] = 2**53
    with pytest.raises(ValueError, match="JS-safe range"):
        to_ir_json(doc)


@pytest.mark.filterwarnings("ignore::UserWarning")
def test_canonical_serialization_rejects_unsupported_object() -> None:
    doc = _doc()
    doc.nodes[1].params["obj"] = object()  # type: ignore[assignment]
    with pytest.raises(ValueError, match="cannot be persisted"):
        to_ir_json(doc)


def test_date_values_serialize_as_iso_strings() -> None:
    # M7 additive: plain dates (run-record facts) join datetimes in the portable walker;
    # the datetime branch must win first (datetime subclasses date).
    from datetime import UTC, date, datetime

    from pydantic import BaseModel

    class WithDates(BaseModel):
        day: date
        instant: datetime

    model = WithDates(day=date(2026, 7, 2), instant=datetime(2026, 7, 2, 21, 0, tzinfo=UTC))
    dumped = to_ir_dict(model)
    assert dumped == {"day": "2026-07-02", "instant": "2026-07-02T21:00:00+00:00"}
