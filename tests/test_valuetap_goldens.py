"""M14.9 (DoD box 3): reference-strategy value taps anchored to committed goldens.

Both reference strategies are run through the full engine over the deterministic fixture and
persisted, then tapped through the ONE value-tap recompute. The anchors are deliberately
non-tautological — the served number is compared to a COMMITTED number, never to a second
recompute:

* The PortfolioTargets-producing nodes (``cap`` = ``risk.max_weight`` for Strategy A, ``mask`` =
  ``portfolio.apply_mask`` for Strategy B) are asserted against the target weights the EXISTING
  committed backtest goldens record (``tests/goldens/strategy_{a,b}_backtest.json``).
* The intermediate signal nodes (``ret``/``rk`` for A, ``gt`` for B) appear in NO existing golden,
  and their trace events record asset names, not values — so they are anchored by a freshly-minted,
  committed value-tap golden (``tests/goldens/valuetap_reference_signals.json``), regenerated only
  via ``pytest --update-goldens`` per the repo's golden discipline. Where a value is also cheaply
  hand-derivable or trace-consistent, a complementary independent assertion sits alongside the
  golden — but the committed golden is the anchor, not a substitute.

The ``tp`` terminal (``output.target_portfolio``) is deliberately NOT tapped: it exposes no output
ports and tapping it is ``value_address_not_found`` by design (covered in test_valuetap_service).
All fixture data; no network.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from quantize.engine.backtest import run_backtest
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository
from quantize.persistence.provenance import recorded_input_provenance
from quantize.persistence.runs import RunRepository
from quantize.runtime.values import CrossSectionValue, PortfolioTargetsValue
from quantize.schema.document import StrategyDocument
from quantize.valuetap import ResolvedNodeValue, resolve_node_value
from tests.golden_utils import assert_summary_matches_golden
from tests.helpers import load_fixture
from tests.market_fixture import fixture_close

RUN_A = "99999999-9999-9999-9999-999999999999"
RUN_B = "77777777-7777-7777-7777-777777777777"
CASH = 1_000_000.0
LOOKBACK = 126  # strategy_a's trailing-return window
_GOLDENS = Path(__file__).parent / "goldens"


def _run(name: str, market: MarketDataSet, run_id: str) -> tuple[StrategyDocument, BacktestResult]:
    document = StrategyDocument.model_validate(load_fixture(name))
    result = run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=run_id,
        initial_state=PortfolioState.of(cash=CASH),
    )
    return document, result


@pytest.fixture(scope="module")
def strategy_a(market: MarketDataSet) -> tuple[StrategyDocument, BacktestResult]:
    return _run("strategy_a", market, RUN_A)


@pytest.fixture(scope="module")
def strategy_b(market: MarketDataSet) -> tuple[StrategyDocument, BacktestResult]:
    return _run("strategy_b", market, RUN_B)


def _save_run(
    db: Database, document: StrategyDocument, result: BacktestResult, market: MarketDataSet
) -> None:
    RunRepository(db).save_run(document, result, input_provenance=recorded_input_provenance(market))


def _golden_targets(name: str, session: date) -> dict[str, float]:
    """The target weights the committed backtest golden records for ``session`` (the independent
    anchor for a PortfolioTargets tap — not a recompute)."""
    data = json.loads((_GOLDENS / f"{name}.json").read_text(encoding="utf-8"))
    for evaluation in data["evaluations"]:
        if evaluation["session"] == session.isoformat():
            return {asset: weight for asset, weight in evaluation["targets"]}
    raise AssertionError(f"golden {name} has no evaluation at {session.isoformat()}")


def _cross_section_summary(resolved: ResolvedNodeValue) -> dict[str, Any]:
    """A JSON-plain digest of a CrossSection tap for the minted value-tap golden."""
    value = resolved.value
    assert isinstance(value, CrossSectionValue)
    return {
        "port": resolved.output_port,
        "session": resolved.session_date.isoformat(),
        "dtype": value.dtype,
        "domain": list(value.domain),
        "present": list(value.present_assets),
        "missing": list(value.missing_assets),
        "values": {asset: served for asset, served in value.values},
    }


# --- PortfolioTargets nodes: anchored to the EXISTING committed backtest goldens ------------------


def test_strategy_a_cap_targets_match_committed_golden(
    db: Database,
    strategy_a: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
) -> None:
    """Strategy A's final PortfolioTargets node (``cap``) taps to exactly the target weights the
    committed ``strategy_a_backtest`` golden records at that session."""
    document, result = strategy_a
    DatasetRepository(db).save(market)
    _save_run(db, document, result, market)
    when = result.evaluations[-1].session_date
    resolved = resolve_node_value(db, run_id=RUN_A, node_id="cap", session_date=when)
    assert isinstance(resolved.value, PortfolioTargetsValue)
    assert resolved.value.as_dict() == _golden_targets("strategy_a_backtest", when)


def test_strategy_b_mask_targets_match_committed_golden(
    db: Database,
    strategy_b: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
) -> None:
    """Strategy B's final PortfolioTargets node (``mask``) taps to exactly the target weights the
    committed ``strategy_b_backtest`` golden records — including VNQ's masked-to-zero weight."""
    document, result = strategy_b
    DatasetRepository(db).save(market)
    _save_run(db, document, result, market)
    when = result.evaluations[-1].session_date
    resolved = resolve_node_value(db, run_id=RUN_B, node_id="mask", session_date=when)
    assert isinstance(resolved.value, PortfolioTargetsValue)
    assert resolved.value.as_dict() == _golden_targets("strategy_b_backtest", when)


