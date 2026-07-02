# ADR-0005: Order reconciliation (`PortfolioTargets → OrderList`)

- **Status:** Accepted (2026-07-02; proposed 2026-07-01, ratified by the founder after two
  independent review rounds). This resolves the design gate that blocked M4.
- **Deciders:** Founder + principal architect
- **Related:** ARCHITECTURE.md §3, STRATEGY_LANGUAGE.md §2–§3/§6, PRODUCT.md (domain constraints),
  ADR-0003 (execution model), MVP_PLAN.md (M4/M5), docs/plans/2026-07-01-m3-runtime-design.md,
  `quantize/runtime/values.py` (`PortfolioTargetsValue`, `WEIGHT_TOLERANCE`)

## Context

The strategy graph terminates in `PortfolioTargets` (M3). The **engine** — never the graph —
turns that allocation into orders: `current portfolio + PortfolioTargets + execution policy →
OrderList` (invariant 2). The one v0 execution policy is fixed: signals are evaluated **after
session D closes**; engine action occurs **no earlier than the next valid session's open**
(ADR-0003, STRATEGY_LANGUAGE §6). The session lifecycle (ARCHITECTURE §3) reconciles at the
**evaluation instant** (step 5) and fills queued orders at the **next session's open** (step 2).

Already ratified and NOT revisited here:

- `PortfolioTargets` invariants: weights finite, ≥ 0, `Σw ≤ 1 + 1e-9`; **cash is the explicit
  remainder `1 − Σw`** with exactly one owner; canonical (ascending-ticker) asset order;
  `WEIGHT_TOLERANCE = 1e-9` (STRATEGY_LANGUAGE §2–§3, enforced at `PortfolioTargetsValue`
  construction since M3).
- Domain constraints: US-listed stocks/ETFs, daily bars, **long-only, no leverage, no shorting**,
  simple bps transaction costs, no real brokerage (PRODUCT.md).
- Temporal discipline: an instant sees only data with availability ≤ that instant; **no silent
  stale substitution** (ADR-0003, M3 `DataView`).
- `OrderList` is engine-produced only — not a graph port type, not a node output
  (STRATEGY_LANGUAGE §2, enforced since M1).

This ADR fixes the **reconciliation contract** M4 will implement. It deliberately does NOT design
fill simulation, transaction-cost math, slippage, brokerage integration, order persistence,
asynchronous order lifecycles, corporate actions, or UI behavior. Where reconciliation and the
future fill layer meet, this ADR fixes the *policy boundary* (what each layer may assume of the
other) without designing the fill layer.

## Decision

### D1. Scope and preconditions

