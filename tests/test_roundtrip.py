"""Round-trip tests for the strategy document (via the canonical serializer)."""

from __future__ import annotations

import pytest

from quantize.schema.document import StrategyDocument
from quantize.schema.serialization import to_ir_json
from tests.helpers import load_fixture


@pytest.mark.parametrize("name", ["strategy_a", "strategy_b"])
def test_reference_strategy_round_trips(name: str) -> None:
    doc = StrategyDocument.model_validate(load_fixture(name))
    restored = StrategyDocument.model_validate_json(to_ir_json(doc))
    assert restored == doc


def test_round_trip_preserves_ui_and_extensions() -> None:
    data = load_fixture("strategy_a")
    data["nodes"][0]["ui"] = {"x": 120, "y": 40, "collapsed": False}
    data["nodes"][0]["extensions"] = {"vendor.tag": "core"}
    data["extensions"] = {"vendor.doc_note": "demo"}

    doc = StrategyDocument.model_validate(data)
    restored = StrategyDocument.model_validate_json(to_ir_json(doc))

    assert restored == doc
    assert restored.nodes[0].ui == {"x": 120, "y": 40, "collapsed": False}
    assert restored.nodes[0].extensions == {"vendor.tag": "core"}
    assert restored.extensions == {"vendor.doc_note": "demo"}