# --- signal nodes: anchored to a freshly-minted, committed value-tap golden -----------------------


def test_reference_signal_taps_match_minted_value_golden(
    db: Database,
    strategy_a: tuple[StrategyDocument, BacktestResult],
    strategy_b: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
    update_goldens: bool,
) -> None:
    """``ret``/``rk`` (Strategy A) and ``gt`` (Strategy B) appear in no backtest golden; anchor
    their served values in a committed value-tap golden, with cheap independent cross-checks."""
    doc_a, res_a = strategy_a
    doc_b, res_b = strategy_b
    DatasetRepository(db).save(market)  # A and B share the same fixture dataset (content-addressed)
    _save_run(db, doc_a, res_a, market)
    _save_run(db, doc_b, res_b, market)
    when_a = res_a.evaluations[-1].session_date
    when_b = res_b.evaluations[-1].session_date

    ret = resolve_node_value(db, run_id=RUN_A, node_id="ret", session_date=when_a)
    rk = resolve_node_value(db, run_id=RUN_A, node_id="rk", session_date=when_a)
    gt = resolve_node_value(db, run_id=RUN_B, node_id="gt", session_date=when_b)

    summary = {
        "golden_format": 1,
        "strategy_a_ret": _cross_section_summary(ret),
        "strategy_a_rk": _cross_section_summary(rk),
        "strategy_b_gt": _cross_section_summary(gt),
    }
    assert_summary_matches_golden("valuetap_reference_signals", summary, update_goldens)

    # Complementary independent anchors (cheap, not a recompute):
    # ret — QQQ's 126-session trailing return equals the fixture arithmetic.
    assert isinstance(ret.value, CrossSectionValue)
    index = list(market.calendar.session_dates).index(when_a)
    expected_qqq = fixture_close("QQQ", index) / fixture_close("QQQ", index - LOOKBACK) - 1.0
    assert ret.value.as_dict()["QQQ"] == pytest.approx(expected_qqq)
    # gt — the True set equals Strategy B's surviving (non-zero-weight) sleeves in the mask golden.
    assert isinstance(gt.value, CrossSectionValue)
    surviving = {a for a, w in _golden_targets("strategy_b_backtest", when_b).items() if w > 0.0}
    gt_true = {asset for asset, served in gt.value.as_dict().items() if served is True}
    assert gt_true == surviving
