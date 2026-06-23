# AGENTS.md — Quantize

Guidance for any coding agent (and human reviewers) working in this repository. This complements
`CLAUDE.md`; where they overlap, treat the content as shared. Read the specs under `docs/` before
making changes: `PRODUCT.md`, `STRATEGY_LANGUAGE.md`, `ARCHITECTURE.md`, `ADRS/`, `MVP_PLAN.md`.

## One-paragraph orientation

Quantize is a visual OS for quantitative trading. A strategy is a **versioned, serializable JSON
document (the IR)** — the persisted instance and **semantic source of truth**. **One session-level
engine over one single-instant graph evaluator** runs that IR for historical backtesting and
forward/paper replay using **the same node implementations and semantics**; only the
Clock/MarketData/Broker/Storage **adapters** differ. Every evaluation emits **structured trace
events**. The runtime is Python (pandas/numpy as implementation details); the editor is React/TS.
**Source-of-truth hierarchy:** JSON document → published JSON Schema → Pydantic (v0
authoring/validation impl) → registry+invariants (semantic validation) → generated TS types. The
visual canvas is an editor for the IR — never the source of truth.

## System invariants (these are the review bar)

1. **IR document is authoritative.** `ui.*` is **preserved through round-trip** but **excluded from
   execution and semantic equality** (never discarded). No strategy meaning lives in the canvas/React
   Flow.
2. **One engine + evaluator + node set; shared semantics.** Backtest vs. forward replay differ only
   in adapters. No duplicate node/rule implementations per mode. **The graph terminates in
   `PortfolioTargets`; the engine owns reconciliation to `OrderList`** — there is no order-generation
   graph node.
3. **Temporal access is structurally constrained and tested — not "impossible."** Eval at instant T
   uses only data with availability ≤ T (enforced + tested). v0 has exactly **one** execution policy
   (`close_signal_next_session_open`): evaluate after session D close → fill at the **next valid
   exchange session open**. Eight timestamps (observation/data-availability/evaluation/signal/
   order-creation/scheduled-fill/actual-fill/valuation) recorded separately.
4. **Source-of-truth hierarchy for types.** JSON document → published JSON Schema → Pydantic (impl)
   → registry/invariants → generated TS. No hand-duplicated domain types; CI fails on stale TS.
5. **Frontend has no business logic.** No numerics/portfolio/compatibility logic in React; one
   shared `is_compatible` in Python.
6. **No Python objects in API contracts.** JSON DTOs only; no DataFrames/arrays across the boundary.
7. **Registry over switches.** Node types self-register a uniform contract.
8. **Components are standalone, real, versioned, compositional, non-recursive.** Separate immutable
   `ComponentDefinition` documents + pinned `ComponentRef`s. Not visual groups; never flattened; no
   stub expansion; **direct and transitive** recursion rejected; traces preserve hierarchy. Component
   runtime precedes any milestone that executes components; component authoring UI is separate.
9. **Fail loud** on unknown node types / unsupported schema versions.
10. **Explicit data rules** — no silent forward-fill/drop; documented and tested.
11. **Vectorization only as a test-proven-equivalent optimization** for pure nodes.

## Review criteria (use this checklist on every change)

- [ ] Does any strategy meaning leak into the canvas/UI, or any numerics into the frontend? → reject.
- [ ] Is there a second implementation of a node/rule for backtest vs. forward? → reject.
- [ ] Does the strategy graph terminate in `PortfolioTargets`, with order reconciliation owned by the
      engine (no order-generation graph node, no duplicate proposed-order node + reconcile path)? →
      reject otherwise.
- [ ] Is `ui.*` preserved through round-trip yet excluded from execution/semantic equality (not
      discarded)? → reject otherwise.
- [ ] Could a node read data beyond its as-of view (look-ahead)? Is there a test proving the
      constraint holds (claims must say "constrained and tested," not "impossible")?
- [ ] Are domain types hand-duplicated across Python/TS instead of generated? → reject.
- [ ] Does a pandas/numpy object cross the API boundary? → reject.
- [ ] Is a new node type added via the registry (not a central switch)? Is it needed by a concrete
      strategy, or just "to look broad"? → reject breadth-padding.
- [ ] Components: standalone `ComponentDefinition` + pinned `ComponentRef`, compositional (no
      flatten/stub), **direct and transitive** recursion rejected, hierarchy-preserving traces?
- [ ] Do unknown node types / unsupported schema versions fail with clear errors?
- [ ] Any silent forward-fill/data-drop without a documented rule + test? → reject.
- [ ] Tests: per-node (correctness, missing data, alignment, warm-up, look-ahead), compatibility,
      contract, golden, e2e, and (from M8) backtest↔forward consistency — present and **actually
      run**?
- [ ] Did the author run format + type-check + tests and report real results (not "should work")?
- [ ] Scope: any new asset class / infra / dependency without explicit approval + rationale? → reject.

## Definition of done for a change

Format, type-check, and tests have been **run** and pass (report actual output). The change touches
one milestone's concern, with no unrelated refactors. New behavior has tests. Invariants above hold.
Docs/`LEARNING_LOG.md` updated where relevant.

## Things that are explicitly out of scope (do not build)

Marketplace/social/payments/licensing enforcement; AI strategy generation; real brokerage / live
data feeds / streaming / intraday; corporate actions (splits/dividends/symbol changes/mergers/
delistings); additional execution policies; multi-user/teams; vectorized performance optimization;
broad indicator libraries; custom math/Python/ML node *implementations*. These are preserved as
architectural **paths** (see `ARCHITECTURE.md` §7), not work to do now.
