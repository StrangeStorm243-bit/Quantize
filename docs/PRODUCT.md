# PRODUCT.md — Quantize

## Product thesis

Quantize is a **visual operating system for quantitative trading**. A strategy is authored
once as a single, inspectable, **versioned object** and then *operated* — backtested, forward/paper
simulated, inspected, modified, and reused — without ever being rewritten between modes.

The wedge: serious systematic traders today fragment a single idea across spreadsheets,
TradingView/Pine, Python notebooks, alerts, and manual rebalancing. The same rule is
re-implemented (and subtly re-broken) at each stage. Quantize makes the **strategy definition
the single source of truth** and runs that one definition everywhere.

> **Core promise:** Turn an existing systematic strategy into a visual, runnable system
> without rewriting it between backtesting and paper execution.

The long-term ceiling is high — sophisticated mathematics, statistics, optimization, ML,
stateful models, custom datasets, proprietary packaged components, and an eventual component
marketplace. **None of that is in the MVP.** The MVP's job is to prove the spine — IR +
one engine + tracing — is sound enough to carry that ceiling later.

## Initial user

A **self-directed systematic trader** who already has explicit rules and currently stitches
together spreadsheets, TradingView/Pine Script, Python notebooks, alerts, and manual
scheduled rebalancing. Not a beginner; not a quant fund. They are testing whether Quantize
represents and operates *their existing strategy* more coherently than their current toolchain.

We are **not** building for absolute beginners (no education/onboarding hand-holding) nor for
institutional desks (no compliance, no multi-asset, no HFT).

## MVP scope

A private, single-user, local workspace in which the user can:

1. Visually compose a genuine rule-based stock/ETF strategy from general-purpose nodes.
2. Configure its parameters.
3. Run a deterministic historical backtest against fixture data.
4. Review portfolio value, trades, returns, and drawdowns.
5. Run the **same strategy definition** through forward/paper simulation.
6. Inspect *why* each decision and proposed order occurred (structured trace).
7. Modify a component.
8. Save the result as a new strategy version.
9. Reuse a connected group of nodes as a nested component.

### Domain constraints (hard boundaries for the MVP)

US-listed stocks & ETFs · daily bars · long-only · no leverage · no shorting · no options ·
no futures · no intraday/HFT · scheduled daily/weekly/monthly evaluation · simple transaction
costs · historical backtest + simulated/paper execution · one user · one local workspace ·
**no real-money brokerage connection.**

### The two reference strategies (must be composable from primitives, never special-cased)

- **Strategy A — ETF momentum rotation:** fixed ETF universe → trailing returns → rank →
  select top N → equal weight → max weight cap → rebalance monthly.
- **Strategy B — Trend-filtered portfolio:** fixed universe where each asset has a **fixed equal
  sleeve** (e.g. 25% of four). Assets passing the price-vs-moving-average trend filter **keep their
  sleeve**; failing assets go to zero; survivors are **not renormalized**; the unfilled allocation is
  **cash = `1 − Σ(surviving sleeves)`**. Scheduled rebalance. (A future node may renormalize
  survivors — that is explicitly *not* Strategy B.)

## Explicit non-goals (MVP)

- Production brokerage execution; real money; broker adapters wired to live venues.
- Regulatory/compliance workflows.
- Real-time streaming or intraday/HFT infrastructure.
- Billing, payments, licensing enforcement, royalties.
- Mobile; polished public launch.
- Complex authentication; multi-tenant organizations; team workspaces.
- A social feed, followers, likes, comments, public profiles, leaderboards, copy trading,
  recommendations, marketplace.
- A large library of indicators (hundreds of presets).
- AI-generated trading advice or LLM-dependent strategy generation. The graph and IR remain
  authoritative and deterministic.
- Vectorized performance optimization (correctness and consistency come first).

These are **deferred, not foreclosed.** `docs/ARCHITECTURE.md` documents the preserved paths.

## Core user journey

**Build → Test → Run → Inspect → Modify.**

1. **Build** — add nodes to the canvas, connect compatible ports (incompatible connections are
   rejected with a clear reason), edit parameters.
2. **Test** — validate the strategy (structural + type + schedule checks).
3. **Run** — execute a deterministic historical backtest over fixture data; then run the same
   definition forward.
4. **Inspect** — review portfolio value / trades / returns / drawdown; click a date, order, or
   decision and read its structured trace (inputs, conditions passed/failed, assets filtered,
   ranks, target weights, applied constraints, proposed orders, reasons an order did *not* fire).
5. **Modify** — change a component or parameter; save as a new version; optionally collapse a
   subgraph into a reusable component and reuse it.

## Success criteria

The MVP is successful when **all** of the following hold (mirrors the founder's acceptance list):

1. Both reference strategies are composed entirely from general-purpose nodes (no special-case
   strategy code).
2. The saved strategy is a versioned, serializable IR — the source of truth.
3. Invalid graphs and incompatible ports are rejected with clear, structured errors.
4. Historical and forward evaluation use the **same** strategy semantics and node
   implementations.
5. A deterministic backtest runs against fixture data and reproduces golden snapshots.
6. The user can inspect portfolio value, trades, returns, and drawdown.
7. The user can inspect structured reasons for a selected decision.
8. A group of nodes can be saved/represented as a reusable nested component (real compositional
   object, not a visual group).
9. A strategy can be modified and saved as a new version.
10. Unit, integration, and end-to-end tests pass.
11. There is a *documented* path to custom mathematical / Python components, without pretending
    that functionality already exists.

## How we will know we are off-track

- A node implementation exists in two places (backtest vs. forward).
- Numerical logic appears inside a React component.
- A pandas object crosses the API boundary.
- A new asset class or indicator is added "to look broad."
- Either reference strategy required strategy-specific engine code.
- A test forward-fills or drops data without a documented rule.
