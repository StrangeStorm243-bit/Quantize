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


# --- negative-zero canonicalization (pre-M9 F) ----------------------------------------------------


def test_scaled_to_zero_buy_really_produces_negative_zero_in_memory() -> None:
    """The live producer motivating the policy: a buy scaled against zero cash records
    cash_delta = -0.0 (numerically equal to zero, sign bit set)."""
    import math
    from datetime import date

    from quantize.engine.fills import apply_orders
    from quantize.engine.orders import Order
    from quantize.engine.state import PortfolioState
    from tests.engine_harness import make_engine_dataset

    day = date(2026, 1, 5)
    dataset = make_engine_dataset({"AAA": {day: (10.0, 10.0)}})
    view = dataset.as_of(dataset.calendar.sessions[0].open_at)
    state, fills, diagnostics = apply_orders(
        PortfolioState(cash=0.0), (Order(side="buy", asset="AAA", quantity=1.0),), view, day, 0.0
    )
    assert diagnostics == ()
    assert fills[0].quantity == 0.0 and fills[0].scaled
    assert fills[0].cash_delta == 0.0  # numerically zero...
    assert math.copysign(1.0, fills[0].cash_delta) == -1.0  # ...with the sign bit set


def test_negative_zero_serializes_canonically_as_positive_zero() -> None:
    """Policy: at the canonical serialization boundary, floats numerically equal to zero emit
    as 0.0 (nonzero signs untouched); loading historical -0.0 bytes still works."""
    from quantize.persistence.records import PersistedFill
    from quantize.persistence.serialize import canonical_json_bytes, strict_json_loads

    fill = PersistedFill(
        session_date="2026-01-05",  # type: ignore[arg-type]
        actual_fill_instant="2026-01-05T14:30:00+00:00",  # type: ignore[arg-type]
        side="buy",
        asset="AAA",
        quantity=0.0,
        price=10.0,
        cost=0.0,
        cash_delta=-0.0,
        scaled=True,
    )
    blob = to_ir_json(fill)
    assert '"cash_delta":0.0' in blob
    assert "-0.0" not in blob
    # Nonzero signs are untouched.
    assert '"cash_delta":-0.25' in to_ir_json(fill.model_copy(update={"cash_delta": -0.25}))
    # The plain-dict boundary (fingerprints/trace payloads) normalizes identically.
    assert canonical_json_bytes({"x": -0.0, "y": -1.5}) == b'{"x":0.0,"y":-1.5}'
    # Historical -0.0 bytes remain loadable with their original meaning.
    loaded = strict_json_loads('{"cash_delta": -0.0}')
    assert loaded["cash_delta"] == 0.0


def test_documents_differing_only_by_zero_sign_are_semantically_equal() -> None:
    """Spillover (documented, accepted): _to_portable backs semantic_projection too, so a
    -0.0 in a document float field canonicalizes and cannot split semantic identity."""
    from quantize.schema.semantics import documents_semantically_equal

    plus = _doc()
    minus = plus.model_copy(deep=True)
    minus.execution_policy.transaction_costs.bps = -0.0
    plus.execution_policy.transaction_costs.bps = 0.0
    assert documents_semantically_equal(plus, minus)
    assert to_ir_json(plus.execution_policy) == to_ir_json(minus.execution_policy)
