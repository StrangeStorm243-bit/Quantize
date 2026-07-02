"""M3: ``logic.greater_than`` and the portfolio-construction nodes."""

from __future__ import annotations

import pytest

from quantize.market.data import DataView
from quantize.nodes.logic import GREATER_THAN
from quantize.nodes.output import TARGET_PORTFOLIO
from quantize.nodes.portfolio import APPLY_MASK, EQUAL_WEIGHT, FIXED_WEIGHT, SELECT_TOP_N
from quantize.runtime.values import (
    AssetSetValue,
    CrossSectionValue,
    PortfolioTargetsValue,
)
from tests.node_harness import business_days, invoke, make_view

_DAYS = business_days(1)
_D1 = _DAYS[0]


def _view() -> DataView:
    return make_view(_DAYS, {"X": {_D1: 1.0}})


# --- logic.greater_than ------------------------------------------------------------------------


def test_greater_than_strict_comparison() -> None:
    left = CrossSectionValue.numbers(["AGG", "EFA", "SPY"], {"AGG": 2.0, "EFA": 1.0, "SPY": 3.0})
    right = CrossSectionValue.numbers(["AGG", "EFA", "SPY"], {"AGG": 1.0, "EFA": 1.0, "SPY": 4.0})
    outputs, events = invoke(GREATER_THAN, view=_view(), inputs={"left": left, "right": right})
    mask = outputs["values"]
    assert isinstance(mask, CrossSectionValue)
    assert mask.as_dict() == {"AGG": True, "EFA": False, "SPY": False}  # equal is NOT greater
    # The three-way condition distinction: genuine passes/fails, nothing defaulted.
    assert events == [
        (
            "logic.evaluated",
            {"v": 1, "passed": ["AGG"], "failed": ["EFA", "SPY"], "defaulted_missing": []},
        )
    ]


def test_greater_than_missing_operand_is_false_not_omitted() -> None:
    left = CrossSectionValue.numbers(["AGG", "SPY"], {"SPY": 3.0})  # AGG excluded upstream
    right = CrossSectionValue.numbers(["AGG", "SPY"], {"AGG": 1.0, "SPY": 2.0})
    outputs, events = invoke(GREATER_THAN, view=_view(), inputs={"left": left, "right": right})
    mask = outputs["values"]
    assert isinstance(mask, CrossSectionValue)
    # Domain preserved: AGG present and false — not dropped.
    assert mask.as_dict() == {"AGG": False, "SPY": True}
    assert ("logic.missing_operand", {"v": 1, "asset": "AGG", "missing": ["left"]}) in events
    # AGG is DEFAULTED false (missing operand), SPY genuinely passed — distinct facts.
    assert (
        "logic.evaluated",
        {"v": 1, "passed": ["SPY"], "failed": [], "defaulted_missing": ["AGG"]},
    ) in events
    # Exact event-type set: nothing spurious beside the two declared facts.
    assert [e[0] for e in events] == ["logic.missing_operand", "logic.evaluated"]


def test_greater_than_domain_is_the_union_of_operand_domains() -> None:
    left = CrossSectionValue.numbers(["AGG"], {"AGG": 1.0})
    right = CrossSectionValue.numbers(["SPY"], {"SPY": 1.0})
    outputs, events = invoke(GREATER_THAN, view=_view(), inputs={"left": left, "right": right})
    mask = outputs["values"]
    assert isinstance(mask, CrossSectionValue)
    assert mask.as_dict() == {"AGG": False, "SPY": False}
    assert [e[0] for e in events] == [
        "logic.missing_operand",
        "logic.missing_operand",
        "logic.evaluated",
    ]


# --- portfolio.select_top_n --------------------------------------------------------------------


def test_select_top_n_takes_the_best_ranked() -> None:
    ranks = CrossSectionValue.numbers(["EFA", "QQQ", "SPY"], {"QQQ": 1.0, "SPY": 2.0, "EFA": 3.0})
    outputs, _ = invoke(
        SELECT_TOP_N,
        view=_view(),
        params={"n": 2},
        inputs={"scores": ranks, "universe": AssetSetValue.of(["EFA", "QQQ", "SPY"])},
    )
    selected = outputs["assets"]
    assert isinstance(selected, AssetSetValue)
    assert selected.assets == ("QQQ", "SPY")


def test_select_top_n_score_ties_break_by_canonical_ticker() -> None:
    scores = CrossSectionValue.numbers(["GLD", "EFA"], {"GLD": 1.0, "EFA": 1.0})
    outputs, _ = invoke(
        SELECT_TOP_N,
        view=_view(),
        params={"n": 1},
        inputs={"scores": scores, "universe": AssetSetValue.of(["EFA", "GLD"])},
    )
    selected = outputs["assets"]
    assert isinstance(selected, AssetSetValue)
    assert selected.assets == ("EFA",)


