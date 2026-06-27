"""Datetime portability tests for persisted documents (M1.1b)."""

from __future__ import annotations

from datetime import UTC

import pytest
from pydantic import ValidationError

from quantize.schema.document import StrategyDocument
from quantize.schema.serialization import to_ir_json
from tests.helpers import load_fixture


def test_naive_created_at_is_rejected() -> None:
    data = load_fixture("strategy_a")
    data["strategy"]["provenance"]["created_at"] = "2026-06-23T00:00:00"  # no timezone
    with pytest.raises(ValidationError):
        StrategyDocument.model_validate(data)


def test_aware_created_at_normalizes_to_utc_and_round_trips() -> None:
    data = load_fixture("strategy_a")
    data["strategy"]["provenance"]["created_at"] = "2026-06-23T05:00:00+05:00"
    doc = StrategyDocument.model_validate(data)

    created = doc.strategy.provenance.created_at
    assert created.tzinfo == UTC
    assert created.hour == 0  # 05:00+05:00 == 00:00Z

    restored = StrategyDocument.model_validate_json(to_ir_json(doc))
    assert restored.strategy.provenance.created_at == created
