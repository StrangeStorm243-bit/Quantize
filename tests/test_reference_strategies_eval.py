"""M3: both reference strategies evaluated at single instants over the deterministic fixture.

Expected values are hand-defensible from the fixture's construction: asset ``a`` grows by the
constant per-session factor ``GROWTH[a]``, so its trailing L-session return is exactly
``GROWTH[a]**L - 1`` and momentum ordering equals growth-factor ordering; rising assets close
above their 200-session moving average, falling ones below it.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from quantize.components.resolve import ComponentCatalog
from quantize.evaluator.evaluate import EvaluationOutcome, evaluate_strategy
from quantize.evaluator.plan import topological_order
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.runtime.values import CrossSectionValue, PortfolioTargetsValue
from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument
from quantize.validation.semantic import validate_strategy_semantics
from quantize.validation.structural import validate_strategy_document
from tests.helpers import load_fixture
from tests.market_fixture import (
    GLD_START_INDEX,
    GROWTH,
    IWM_MISSING_DATE,
    build_market_fixture,
)

RUN_ID = "12121212-1212-1212-1212-121212121212"
MAIN_DATE = date(2026, 6, 1)  # a Monday session with full history for every asset


@pytest.fixture(scope="module")
def market() -> MarketDataSet:
    return build_market_fixture()


def _close_instant(market: MarketDataSet, day: date) -> datetime:
    session = market.calendar.session_on(day)
    assert session is not None, f"{day} is not a fixture session"
    return session.close_at


def _load(name: str) -> StrategyDocument:
    return StrategyDocument.model_validate(load_fixture(name))


def _evaluate(
    market: MarketDataSet,
    document: StrategyDocument,
    day: date,
    components: ComponentCatalog | None = None,
) -> EvaluationOutcome:
    return evaluate_strategy(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        evaluation_instant=_close_instant(market, day),
        components=components,
    )


# --- Strategy A ---------------------------------------------------------------------------------


def test_strategy_a_passes_full_validation_against_the_real_catalog() -> None:
    document = _load("strategy_a")
    assert validate_strategy_document(document).ok
    semantic = validate_strategy_semantics(document, build_core_catalog().descriptor_registry)
    assert semantic.ok, semantic.diagnostics


def test_strategy_a_topological_order() -> None:
    document = _load("strategy_a")
    order = topological_order(document.nodes, document.edges)
    assert order == ("u", "px", "ret", "rk", "sel", "ew", "cap", "tp")


def test_strategy_a_targets_at_the_main_instant(market: MarketDataSet) -> None:
    outcome = _evaluate(market, _load("strategy_a"), MAIN_DATE)
    assert outcome.ok, outcome.diagnostics
    assert isinstance(outcome.targets, PortfolioTargetsValue)
    # Growth ordering: QQQ (1.0016) > SPY (1.0012) > IWM (1.0008) > the rest — top 3 equal-weight,
    # each 1/3, under the 0.4 cap (no redistribution), cash ~ 0.
    assert outcome.targets.as_dict() == {
        "IWM": pytest.approx(1 / 3),
        "QQQ": pytest.approx(1 / 3),
        "SPY": pytest.approx(1 / 3),
    }
    assert outcome.targets.cash_weight == pytest.approx(0.0, abs=1e-12)


def test_strategy_a_trailing_returns_and_ranks_are_exact(market: MarketDataSet) -> None:
    outcome = _evaluate(market, _load("strategy_a"), MAIN_DATE)
    assert outcome.ok
    returns = outcome.output_value(["ret"], "values")
    assert isinstance(returns, CrossSectionValue)
    for asset in ("EFA", "GLD", "IWM", "QQQ", "SPY", "TLT"):
        # Constant growth: return over 126 sessions == GROWTH**126 - 1 exactly (same closes).
        assert returns.as_dict()[asset] == pytest.approx(GROWTH[asset] ** 126 - 1, rel=1e-12)
    ranks = outcome.output_value(["rk"], "values")
    assert isinstance(ranks, CrossSectionValue)
    assert ranks.as_dict() == {
        "QQQ": 1.0,
        "SPY": 2.0,
        "IWM": 3.0,
        "EFA": 4.0,
        "GLD": 5.0,
        "TLT": 6.0,
    }


def test_strategy_a_excludes_iwm_on_its_missing_session(market: MarketDataSet) -> None:
    outcome = _evaluate(market, _load("strategy_a"), IWM_MISSING_DATE)
    assert outcome.ok, outcome.diagnostics
    assert isinstance(outcome.targets, PortfolioTargetsValue)
    # IWM has no close that session -> excluded from the scored cross-section -> next best (EFA)
    # joins QQQ and SPY. Missing data shrinks the candidate set; it never reuses stale prices.
    assert outcome.targets.as_dict() == {
        "EFA": pytest.approx(1 / 3),
        "QQQ": pytest.approx(1 / 3),
        "SPY": pytest.approx(1 / 3),
    }
    exclusions = [
        event.payload
        for event in outcome.trace
        if event.event_type == "transform.excluded" and event.node_id == "ret"
    ]
    assert {"asset": "IWM", "reason": "missing_current_close"} in exclusions


def test_strategy_a_excludes_gld_during_its_warmup(market: MarketDataSet) -> None:
    # At session index GLD_START_INDEX + 70, GLD has 71 observations — fewer than the 127 needed
    # for a 126-session trailing return — so its anchor close is missing.
    day = market.calendar.sessions[GLD_START_INDEX + 70].session_date
    outcome = _evaluate(market, _load("strategy_a"), day)
    assert outcome.ok, outcome.diagnostics
    ranks = outcome.output_value(["rk"], "values")
    assert isinstance(ranks, CrossSectionValue)
    assert "GLD" not in ranks.as_dict()
    assert "GLD" in ranks.domain  # excluded from values, still in the bound domain
    exclusions = [
        event.payload
        for event in outcome.trace
        if event.event_type == "transform.excluded" and event.node_id == "ret"
    ]
    assert {"asset": "GLD", "reason": "missing_anchor_close"} in exclusions


def test_strategy_a_no_lookahead_before_the_close(market: MarketDataSet) -> None:
    """One minute before session D's close, D's data must be invisible: the evaluation equals
    the one at the PREVIOUS session's close (same knowable data), not the one at D's close."""
    dates = market.calendar.session_dates
    index = dates.index(MAIN_DATE)
    previous = dates[index - 1]
    document = _load("strategy_a")

    just_before_close = _close_instant(market, MAIN_DATE) - timedelta(minutes=1)
    at_previous_close = _evaluate(market, document, previous)
    early = evaluate_strategy(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        evaluation_instant=just_before_close,
    )
    assert early.ok and at_previous_close.ok
    assert early.outputs == at_previous_close.outputs
    assert early.trace == at_previous_close.trace


def test_strategy_a_repeated_runs_are_identical(market: MarketDataSet) -> None:
    document = _load("strategy_a")
    first = _evaluate(market, document, MAIN_DATE)
    second = _evaluate(market, document, MAIN_DATE)
    assert first.ok and second.ok
    assert first.targets == second.targets
    assert first.outputs == second.outputs
    assert first.trace == second.trace


# --- Strategy B ---------------------------------------------------------------------------------


def test_strategy_b_passes_full_validation_against_the_real_catalog() -> None:
    document = _load("strategy_b")
    assert validate_strategy_document(document).ok
    semantic = validate_strategy_semantics(document, build_core_catalog().descriptor_registry)
    assert semantic.ok, semantic.diagnostics


def test_strategy_b_fixed_sleeves_and_cash_remainder(market: MarketDataSet) -> None:
    outcome = _evaluate(market, _load("strategy_b"), MAIN_DATE)
    assert outcome.ok, outcome.diagnostics
    assert isinstance(outcome.targets, PortfolioTargetsValue)
    # Rising assets (AGG, EFA, SPY) close above their 200-session MA and keep their fixed 0.25
    # sleeves; falling VNQ fails the trend filter and is zeroed. No renormalization: cash = 0.25.
    assert outcome.targets.as_dict() == {
        "AGG": pytest.approx(0.25),
        "EFA": pytest.approx(0.25),
        "SPY": pytest.approx(0.25),
        "VNQ": pytest.approx(0.0),
    }
    assert outcome.targets.invested_weight == pytest.approx(0.75)
    assert outcome.targets.cash_weight == pytest.approx(0.25)


def test_strategy_b_trend_mask_is_exact(market: MarketDataSet) -> None:
    outcome = _evaluate(market, _load("strategy_b"), MAIN_DATE)
    assert outcome.ok
    mask = outcome.output_value(["gt"], "values")
    assert isinstance(mask, CrossSectionValue)
    # Strictly increasing series close above their trailing mean; strictly decreasing below.
    assert mask.as_dict() == {"AGG": True, "EFA": True, "SPY": True, "VNQ": False}
    masked = [
        event.payload for event in outcome.trace if event.event_type == "portfolio.masked_out"
    ]
    assert masked == [{"asset": "VNQ", "weight_zeroed": 0.25, "reason": "mask_false"}]


def test_strategy_b_repeated_runs_are_identical(market: MarketDataSet) -> None:
    document = _load("strategy_b")
    first = _evaluate(market, document, MAIN_DATE)
    second = _evaluate(market, document, MAIN_DATE)
    assert first.outputs == second.outputs and first.trace == second.trace


def test_no_state_leaks_between_strategy_a_and_b(market: MarketDataSet) -> None:
    catalog = build_core_catalog()

    def run(name: str, shared: bool) -> EvaluationOutcome:
        return evaluate_strategy(
            _load(name),
            catalog=catalog if shared else build_core_catalog(),
            market_data=market,
            run_id=RUN_ID,
            evaluation_instant=_close_instant(market, MAIN_DATE),
        )

    run("strategy_a", shared=True)
    b_after_a = run("strategy_b", shared=True)
    b_fresh = run("strategy_b", shared=False)
    assert b_after_a.outputs == b_fresh.outputs
    assert b_after_a.trace == b_fresh.trace


# --- the componentized Strategy A (real component end-to-end) ------------------------------------


def _component_catalog() -> ComponentCatalog:
    return ComponentCatalog(
        [ComponentDefinition.model_validate(load_fixture("component_momentum"))]
    )


def test_componentized_strategy_a_matches_the_flat_strategy(market: MarketDataSet) -> None:
    flat = _evaluate(market, _load("strategy_a"), MAIN_DATE)
    composed = _evaluate(
        market, _load("strategy_a_component"), MAIN_DATE, components=_component_catalog()
    )
    assert composed.ok, composed.diagnostics
    assert flat.ok
    assert composed.targets == flat.targets
    # The component's internal nodes ran compositionally under the instance path.
    internal_ranks = composed.output_value(["mom", "rk"], "values")
    flat_ranks = flat.output_value(["rk"], "values")
    assert internal_ranks == flat_ranks


def test_componentized_strategy_a_warmup_exclusion_under_the_component(
    market: MarketDataSet,
) -> None:
    day = market.calendar.sessions[GLD_START_INDEX + 70].session_date
    flat = _evaluate(market, _load("strategy_a"), day)
    composed = _evaluate(
        market, _load("strategy_a_component"), day, components=_component_catalog()
    )
    assert composed.ok, composed.diagnostics
    assert composed.targets == flat.targets  # warm-up exclusion identical through the component
    exclusion = next(
        event
        for event in composed.trace
        if event.event_type == "transform.excluded" and event.payload.get("asset") == "GLD"
    )
    assert exclusion.component_path == ("mom",)
    assert exclusion.payload == {"asset": "GLD", "reason": "missing_anchor_close"}


def test_componentized_strategy_a_trace_carries_the_component_path(
    market: MarketDataSet,
) -> None:
    composed = _evaluate(
        market,
        _load("strategy_a_component"),
        IWM_MISSING_DATE,
        components=_component_catalog(),
    )
    assert composed.ok, composed.diagnostics
    exclusion = next(event for event in composed.trace if event.event_type == "transform.excluded")
    assert exclusion.component_path == ("mom",)
    assert exclusion.node_id == "ret"
    assert exclusion.payload == {"asset": "IWM", "reason": "missing_current_close"}