def test_select_top_n_fewer_qualifying_selects_all() -> None:
    scores = CrossSectionValue.numbers(["EFA", "QQQ", "SPY"], {"QQQ": 1.0})
    outputs, events = invoke(
        SELECT_TOP_N,
        view=_view(),
        params={"n": 3},
        inputs={"scores": scores, "universe": AssetSetValue.of(["EFA", "QQQ", "SPY"])},
    )
    selected = outputs["assets"]
    assert isinstance(selected, AssetSetValue)
    assert selected.assets == ("QQQ",)  # allowed, not an error
    assert ("select.excluded", {"v": 1, "asset": "EFA", "reason": "unscored"}) in events
    assert ("select.excluded", {"v": 1, "asset": "SPY", "reason": "unscored"}) in events


def test_select_top_n_ignores_scores_outside_the_universe() -> None:
    scores = CrossSectionValue.numbers(["GHOST", "QQQ"], {"GHOST": 0.5, "QQQ": 1.0})
    outputs, _ = invoke(
        SELECT_TOP_N,
        view=_view(),
        params={"n": 2},
        inputs={"scores": scores, "universe": AssetSetValue.of(["QQQ"])},
    )
    selected = outputs["assets"]
    assert isinstance(selected, AssetSetValue)
    assert selected.assets == ("QQQ",)


def test_select_top_n_empty_universe_selects_nothing() -> None:
    scores = CrossSectionValue.numbers(["QQQ"], {"QQQ": 1.0})
    outputs, _ = invoke(
        SELECT_TOP_N,
        view=_view(),
        params={"n": 2},
        inputs={"scores": scores, "universe": AssetSetValue.of([])},
    )
    selected = outputs["assets"]
    assert isinstance(selected, AssetSetValue)
    assert selected.assets == ()


# --- portfolio.equal_weight --------------------------------------------------------------------


def test_equal_weight_renormalizes_across_selection() -> None:
    outputs, events = invoke(
        EQUAL_WEIGHT, view=_view(), inputs={"assets": AssetSetValue.of(["IWM", "QQQ", "SPY"])}
    )
    targets = outputs["targets"]
    assert isinstance(targets, PortfolioTargetsValue)
    assert targets.as_dict() == {
        "IWM": pytest.approx(1 / 3),
        "QQQ": pytest.approx(1 / 3),
        "SPY": pytest.approx(1 / 3),
    }
    assert targets.cash_weight == pytest.approx(0.0, abs=1e-12)
    assert [e[0] for e in events] == ["portfolio.weighted"]
    weighted = events[0][1]
    assert weighted["weights"] == [
        ["IWM", pytest.approx(1 / 3)],
        ["QQQ", pytest.approx(1 / 3)],
        ["SPY", pytest.approx(1 / 3)],
    ]


def test_equal_weight_single_asset_gets_everything() -> None:
    outputs, _ = invoke(EQUAL_WEIGHT, view=_view(), inputs={"assets": AssetSetValue.of(["SPY"])})
    targets = outputs["targets"]
    assert isinstance(targets, PortfolioTargetsValue)
    assert targets.as_dict() == {"SPY": 1.0}


def test_equal_weight_empty_selection_is_all_cash() -> None:
    outputs, events = invoke(EQUAL_WEIGHT, view=_view(), inputs={"assets": AssetSetValue.of([])})
    targets = outputs["targets"]
    assert isinstance(targets, PortfolioTargetsValue)
    assert targets.as_dict() == {}
    assert targets.cash_weight == 1.0
    assert ("portfolio.empty_selection", {"v": 1}) in events


# --- portfolio.fixed_weight --------------------------------------------------------------------


def test_fixed_weight_equal_sleeves() -> None:
    outputs, _ = invoke(
        FIXED_WEIGHT,
        view=_view(),
        params={"weight_per_asset": "equal"},
        inputs={"assets": AssetSetValue.of(["AGG", "EFA", "SPY", "VNQ"])},
    )
    targets = outputs["targets"]
    assert isinstance(targets, PortfolioTargetsValue)
    assert targets.as_dict() == {"AGG": 0.25, "EFA": 0.25, "SPY": 0.25, "VNQ": 0.25}


def test_fixed_weight_numeric_sleeves_leave_cash() -> None:
    outputs, _ = invoke(
        FIXED_WEIGHT,
        view=_view(),
        params={"weight_per_asset": 0.2},
        inputs={"assets": AssetSetValue.of(["AGG", "SPY"])},
    )
    targets = outputs["targets"]
    assert isinstance(targets, PortfolioTargetsValue)
    assert targets.as_dict() == {"AGG": 0.2, "SPY": 0.2}
    assert targets.cash_weight == pytest.approx(0.6)


