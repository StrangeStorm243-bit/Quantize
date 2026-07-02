"""M3: ``risk.max_weight`` — the ratified deterministic waterfall redistribution."""

from __future__ import annotations

import pytest

from quantize.market.data import DataView
from quantize.nodes.risk import MAX_WEIGHT
from quantize.runtime.values import PortfolioTargetsValue
from tests.node_harness import business_days, invoke, make_view

_DAYS = business_days(1)


def _view() -> DataView:
    return make_view(_DAYS, {"X": {_DAYS[0]: 1.0}})


def _cap(weights: dict[str, float], cap: float) -> tuple[PortfolioTargetsValue, list[str]]:
    outputs, events = invoke(
        MAX_WEIGHT,
        view=_view(),
        params={"max": cap},
        inputs={"targets": PortfolioTargetsValue.of(weights)},
    )
    targets = outputs["targets"]
    assert isinstance(targets, PortfolioTargetsValue)
    return targets, [event_type for event_type, _ in events]


def test_no_overflow_is_identity_with_no_trace() -> None:
    targets, events = _cap({"IWM": 1 / 3, "QQQ": 1 / 3, "SPY": 1 / 3}, 0.4)
    assert targets.as_dict() == {
        "IWM": pytest.approx(1 / 3),
        "QQQ": pytest.approx(1 / 3),
        "SPY": pytest.approx(1 / 3),
    }
    assert events == []


def test_waterfall_hand_computed_two_iterations() -> None:
    # {A:0.6, B:0.3, C:0.1}, cap 0.4:
    # iter 1: A -> 0.4, excess 0.2 to B,C by weight (0.3, 0.1): B=0.45, C=0.15
    # iter 2: B -> 0.4, excess 0.05 to C alone: C=0.20. Final {0.4, 0.4, 0.2}, fully invested.
    targets, events = _cap({"AAA": 0.6, "BBB": 0.3, "CCC": 0.1}, 0.4)
    assert targets.as_dict() == {
        "AAA": pytest.approx(0.4),
        "BBB": pytest.approx(0.4),
        "CCC": pytest.approx(0.2),
    }
    assert targets.invested_weight == pytest.approx(1.0)
    assert events == ["risk.cap_applied"]


def test_waterfall_trace_payload_details() -> None:
    outputs, events = invoke(
        MAX_WEIGHT,
        view=_view(),
        params={"max": 0.4},
        inputs={"targets": PortfolioTargetsValue.of({"AAA": 0.6, "BBB": 0.3, "CCC": 0.1})},
    )
    assert len(events) == 1
    event_type, payload = events[0]
    assert event_type == "risk.cap_applied"
    assert payload["capped_assets"] == ["AAA", "BBB"]
    assert payload["iterations"] == 2
    assert payload["left_in_cash"] == pytest.approx(0.0, abs=1e-12)


def test_unresolvable_remainder_stays_in_cash_never_violating_the_cap() -> None:
    targets, _ = _cap({"AAA": 0.9}, 0.4)
    assert targets.as_dict() == {"AAA": pytest.approx(0.4)}
    assert targets.cash_weight == pytest.approx(0.6)


def test_all_assets_capped_remainder_to_cash() -> None:
    targets, _ = _cap({"AAA": 0.5, "BBB": 0.5}, 0.4)
    assert targets.as_dict() == {"AAA": pytest.approx(0.4), "BBB": pytest.approx(0.4)}
    assert targets.cash_weight == pytest.approx(0.2)


def test_zero_weight_assets_receive_no_redistribution() -> None:
    targets, _ = _cap({"AAA": 0.8, "BBB": 0.2, "CCC": 0.0}, 0.5)
    assert targets.as_dict() == {
        "AAA": pytest.approx(0.5),
        "BBB": pytest.approx(0.5),
        "CCC": pytest.approx(0.0),
    }


def test_cap_of_one_is_identity() -> None:
    targets, events = _cap({"AAA": 1.0}, 1.0)
    assert targets.as_dict() == {"AAA": pytest.approx(1.0)}
    assert events == []


def test_empty_targets_pass_through() -> None:
    targets, events = _cap({}, 0.4)
    assert targets.as_dict() == {}
    assert events == []


def test_result_never_exceeds_the_cap() -> None:
    targets, _ = _cap({"AAA": 0.7, "BBB": 0.25, "CCC": 0.05}, 0.3)
    assert all(weight <= 0.3 + 1e-9 for weight in targets.as_dict().values())
