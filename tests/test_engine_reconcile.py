"""M4.5: ADR-0005 reconciliation — every worked example (A–H) and invariant (R1–R16 where
reconciliation-owned) as an executable test. Expected values are the ADR's hand calculations."""

from __future__ import annotations

import pytest

from quantize.engine.reconcile import DUST_RATIO, reconcile
from quantize.engine.state import PortfolioState
from quantize.runtime.values import PortfolioTargetsValue

_PRICES = {"AAA": 20.0, "BBB": 50.0, "CCC": 25.0}


def _targets(weights: dict[str, float]) -> PortfolioTargetsValue:
    return PortfolioTargetsValue.of(weights)


def _example_a_state() -> PortfolioState:
    return PortfolioState.of(cash=100.0, positions={"AAA": 5.0, "BBB": 2.0})


def _orders_of(outcome: object) -> list[tuple[str, str, float]]:
    return [(o.side, o.asset, o.quantity) for o in outcome.orders]  # type: ignore[attr-defined]


# --- ADR worked examples ------------------------------------------------------------------------


def test_example_a_simple_rebalance() -> None:
    outcome = reconcile(_example_a_state(), _targets({"AAA": 0.25, "CCC": 0.50}), _PRICES)
    assert outcome.ok
    assert outcome.portfolio_value == 300.0  # 100 + 5*20 + 2*50
    assert _orders_of(outcome) == [
        ("sell", "AAA", 1.25),  # 0.25*300/20 = 3.75 target, delta -1.25
        ("sell", "BBB", 2.0),  # absent from targets -> full liquidation
        ("buy", "CCC", 6.0),  # 0.50*300/25
    ]
    assert outcome.projected_cash == pytest.approx(75.0)  # 100 + 25 + 100 - 150 = 0.25*300
    assert outcome.target_cash == pytest.approx(75.0)


def test_example_b_liquidating_an_omitted_asset() -> None:
    state = PortfolioState.of(cash=0.0, positions={"BBB": 2.0})
    outcome = reconcile(state, _targets({}), {"BBB": 50.0})
    assert outcome.ok
    assert _orders_of(outcome) == [("sell", "BBB", 2.0)]  # exactly the held quantity
    assert outcome.projected_cash == pytest.approx(100.0)


def test_example_c_target_weights_below_one() -> None:
    state = PortfolioState.of(cash=300.0)
    outcome = reconcile(state, _targets({"AAA": 0.40}), {"AAA": 20.0})
    assert outcome.ok
    assert _orders_of(outcome) == [("buy", "AAA", 6.0)]
    assert outcome.projected_cash == pytest.approx(180.0)  # 0.60 * 300 intended residual cash
    assert outcome.target_cash == pytest.approx(180.0)


def test_example_d_already_at_target() -> None:
    state = PortfolioState.of(cash=75.0, positions={"AAA": 3.75, "CCC": 6.0})
    outcome = reconcile(state, _targets({"AAA": 0.25, "CCC": 0.50}), _PRICES)
    assert outcome.ok
    assert outcome.orders == ()
    assert [p.action for p in outcome.plans] == ["hold", "hold"]


def test_example_e_missing_price_atomic_failure() -> None:
    prices = {"AAA": 20.0, "CCC": 25.0}  # held BBB has no price
    outcome = reconcile(_example_a_state(), _targets({"AAA": 0.25, "CCC": 0.50}), prices)
    assert not outcome.ok
    assert outcome.orders == ()  # NO orders for AAA/CCC either — atomic
    assert [d.code for d in outcome.diagnostics] == ["missing_reconciliation_price"]
    assert outcome.diagnostics[0].subject == "BBB"
    assert outcome.portfolio_value is None and outcome.plans == ()


def test_example_f_sell_funded_rebalance() -> None:
    state = PortfolioState.of(cash=0.0, positions={"AAA": 10.0})
    outcome = reconcile(state, _targets({"BBB": 1.0}), {"AAA": 10.0, "BBB": 10.0})
    assert outcome.ok
    # The buy notional (100) exceeds current cash (0): legitimate, because the ratified fill
    # policy applies sells before buys. Reconciliation itself asserts nothing about fills.
    assert _orders_of(outcome) == [("sell", "AAA", 10.0), ("buy", "BBB", 10.0)]
    assert outcome.projected_cash == pytest.approx(0.0)