def test_fixed_weight_exact_full_allocation_is_allowed() -> None:
    outputs, _ = invoke(
        FIXED_WEIGHT,
        view=_view(),
        params={"weight_per_asset": 0.25},
        inputs={"assets": AssetSetValue.of(["A1", "B1", "C1", "D1"])},
    )
    targets = outputs["targets"]
    assert isinstance(targets, PortfolioTargetsValue)
    assert targets.invested_weight == pytest.approx(1.0)


def test_fixed_weight_over_allocation_fails_loud() -> None:
    with pytest.raises(ValueError, match="over-allocates"):
        invoke(
            FIXED_WEIGHT,
            view=_view(),
            params={"weight_per_asset": 0.3},
            inputs={"assets": AssetSetValue.of(["A1", "B1", "C1", "D1"])},
        )


def test_fixed_weight_empty_universe_is_all_cash() -> None:
    outputs, events = invoke(
        FIXED_WEIGHT,
        view=_view(),
        params={"weight_per_asset": "equal"},
        inputs={"assets": AssetSetValue.of([])},
    )
    targets = outputs["targets"]
    assert isinstance(targets, PortfolioTargetsValue)
    assert targets.as_dict() == {}
    assert ("portfolio.empty_universe", {"v": 1}) in events


# --- portfolio.apply_mask ----------------------------------------------------------------------


def test_apply_mask_zeroes_failures_without_renormalizing() -> None:
    targets = PortfolioTargetsValue.of({"AGG": 0.25, "EFA": 0.25, "SPY": 0.25, "VNQ": 0.25})
    mask = CrossSectionValue.booleans(
        ["AGG", "EFA", "SPY", "VNQ"],
        {"AGG": True, "EFA": False, "SPY": True, "VNQ": False},
    )
    outputs, events = invoke(APPLY_MASK, view=_view(), inputs={"targets": targets, "mask": mask})
    result = outputs["targets"]
    assert isinstance(result, PortfolioTargetsValue)
    # Survivors keep their 0.25 sleeves — NOT renormalized; failures go to 0; cash = 0.5.
    assert result.as_dict() == {"AGG": 0.25, "EFA": 0.0, "SPY": 0.25, "VNQ": 0.0}
    assert result.cash_weight == pytest.approx(0.5)
    reasons = {
        payload["asset"]: payload["reason"]
        for event_type, payload in events
        if event_type == "portfolio.masked_out"
    }
    assert reasons == {"EFA": "mask_false", "VNQ": "mask_false"}


def test_apply_mask_missing_mask_entry_zeroes_and_traces() -> None:
    targets = PortfolioTargetsValue.of({"AGG": 0.5, "SPY": 0.5})
    mask = CrossSectionValue.booleans(["AGG", "SPY"], {"AGG": True})  # SPY missing
    outputs, events = invoke(APPLY_MASK, view=_view(), inputs={"targets": targets, "mask": mask})
    result = outputs["targets"]
    assert isinstance(result, PortfolioTargetsValue)
    assert result.as_dict() == {"AGG": 0.5, "SPY": 0.0}
    assert (
        "portfolio.masked_out",
        {"v": 1, "asset": "SPY", "weight_zeroed": 0.5, "reason": "mask_missing"},
    ) in events
    assert ("portfolio.mask_applied", {"v": 1, "kept": ["AGG"], "zeroed": ["SPY"]}) in events


def test_apply_mask_empty_targets_pass_through() -> None:
    targets = PortfolioTargetsValue.of({})
    mask = CrossSectionValue.booleans(["SPY"], {"SPY": True})
    outputs, events = invoke(APPLY_MASK, view=_view(), inputs={"targets": targets, "mask": mask})
    result = outputs["targets"]
    assert isinstance(result, PortfolioTargetsValue)
    assert result.as_dict() == {}
    assert events == [("portfolio.mask_applied", {"v": 1, "kept": [], "zeroed": []})]


# --- output.target_portfolio -------------------------------------------------------------------


def test_terminal_consumes_targets_and_produces_nothing() -> None:
    targets = PortfolioTargetsValue.of({"SPY": 1.0})
    outputs, events = invoke(TARGET_PORTFOLIO, view=_view(), inputs={"targets": targets})
    assert outputs == {}
    # The terminal now records the final targets it received (outputs-produced fact).
    assert events == [("targets.finalized", {"v": 1, "weights": [["SPY", 1.0]], "cash": 0.0})]