Reconciliation is a **pure, deterministic planning function** executed by the engine at the
evaluation instant of session D (after D's close), immediately after the evaluator returns
`PortfolioTargets`:

```text
reconcile(portfolio_state, targets, reconciliation_prices) → ReconciliationOutcome
```

Preconditions (engine-guaranteed in v0):

- **Settled snapshot, no pending orders.** The v0 lifecycle is synchronous: orders queued at D's
  evaluation fill at the D+1 open, strictly before any later evaluation, so the order queue is
  empty at every reconciliation. Reconciliation therefore operates ONLY on a settled portfolio
  snapshot; it does not know about, net against, or cancel open orders. (Pending-order awareness
  is a deferred extension — see §Future compatibility.)
- **Single currency.** Prices and cash share one abstract currency unit; no FX.
- **Long-only, unlevered.** Position quantities ≥ 0; settled cash ≥ 0. A snapshot violating this
  is an `invalid_portfolio_state` failure, not an input to interpret.
- Reconciliation **does not mutate** the portfolio snapshot, the targets, or any shared state; it
  returns a proposal.

### D2. Inputs (exact)

1. **`PortfolioTargets`** — the M3 terminal value, taken as-is (already invariant-checked at
   construction).
2. **Portfolio state snapshot** — `positions: asset → quantity` (finite floats, ≥ 0; zero-quantity
   entries are canonicalized away) and `settled cash` (finite, ≥ 0). Cash is engine state, never a
   tradable asset.
3. **Reconciliation prices** — for each relevant asset, the **session-D close** observation, i.e.
   the same close data the signals were evaluated over, availability-gated ≤ the evaluation
   instant (supplied by the engine from the as-of `DataView` for the evaluation instant).
4. **The evaluation instant** (recorded as the order-creation time; the scheduled-fill time is the
   next valid session's open — two of the eight separately-modeled timestamps).

Asset identity is the ticker string, in canonical ascending order — the same identity and order
used everywhere since M1.

### D3. Sizing price = session-D close (planning price, never an assumed fill price)

Target weights become quantities using **session-D close prices** — the prices that are actually
knowable at the reconciliation instant.

Rejected alternatives (see the matrix below): sizing at the **next open** is look-ahead — the open
price does not exist at the instant reconciliation runs (the lifecycle reconciles at step 5 of
session D; the D+1 open is observed at step 2 of the next session). Sizing at some *other* prior
close would discard information the signals already used, for no benefit.

Consequences, stated honestly:

- The reconciliation price is a **planning price only**. Fills occur at the D+1 open at whatever
  that price turns out to be; the realized post-fill portfolio will deviate from the target by the
  overnight move plus costs. This drift is expected, visible in results, and corrected at the next
  scheduled rebalance. Reconciliation MUST NOT be interpreted as predicting fill prices.
- The required price is the close observation **at session D exactly** (availability ≤ instant).
  If an asset's D close is missing or not yet available (vendor delay), reconciliation MUST NOT
  substitute an earlier close — that is the forbidden silent stale-fill. Missing prices are a
  hard failure (D8).

### D4. Portfolio value

```text
portfolio_value = settled_cash + Σ over held assets (quantity(a) × close_D(a))
```

- "Held" means quantity > 0 after canonicalization.
- **Summation order is pinned:** the sum is a left-to-right fold over held assets in canonical
  (ascending-ticker) order, seeded with `settled_cash`. Float addition is non-associative, so the
  bit-identical determinism guarantee (D12/R1) requires this order to be part of the contract,
  not an implementation accident.
- Every held asset MUST have a valid D-close price (finite, > 0); every targeted asset (weight
  > 0) likewise. Zero, negative, or non-finite prices are invalid (`invalid_reconciliation_price`)
  — the fixture/data contract already forbids them at the dataset boundary, so this is a defensive
  failure, not an expected path.
- v0 has no reserved buying power, no short liabilities, no borrowing, no margin: portfolio value
  is exactly cash plus long market value.

### D5. Target semantics

- **Absent asset ⇒ target weight zero.** A held asset omitted from the targets is liquidated in
  full (D7). An explicit `weight: 0.0` entry is semantically identical to absence (Strategy B
  produces exactly such entries via `apply_mask`) and is **dropped at ingestion**: it never
  enters the reconciliation asset set, requires no price, and produces no explanation row unless
  the asset is also held — in which case it participates exactly as any other held zero-target
  asset (full liquidation, price required for valuation via the *held* clause of D8).
- **`Σw < 1` ⇒ intended residual cash** of `(1 − Σw) × portfolio_value`. Cash is a target
  *consequence*, never an order: no cash order exists.
- Weights are ≥ 0 and `Σw ≤ 1 + 1e-9` **by construction** (M3); reconciliation does not re-derive
  or re-normalize them, and negative targets are impossible by that ratified contract. A single
  weight may equal 1.0 (full allocation to one asset); no weight can exceed 1 + 1e-9.

### D6. Quantity model: fractional shares (float64)

v0 sizes positions in **fractional quantities** (IEEE-754 float64, the same representation as the
rest of the runtime).

- No rounding step exists in v0 reconciliation: `target_quantity = target_notional / price`
  exactly as computed in float64. The only quantity policy is the dust tolerance (D9) and the
  canonicalization of negative zero (`-0.0 → 0.0`).
- Whole-share sizing and per-asset precision are **deferred, with the seam preserved**: a future
  per-asset quantization rule (lot size / decimals, applied between target-quantity and delta
  computation, with a defined residual-cash policy) slots into D7 without changing any other part
  of this contract (§Future compatibility).

Why fractional wins for v0 (full comparison in the matrix): deterministic with no rounding
algorithm to ratify, targets exactly reachable (which makes idempotence and the M4/M5 goldens
crisp), matches the paper-trading MVP (no broker imposes lot rules), and the whole-share
alternative forces THREE extra decisions today (rounding direction, residual-cash policy,
unreachable-target policy) that would exist only to simulate a constraint no v0 component has.

### D7. The reconciliation equation

The **reconciliation asset set** is `assets = canonical_sort(held(quantity > 0) ∪
targeted(weight > 0))` — explicit zero-weight target entries for unheld assets are already gone
(D5), and held zero-target assets enter via the *held* clause. Over that set:

```text
portfolio_value       = settled_cash + Σ quantity(a) × close_D(a)          (held assets)
target_notional(a)    = target_weight(a) × portfolio_value                 (absent ⇒ weight 0)
target_quantity(a)    = target_notional(a) / close_D(a)
delta_quantity(a)     = target_quantity(a) − current_quantity(a)
```

- `delta > 0` ⇒ **buy** `delta`; `delta < 0` ⇒ **sell** `−delta`; deltas within the dust
  tolerance (D9) are omitted — EXCEPT full liquidations, which are always emitted (next bullet).
- **Liquidation is the zero-target case of the same equation**: held but untargeted ⇒
  `target_quantity = 0` ⇒ sell exactly the full current quantity (an exact subtraction, so no
  float residue — the sell quantity for a zero-target asset MUST equal the held quantity).
  Full-liquidation sells are **exempt from the dust gate**: a zero-target holding emits its sell
  however small, so no orphan sub-dust position can survive a rebalance indefinitely.
- A sell quantity MUST NOT exceed the current quantity (long-only guarantees `target_quantity ≥ 0
  ⇒ delta ≥ −current_quantity`; implementations clamp defensively and treat a violation as a
  programming error).
- **Two cash quantities, kept distinct.** The *mathematical target cash* of the full equation is
  `(1 − Σw) × portfolio_value` — an identity of the unomitted deltas:
  `cash − Σ buy_notional + Σ sell_notional = (1 − Σw) × PV` when EVERY delta trades. Because
  `Σw ≤ 1 + 1e-9`, it is bounded below by `−1e-9 × PV` — negative only within the ratified weight
  tolerance (the same boundary where `PortfolioTargetsValue.cash_weight` clamps to 0), and
  protected in practice by the fill layer's cash floor (D11.3). The *post-emitted-orders projected
  cash* — computed over the EMITTED `OrderList`, after dust omission (D9) — differs from target
  cash by the aggregate omitted dust, bounded by `|assets in the union| × max(PV,1) × 1e-9` (each
  omitted delta is individually ≤ one dust threshold). The explanation table (D14) reports both.
  Real fill-time cash is D11's concern.
- Assets targeted at weight > 0 but absent from the price set, or held without a price, have
  already failed reconciliation atomically (D8) before this equation runs.

### D8. Missing/invalid prices ⇒ atomic failure

If ANY asset in `held(quantity>0) ∪ targeted(weight>0)` lacks a valid session-D close (missing,
not-yet-available, zero, negative, or non-finite), reconciliation **fails atomically**: `ok =
False`, **zero orders**, one deterministic diagnostic per offending asset
(`missing_reconciliation_price` / `invalid_reconciliation_price`, canonical order).

Rejected: *skip-affected-assets* silently rebalances the rest against a portfolio value that
cannot be computed honestly (a held asset without a price has unknown value — every weight
computation would be wrong, not just that asset's). *Partial orders with warnings* is the
"superficially successful but incomplete rebalance" this ADR is required to prevent. Atomic
failure is the only policy consistent with "explicit data rules; fail loud."

Engine policy in v0: a failed reconciliation is **run-fatal** (the backtest/replay aborts with the
diagnostics). The fixture data contract makes prices complete for valid sessions, so this fires
only on genuine data-integrity faults — exactly when a run's numbers should not be trusted.
(A softer "skip this rebalance, keep holdings, continue" mode is a possible future engine option;
it would change results and therefore requires its own ratified decision — deferred, not chosen.)

### D9. Rebalance/dust tolerance (the no-op rule)

One centralized rule, value-scaled so it is portfolio-size-independent:

```text
DUST_RATIO = 1e-9   (one constant, defined once in engine code, reused by tests)
emit an order for asset a iff |delta_quantity(a)| × close_D(a) > max(portfolio_value, 1) × DUST_RATIO
```

- Full liquidations (target weight zero/absent) are exempt: they are emitted regardless of size
  (D7), so the dust gate applies only to assets that remain targeted.
- This suppresses float noise (post-fill re-reconciliation deltas are ~1e-13 relative) without
  being a trading policy: 1e-9 of portfolio value is dust by any standard, while a real drift
  band (e.g. "don't trade moves under 25 bps") is a *product* feature deferred to a future
  configurable rebalance band.
- The ratio deliberately reuses the magnitude of the ratified `WEIGHT_TOLERANCE = 1e-9`: a
  portfolio matching its targets within the weight tolerance produces no orders.
- `max(portfolio_value, 1)` keeps the rule meaningful for a degenerate near-zero portfolio.

### D10. Output: `OrderList` (a proposal)

```text
Order      = { side: "buy" | "sell", asset: ticker, quantity: float > 0 }
OrderList  = tuple of Orders: all sells (canonical asset order), then all buys (canonical order)
```

- **Proposal semantics.** An `OrderList` is the engine's *proposed* trades, priced by nothing:
  it carries **no price field** (the planning price is trace/explanation data, not an order
  attribute — a price on the order would masquerade as an expected fill price, which D3 forbids).
  Reconciliation does not apply it; the fill layer does.
- Quantities are positive finite floats (side carries the sign); `-0.0` never appears;
  zero/dust-quantity orders are omitted entirely (never emitted as zero rows).
- **List order is canonical presentation, not execution semantics.** Sells-first/canonical-within
  makes output deterministic and human-auditable; the fill layer's sell-before-buy behavior is an
  independent policy guarantee (D11), NOT something inferred from list position. No phase markers
  exist in v0.
- Order identity (ids) is not part of the reconciliation contract; the M4 engine may key queued
  orders internally (e.g. by session + index), and durable identity arrives with persistence (M7).
- The `ReconciliationOutcome` carries: `ok`, the `OrderList` (empty iff nothing to trade or
  failed), deterministic diagnostics, and the per-asset explanation table (D14). `ok = False ⇒
  orders = ()` — never a partially-populated list alongside a failure.

### D11. Funding and feasibility (the reconciliation/fill policy boundary)

**Reconciliation emits mathematically exact net deltas** (policy 1 of the four candidates) and
performs no cash-feasibility constraint, no proceeds simulation, and no cost reserve. At planning
prices the plan is self-funding by construction (D7); whether it remains affordable at actual
fill prices is an execution-time fact reconciliation cannot know without simulating fills — which
would collapse the reconciliation/fill boundary.

To make that boundary safe, this ADR **ratifies the following constraints on the M4 fill model**
(policy only; the fill design itself is M4 work):

1. Within a fill event (the next valid session's open), **sells are applied before buys**, each
   side in canonical asset order.
2. Transaction costs (the policy's bps model) are applied **at fill**, per order; there is **no
   ex-ante cost reserve** in reconciliation.
3. **Settled cash MUST NOT go negative.** If, after sells and costs, remaining cash cannot fund a
   buy order in full, the fill layer scales that buy down deterministically and records the
   reason the order did not fully fire — feeding the M6 trace requirement "reasons an order did
   not fire." The ratified *policy* is only: buys are processed in canonical order and later buys
   bear any shortfall; the precise scaling mechanics are M4 fill-design work, not part of this
   contract.
4. Fill prices are the D+1 open observations, availability-gated like everything else.

So: buys ARE allowed to depend on sell proceeds — not because reconciliation assumes fills, but
because the ratified fill sequencing *guarantees* sells settle first within the same event.
Rejected alternatives: constraining buys to pre-sale cash (policy 2) makes an ordinary full
rotation — Strategy A's monthly sell-X-buy-Y — impossible without multi-session dribbling;
assuming sells fund buys *inside reconciliation* (policy 3) bakes a fill assumption into the
planner; ex-ante proportional buy scaling (policy 4) distorts targets to defend against a price
move that usually doesn't happen, and does it at the wrong layer with information it doesn't have.

### D12. Determinism

Identical inputs MUST produce an identical `ReconciliationOutcome`, bit-for-bit:

- Orders: sells (ascending ticker) then buys (ascending ticker) — same-side ties cannot exist
  because assets are unique.
- Arithmetic is plain float64 evaluated in the documented D7 order; no set/dict iteration order
  may influence any output (iteration is over canonically sorted assets).
- Diagnostics sorted by (asset/subject, code) — the same deterministic-ordering discipline as the
  M1/M2/M3 diagnostic layers.
- No wall-clock, locale, path, or environment dependence.

### D13. Idempotence (two distinct properties, both required)

1. **Replanning stability:** same snapshot + same targets + same prices ⇒ the same `OrderList`
   (pure function; nothing is consumed or mutated).
2. **Post-fill quiescence (guaranteed for `Σw ≤ 1.0`):** if the proposed orders are applied
   *completely at the planning prices and with zero transaction costs* (a hypothetical state
   update for testing — reconciliation itself never mutates state, and real bps costs would dwarf
   the dust ratio), re-reconciling with the same targets and prices yields an **empty**
   `OrderList`: every residual delta is float noise below the D9 dust rule, and no
   full-liquidation sell remains (the liquidated positions are now zero, hence no longer held).

   **The tolerated overweight band `Σw ∈ (1, 1+1e-9]` is excluded from this guarantee:** there a
   "complete" planning-price fill is infeasible by definition (it would require
   `(Σw−1) × PV ≤ 1e-9 × PV` more cash than exists, violating the settled-cash precondition), so
   the hypothetical update is instead *fills under the D11 policy* (sells, then buys against the
   cash floor). The resulting shortfall is bounded by `1e-9 × PV` in aggregate, so any residual
   re-reconciliation deltas are at most dust-scale; the normative quiescence test (R12, blueprint
   item 8) is scoped to `Σw ≤ 1.0`. The band exists to absorb weight-construction float noise
   (real M3 producers overshoot by ULPs, not by 1e-9) — it is headroom, not a design target.

At *actual* (D+1 open) fill prices, property 2 intentionally does NOT hold — the overnight move
creates real drift, corrected at the next scheduled evaluation. That is a feature of honest
planning, not a defect.

### D14. Diagnostics and minimal traceability

Stable machine codes (snake_case, matching the M1/M2/M3 diagnostic conventions; all are **errors**
in v0 — the runtime has no warning severity yet):

| code | condition |
|---|---|
| `missing_reconciliation_price` | held(qty>0) or targeted(w>0) asset lacks a session-D close at the instant |
| `invalid_reconciliation_price` | price present but zero/negative/non-finite |
| `invalid_portfolio_state` | negative/non-finite quantity or cash, or a malformed snapshot |
| `unsupported_position` | a snapshot position that v0 cannot hold (defensive; e.g. short) |

(`insufficient_buying_power` is deliberately NOT a reconciliation diagnostic — under D11 it is a
fill-time event, surfaced by the fill layer as an order-did-not-fully-fire trace, named in M4.
A targeted asset the data layer has never heard of surfaces as `missing_reconciliation_price`;
asset-universe validity as such is enforced upstream by the M2/M3 validation layers, not here.)

Minimal explanation data (needed for inspectability and for M4's deterministic tests — full trace
construction remains M6): the outcome carries `portfolio_value`, the mathematical target cash,
the post-emitted-orders projected cash (both defined in D7), and one row per asset in the
reconciliation asset set (D7 — unheld zero-weight entries have no row): `{asset, price,
current_quantity, target_weight, target_notional, target_quantity, delta_quantity, action
(buy/sell/hold/dust)}`, in canonical order.

### D15. Explicitly deferred (safe boundaries stated)

Pending/open orders (precondition D1: settled snapshot only); partial-fill handling and any
drift-triggered *unscheduled* re-reconciliation (v0 re-plans only at scheduled evaluations);
whole shares / per-asset precision / minimum notionals; fees beyond the fixed bps-at-fill policy;
slippage; multi-currency; shorting/leverage/margin; tax lots; broker order types/constraints;
configurable rebalance bands; cash reservations; order persistence and durable order identity
(M7); detailed trace payloads (M6).

## Resolution of the seven gate questions (from the placeholder ADR)

1. **Fractional vs whole shares** → fractional float64, no rounding step (D6); whole-share seam
   preserved.
2. **Sizing price** → session-D close: the evaluation session's close, the only honest price at
   the reconciliation instant; planning-only, never an assumed fill (D3).
3. **Sell-before-buy** → yes, ratified as a fill-event guarantee (sells settle before buys within
   the D+1 open event), not as a reconciliation assumption (D11).
4. **Transaction-cost reserves** → none. Costs are applied at fill; feasibility is protected by
   fill-time sequencing plus deterministic buy scaling, so cash cannot go negative (D11).
5. **Insufficient cash** → at planning prices a shortfall cannot exceed the ratified 1e-9 weight
   tolerance (Σw ≤ 1 + 1e-9, D7); at fill time, buys scale down deterministically in canonical
   order with a traced reason (D11).
6. **No-op rebalances** → value-scaled dust rule: omit orders with `|Δq|·price ≤ max(PV,1)·1e-9`
   (D9); product-level rebalance bands deferred.
7. **Weight tolerances** → the ratified 1e-9 accounting tolerance is reused as the dust ratio, so
   "matched within weight tolerance" and "emits no orders" coincide (D9); no second tolerance is
   introduced.

## Alternatives considered (decision matrix)

Scored − / ○ / + per criterion: **Cor**rectness, **Sim**plicity, **Det**erminism,
**Aud**itability, **Rea**lism, **M3**-compatibility, **Fut**ure-execution compatibility,
**Imp**lementation cost, **Mig**ration cost. Chosen row in **bold**.

**Quantity model** — whole shares add rounding/residual/unreachable-target policy for zero v0
benefit; per-asset precision is premature configuration.

| model | Cor | Sim | Det | Aud | Rea | M3 | Fut | Imp | Mig |
|---|---|---|---|---|---|---|---|---|---|
| **fractional (float64)** | + | + | + | + | ○ | + | + | + | + |
| whole shares | ○ | − | ○ | ○ | + | + | + | − | + |
| per-asset precision | ○ | − | ○ | ○ | + | + | + | − | + |

**Funding model** — exact deltas keep the planner pure; the fill layer owns cash safety.

| model | Cor | Sim | Det | Aud | Rea | M3 | Fut | Imp | Mig |
|---|---|---|---|---|---|---|---|---|---|
| **exact net deltas + ratified fill sequencing** | + | + | + | + | + | + | + | + | + |
| buys limited to pre-sale cash | − | ○ | + | ○ | − | + | ○ | ○ | − |
| reconciliation assumes sells fund buys | ○ | ○ | + | − | ○ | + | − | ○ | − |
| ex-ante proportional buy scaling | − | − | + | − | ○ | + | ○ | − | − |

**Failure model** — anything softer than atomic hides an unpriceable portfolio.

| model | Cor | Sim | Det | Aud | Rea | M3 | Fut | Imp | Mig |
|---|---|---|---|---|---|---|---|---|---|
| **atomic failure (run-fatal in v0)** | + | + | + | + | ○ | + | + | + | + |
| partial orders + warnings | − | ○ | ○ | − | ○ | + | ○ | ○ | − |
| skip affected assets | − | ○ | ○ | − | − | + | − | ○ | − |

**Ordering model** — canonical sells-first is deterministic and reads like the fill policy without
claiming to be it.

| model | Cor | Sim | Det | Aud | Rea | M3 | Fut | Imp | Mig |
|---|---|---|---|---|---|---|---|---|---|
| **sells-first canonical (presentation) + fill-event guarantee (policy)** | + | + | + | + | + | + | + | + | + |
| single canonical list, no side grouping | + | + | + | ○ | ○ | + | + | + | + |
| explicit sell/buy phases in the contract | ○ | − | + | ○ | ○ | + | − | − | − |

**Price model** — the next open is unknowable at the instant (look-ahead); older closes discard
information; caller-supplied "executable" prices smuggle a fill model into the planner.

| model | Cor | Sim | Det | Aud | Rea | M3 | Fut | Imp | Mig |
|---|---|---|---|---|---|---|---|---|---|
| **session-D close (planning price)** | + | + | + | + | ○ | + | + | + | + |
| next-session open | − (look-ahead) | ○ | + | ○ | + | − | ○ | ○ | − |
| earlier close | ○ | + | + | ○ | − | + | + | + | + |
| caller-supplied executable prices | ○ | − | ○ | − | + | ○ | ○ | − | − |

**Drift policy** — one epsilon; bands are product features.

| model | Cor | Sim | Det | Aud | Rea | M3 | Fut | Imp | Mig |
|---|---|---|---|---|---|---|---|---|---|
| **value-scaled dust epsilon (1e-9)** | + | + | + | + | ○ | + | + | + | + |
| exact (no tolerance) | − (churn/dust) | + | + | ○ | − | + | + | + | + |
| minimum notional | ○ | ○ | + | ○ | + | + | + | ○ | ○ |
| weight-band rebalancing | ○ | − | + | ○ | + | + | + | − | − |

## Worked examples (all under the ratified rules; prices are session-D closes)

### A — Simple rebalance

```text
cash 100; holdings AAA 5, BBB 2; prices AAA 20, BBB 50, CCC 25
targets AAA 0.25, CCC 0.50 (residual cash 0.25)

portfolio_value = 100 + 5×20 + 2×50 = 300
AAA: target 0.25×300 = 75  → 75/20  = 3.75 sh → Δ = 3.75 − 5 = −1.25 → SELL 1.25
BBB: absent ⇒ 0            → 0      = 0    sh → Δ = 0 − 2     = −2   → SELL 2
CCC: target 0.50×300 = 150 → 150/25 = 6    sh → Δ = 6 − 0     = +6   → BUY 6

OrderList = [sell AAA 1.25, sell BBB 2, buy CCC 6]
projected cash at planning prices = 100 + 25 + 100 − 150 = 75 = 0.25×300 ✓
```

### B — Liquidating an omitted asset

`holdings BBB 2 @ 50, cash 0; targets {}` ⇒ PV = 100, BBB target 0 ⇒ `[sell BBB 2]` (the sell is
exactly the held quantity — zero-target liquidation is exact, no float residue). Projected cash
100 (all-cash target, Σw = 0).

### C — Target weights below one

`cash 300, no holdings; targets AAA 0.40 @ 20` ⇒ PV = 300 ⇒ `[buy AAA 6]`; projected cash
`0.60 × 300 = 180` — residual cash is an intended outcome, not an error, and generates no order.

### D — Already at target

Example A's targets against `holdings AAA 3.75, CCC 6, cash 75` (same prices): every Δ = 0
exactly ⇒ `OrderList = []`, `ok = True`.

### E — Missing price (atomic failure)

Example A with BBB's D-close missing (held, no valid price): outcome is `ok = False`,
`orders = ()`, diagnostics `[missing_reconciliation_price(BBB)]`. NO orders for AAA/CCC are
emitted — the portfolio cannot be valued, so every weight would be wrong. v0 engine treats this
as run-fatal.

### F — Sell-funded rebalance

`cash 0; holdings AAA 10 @ 10; targets BBB 1.0 @ 10` ⇒ PV = 100 ⇒
`[sell AAA 10, buy BBB 10]`. The buy (notional 100) exceeds current cash (0) and is funded by the
sell — legitimate because the ratified fill policy applies sells before buys within the D+1 open
event. Reconciliation itself asserts nothing about fills; at actual open prices the buy may scale
down under D11.3 (e.g. if BBB opens higher), which the fill layer records.

### G — Floating-point dust

`PV = 300`; suppose post-arithmetic `target_quantity(AAA) = 3.7500000000000004` vs held `3.75`:
`|Δ| × 20 = 8.9e-15 ≤ max(300,1) × 1e-9 = 3e-7` ⇒ omitted. No 9-femto-share order is ever
proposed.

### H — Reconciliation after complete fills (idempotence property 2)

Apply Example A's orders at the planning prices to the snapshot (test-only state update):
`AAA 3.75, BBB 0, CCC 6, cash 75`. Re-reconcile with the same targets and prices: PV = 300, all
deltas ≤ float noise ⇒ `OrderList = []`. Same inputs re-run without the update reproduce Example
A's list bit-for-bit (property 1).

## Normative invariants (become M4 acceptance tests)

- **R1** Reconciliation MUST be a pure function: identical inputs produce a bit-identical
  `ReconciliationOutcome`; it MUST NOT mutate the snapshot, the targets, prices, or any shared
  state.
- **R2** `OrderList` MUST remain engine-owned: it MUST NOT be a graph port type, node output, or
  component exposure (unchanged M1–M3 contract).
- **R3** Reconciliation MUST consume `PortfolioTargets` exactly as produced by the M3 terminal —
  no re-normalization, no reinterpretation of weights.
- **R4** Sizing/valuation prices MUST be session-D close observations with availability ≤ the
  reconciliation instant; a missing or invalid price for any held(qty>0) or targeted(w>0) asset
  MUST fail the whole reconciliation atomically (`ok=False`, zero orders, deterministic
  diagnostics). Stale substitution MUST NOT occur.
- **R5** `portfolio_value = cash + Σ qty × close_D` (single currency, long-only, unlevered,
  settled cash only).
- **R6** An asset absent from targets (or with weight 0) MUST be treated as target zero; a held
  zero-target asset MUST be sold in exactly its full current quantity.
- **R7** `Σw < 1` MUST leave `(1−Σw) × PV` as the mathematical target cash, and the cash
  projected from the EMITTED `OrderList` MUST equal it within
  `|union assets| × max(PV,1) × 1e-9` (the aggregate dust bound); cash MUST NOT be a tradable
  asset or generate an order.
- **R8** Quantities are fractional float64; sell quantities MUST NOT exceed current holdings;
  `-0.0` MUST be canonicalized; no zero-quantity order may be emitted.
- **R9** For assets with target weight > 0, an order MUST be emitted iff
  `|Δq| × price > max(PV,1) × 1e-9` (the single centralized dust rule). Full liquidations (R6)
  are exempt from this gate and are always emitted.
- **R10** `OrderList` ordering MUST be: sells in ascending ticker order, then buys in ascending
  ticker order; the ordering is canonical presentation and MUST NOT be required for correctness
  by any consumer other than determinism checks.
- **R11** Orders MUST NOT carry prices; the outcome MAY carry planning prices in its explanation
  data.
- **R12** Post-fill quiescence: for targets with `Σw ≤ 1.0`, applying the proposal completely at
  planning prices with zero costs and re-reconciling MUST yield an empty `OrderList`. (For the
  tolerated overweight band a complete fill is infeasible; see D13 — residuals there are bounded
  by the dust scale under the D11 update and carry no normative emptiness guarantee.)
- **R13** The fill layer (M4) MUST apply sells before buys within one fill event, apply bps costs
  at fill, and MUST NOT drive settled cash negative — an unaffordable buy is scaled down
  deterministically (canonical order) with a recorded reason. Reconciliation MUST NOT assume any
  other fill behavior.
- **R14** Reconciliation MUST NOT read anything outside its declared inputs (no DataView spelunking
  past session D, no wall-clock, no environment).
- **R15** Diagnostics MUST use the stable codes of D14, deterministically ordered; `ok=False`
  outcomes MUST carry zero orders.
- **R16** Pending orders MUST NOT exist at reconciliation in v0 (engine lifecycle guarantee); the
  contract MUST NOT silently net against them if that guarantee is ever relaxed (that relaxation
  requires a new decision).

## M4 acceptance-test blueprint (categories + representative cases)

1. **Valuation:** cash-only; holdings-only; mixed (Example A's PV=300); zero-value portfolio;
   `invalid_portfolio_state` on negative cash/quantity/non-finite inputs.
2. **Target conversion:** hand-computed target notionals/quantities (Example A); weight exactly
   1.0; empty targets ⇒ full liquidation.
3. **Reconciliation asset set:** asset only-held (liquidation), only-targeted (new position),
   both; canonical ordering; an UNHELD explicit zero-weight target with a MISSING price neither
   fails nor produces a row/order (dropped at ingestion, D5); a HELD zero-weight target requires
   a price and liquidates.
4. **Liquidation exactness:** zero-target sell equals held quantity bit-for-bit (Example B).
5. **Fractional math + residual cash:** Examples A/C; post-emitted-orders projected cash equals
   the mathematical target cash `(1−Σw)×PV` within the aggregate dust bound
   `|union| × max(PV,1) × 1e-9`, including a many-asset case where several deltas are
   individually omitted as dust.
6. **Ordering/determinism:** sells-before-buys, ascending tickers; permuted input dict/mapping
   orders produce identical output; repeated invocation bit-equality (R1).
7. **No-op & dust:** Example D (empty at target); Example G (dust omitted); a delta just ABOVE
   the threshold is emitted (boundary test both sides); a sub-dust holding with target weight
   ZERO still emits its full-liquidation sell (the R9 exemption).
8. **Idempotence:** Example H (post-fill quiescence at planning prices, scoped to targets with
   `Σw ≤ 1.0` per R12/D13); drift NOT suppressed at
   different prices (re-reconciliation at moved prices produces corrective orders).
9. **Missing/invalid prices:** Example E; targeted-but-unpriced asset; zero/negative/NaN/Inf
   price ⇒ `invalid_reconciliation_price`; price whose availability is AFTER the instant is
   invisible (uses the delayed-availability fixture pattern from M3) ⇒ missing, not stale-substituted.
10. **Temporal boundary:** reconciliation at D's evaluation instant cannot see D+1 opens
    (future-price invisibility); weekend/holiday: scheduled-fill session is the next VALID session
    (Friday evaluation ⇒ Monday open; pre-Good-Friday ⇒ Monday), reusing the M3 fixture calendar.
11. **Fill-policy conformance (fill-layer tests, same ADR):** sells applied before buys; bps
    costs at fill; cash floor honored via deterministic buy scaling with recorded reason;
    Example F executes fully at unchanged prices.
12. **No mutation:** snapshot/targets/prices deep-equal before and after (mirrors M3's
    no-mutation tests).
13. **M3 integration:** Strategy A's targets at a fixture instant flow through reconciliation to
    hand-checked orders; Strategy B's masked (weight-0) entries liquidate when held and are
    ignored when unheld; both feed the M4
    Strategy-A golden.
14. **Diagnostic stability:** codes and ordering asserted exactly; `ok=False ⇒ orders == ()`.
15. **Order shape (R11):** an `Order` carries no price attribute (asserted on the type/contract);
    planning prices appear only in the explanation table.
16. **Architectural/lifecycle invariants (R2, R16):** R2 (no graph-level `OrderList`) remains
    covered by the existing M1/M3 type-lattice tests (`OrderList` is not a constructible port
    type); R16 (no pending orders at reconciliation) is asserted as an engine-lifecycle invariant
    in the M4 engine tests (queue empty at every evaluation instant), not as a reconciliation
    unit test.

## Scope & future compatibility (how the contract avoids blocking later work)

- **Whole-share brokers / minimum notionals / per-asset precision:** a quantization step between
  D7's target-quantity and delta lines, plus a residual-cash policy — additive; no other section
  changes.
- **Fees/slippage models:** live entirely in the fill layer (D11 already routes costs there).
- **Partial fills / pending orders:** relax the D1 precondition by adding pending-order state to
  the snapshot and netting rules — target semantics (D5) and the equation (D7) are unchanged;
  R16 explicitly reserves this as a new decision.
- **Cash reservations / buying-power models:** a new snapshot field consumed by D4; the planner
  stays pure.
- **Multi-currency:** prices become (price, currency) with an FX layer inside D4's valuation;
  order shape is unchanged.
- **Shorting/leverage:** would relax D1's long-only precondition and D5's non-negativity — big,
  deliberate changes that today's contract states as explicit invariants rather than hidden
  assumptions, so relaxing them is a visible ADR, not a drift.
- **Tax lots / broker order constraints / rebalance bands:** downstream of the proposal — they
  consume or filter the `OrderList` (or replace D9's epsilon with a governed band) without
  touching the equation.

## Consequences

- M4 can implement the engine lifecycle against a complete, deterministic, hand-testable
  reconciliation contract; the Strategy A golden (M4) and Strategy B sleeve/cash semantics (M5)
  have exact expected values.
- Backtests remain honest: no look-ahead sizing, no silent stale prices, no negative cash, drift
  from planning to fill is visible in results rather than hidden by the planner.
- The planner stays pure and stateless, so forward replay (M8) reuses it unchanged — only the
  adapters differ (ADR-0003).
- Cost accepted: fractional shares and bit-exact planning are less "broker-realistic" than
  whole-share simulation; realism arrives later behind the preserved quantization seam, when a
  real constraint demands it.
- The seven gate questions of the previous placeholder are resolved; **M4 is unblocked** and
  implements this contract (the M4 acceptance-test blueprint above is its test obligation).