def test_example_g_floating_point_dust_is_omitted() -> None:
    state = PortfolioState.of(cash=75.0, positions={"AAA": 3.75, "CCC": 6.0})
    # Nudge AAA's holding by ~1 ULP: |delta|*price ~ 8.9e-15 <= 300*1e-9 -> omitted as dust.
    nudged = PortfolioState.of(cash=75.0, positions={"AAA": 3.7500000000000004, "CCC": 6.0})
    outcome = reconcile(nudged, _targets({"AAA": 0.25, "CCC": 0.50}), _PRICES)
    assert outcome.ok
    assert outcome.orders == ()
    aaa_plan = next(p for p in outcome.plans if p.asset == "AAA")
    assert aaa_plan.action == "dust"
    assert reconcile(state, _targets({"AAA": 0.25, "CCC": 0.50}), _PRICES).orders == ()


def test_example_h_post_fill_quiescence_and_replanning_stability() -> None:
    targets = _targets({"AAA": 0.25, "CCC": 0.50})
    first = reconcile(_example_a_state(), targets, _PRICES)
    assert first.ok
    # Property 1: replanning stability — bit-identical outcome from identical inputs.
    again = reconcile(_example_a_state(), targets, _PRICES)
    assert again == first
    # Property 2: apply the proposal completely at planning prices with zero costs (test-only
    # state update; Sigma(w) = 0.75 <= 1.0 so the guarantee applies) -> empty OrderList.
    filled = PortfolioState.of(cash=75.0, positions={"AAA": 3.75, "CCC": 6.0})
    assert reconcile(filled, targets, _PRICES).orders == ()


# --- invariants beyond the examples -------------------------------------------------------------


def test_targeted_asset_missing_price_fails_atomically() -> None:
    outcome = reconcile(PortfolioState.of(cash=100.0), _targets({"ZZZ": 0.5}), {"AAA": 20.0})
    assert not outcome.ok
    assert outcome.diagnostics[0].code == "missing_reconciliation_price"
    assert outcome.diagnostics[0].subject == "ZZZ"


@pytest.mark.parametrize("bad", [0.0, -5.0, float("nan"), float("inf")])
def test_invalid_price_fails_atomically(bad: float) -> None:
    state = PortfolioState.of(cash=0.0, positions={"AAA": 1.0})
    outcome = reconcile(state, _targets({}), {"AAA": bad})
    assert not outcome.ok
    assert outcome.diagnostics[0].code == "invalid_reconciliation_price"


def test_unheld_zero_weight_target_is_dropped_at_ingestion() -> None:
    # Explicit weight 0.0 for an UNHELD asset: no price required, no row, no order (ADR D5).
    state = PortfolioState.of(cash=100.0)
    targets = _targets({"AAA": 0.5, "VNQ": 0.0})  # VNQ unheld, weight 0, and unpriced
    outcome = reconcile(state, targets, {"AAA": 20.0})
    assert outcome.ok
    assert [p.asset for p in outcome.plans] == ["AAA"]


def test_held_zero_weight_target_liquidates_and_requires_a_price() -> None:
    state = PortfolioState.of(cash=0.0, positions={"VNQ": 4.0})
    outcome = reconcile(state, _targets({"VNQ": 0.0}), {"VNQ": 25.0})
    assert outcome.ok
    assert _orders_of(outcome) == [("sell", "VNQ", 4.0)]
    unpriced = reconcile(state, _targets({"VNQ": 0.0}), {})
    assert not unpriced.ok  # held clause of D8 still demands the valuation price


def test_sub_dust_holding_with_zero_target_still_liquidates() -> None:
    # The R9 liquidation exemption: a below-dust zero-target holding emits its full sell.
    state = PortfolioState.of(cash=1000.0, positions={"AAA": 1e-9})
    outcome = reconcile(state, _targets({}), {"AAA": 20.0})
    assert outcome.ok
    assert _orders_of(outcome) == [("sell", "AAA", 1e-9)]


def test_dust_boundary_both_sides() -> None:
    pv = 1000.0
    threshold = max(pv, 1.0) * DUST_RATIO  # notional threshold
    price = 10.0
    above = threshold * 1.01 / price
    below = threshold * 0.99 / price
    # Target quantity fixed by weight; craft holdings just above/below target.
    weights = _targets({"AAA": 0.5})
    target_qty = 0.5 * pv / price  # 50
    for offset, expect_order in ((above, True), (below, False)):
        state = PortfolioState.of(
            cash=pv - (target_qty - offset) * price,
            positions={"AAA": target_qty - offset},
        )
        outcome = reconcile(state, weights, {"AAA": price})
        assert outcome.ok
        assert bool(outcome.orders) is expect_order, offset


def test_projected_cash_within_aggregate_dust_bound() -> None:
    # Several individually-omitted dust deltas: projected cash equals target cash within
    # |union| * max(PV,1) * 1e-9 (ADR D7/R7 aggregate bound).
    pv = 1000.0
    weights = {"AAA": 0.25, "BBB": 0.25, "CCC": 0.25}
    prices = {"AAA": 10.0, "BBB": 10.0, "CCC": 10.0}
    threshold_qty = max(pv, 1.0) * DUST_RATIO / 10.0 * 0.9  # per-asset delta just under dust
    positions = {asset: 25.0 - threshold_qty for asset in weights}
    state = PortfolioState.of(
        cash=pv - sum(q * 10.0 for q in positions.values()), positions=positions
    )
    outcome = reconcile(state, _targets(weights), prices)
    assert outcome.ok
    assert outcome.orders == ()  # all three deltas are dust
    assert outcome.target_cash is not None and outcome.projected_cash is not None
    bound = 3 * max(pv, 1.0) * DUST_RATIO
    assert abs(outcome.projected_cash - outcome.target_cash) <= bound + 1e-12


def test_multiple_price_offenders_are_ordered_deterministically() -> None:
    # Two missing + one invalid price: one diagnostic per offender, canonical ordering by
    # (code, subject) under the shared runtime-diagnostic sort (R15 / D8).
    state = PortfolioState.of(cash=0.0, positions={"CCC": 1.0, "AAA": 1.0})
    targets = _targets({"BBB": 0.5})
    outcome = reconcile(state, targets, {"CCC": float("nan")})
    assert not outcome.ok and outcome.orders == ()
    assert [(d.code, d.subject) for d in outcome.diagnostics] == [
        ("invalid_reconciliation_price", "CCC"),
        ("missing_reconciliation_price", "AAA"),
        ("missing_reconciliation_price", "BBB"),
    ]


def test_reconcile_never_mutates_inputs() -> None:
    state = _example_a_state()
    targets = _targets({"AAA": 0.25, "CCC": 0.50})
    prices = dict(_PRICES)
    reconcile(state, targets, prices)
    assert state == _example_a_state()
    assert targets == _targets({"AAA": 0.25, "CCC": 0.50})
    assert prices == _PRICES


def test_orders_carry_no_price_attribute() -> None:
    outcome = reconcile(_example_a_state(), _targets({"AAA": 0.25, "CCC": 0.50}), _PRICES)
    assert all(not hasattr(order, "price") for order in outcome.orders)  # ADR R11


def test_ordering_is_sells_then_buys_canonical() -> None:
    state = PortfolioState.of(cash=0.0, positions={"DDD": 10.0, "AAA": 10.0})
    prices = {"AAA": 10.0, "BBB": 10.0, "CCC": 10.0, "DDD": 10.0}
    outcome = reconcile(state, _targets({"CCC": 0.5, "BBB": 0.5}), prices)
    assert outcome.ok
    assert _orders_of(outcome) == [
        ("sell", "AAA", 10.0),
        ("sell", "DDD", 10.0),
        ("buy", "BBB", 10.0),
        ("buy", "CCC", 10.0),
    ]


def test_pv_fold_matches_pinned_order() -> None:
    state = PortfolioState.of(cash=0.1, positions={"AAA": 0.1, "BBB": 0.2, "CCC": 0.3})
    prices = {"AAA": 1 / 3, "BBB": 1 / 7, "CCC": 1 / 11}
    outcome = reconcile(state, _targets({}), prices)
    expected = 0.1
    for asset in ("AAA", "BBB", "CCC"):
        expected += state.quantity_of(asset) * prices[asset]
    assert outcome.portfolio_value == expected  # bit-exact: same fold order


def test_explanation_rows_cover_the_reconciliation_asset_set() -> None:
    outcome = reconcile(_example_a_state(), _targets({"AAA": 0.25, "CCC": 0.50}), _PRICES)
    rows = {p.asset: p for p in outcome.plans}
    assert set(rows) == {"AAA", "BBB", "CCC"}
    assert rows["BBB"].target_weight == 0.0 and rows["BBB"].action == "sell"
    assert rows["CCC"].current_quantity == 0.0 and rows["CCC"].action == "buy"
    assert rows["AAA"].target_quantity == pytest.approx(3.75)
