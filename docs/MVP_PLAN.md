# MVP_PLAN.md — Quantize

Small, reviewable milestones, executed one at a time with review between them. The riskiest
correctness work (IR, nodes, evaluator, engine) ships **before any UI exists**. Structural concerns
(M1) are separated from registry-dependent semantics (M2); component **runtime** (M3) precedes
anything that executes components; component **authoring UI** (M12) is separate. Tracing
**construction** (M6) is separate from **persistence/retrieval** (M7).

Legend: ✅ acceptance criterion (must pass, with tests) · ⤵ deferred · ⚠ risk.

---

## M0 — Documentation & decisions — ✅ COMPLETE (accepted as the initial repository baseline)

✅ `PRODUCT.md`, `STRATEGY_LANGUAGE.md`, `ARCHITECTURE.md`, `ADRS/0001..0005`, `MVP_PLAN.md`,
`LEARNING_LOG.md`, `CLAUDE.md`, `AGENTS.md` exist and are internally coherent.
✅ Four foundational decisions + the M0-remediation founder decisions recorded.
✅ Overconfident claims calibrated; both reference strategies published as complete typed graphs.
✅ Approved by founder and Codex re-review; committed as the M0 baseline on `main`.
**Dependencies:** none. **Output:** reviewed docs; **no application code**.

> **Status:** M0 is documentation-only and **complete**. **M1 (IR schema + structural validation +
> codegen + fixtures) is the next milestone and has NOT begun.** ADR-0005 (order reconciliation) must
> be authored and accepted before M4, but is not required to start M1.

---

## M1 — IR schema + STRUCTURAL validation + codegen + fixtures *(no registry, no nodes, no UI)*

**Objective:** The IR exists as Pydantic models, publishes a JSON Schema, generates TS types, and is
validated **structurally** — without any node-type knowledge. Establish repo commands and the test
harness now.

✅ Pydantic models for the full IR: strategy, provenance, execution_policy, **discriminated `schedule`
variants (`{kind:"daily"|"weekly"|"monthly"}` — no ambiguous frequency+anchor)**, nodes, edges,
`component_refs`, and the standalone `ComponentDefinition` (with its own pinned `component_refs`) +
`ComponentRef` documents — with `schema_version`.
✅ **Structural** validation only — **no node-type knowledge, and explicitly NO port-name existence
check**: endpoint field shape; **source/target node ids exist** (dangling node references);
identifier uniqueness; prohibited self-edges; structural cycle rules; `component_refs` shape — pinned
versions required, duplicate ref-ids rejected, missing dependency references rejected, **direct and
transitive** dependency recursion/cycle rejected; unsupported `schema_version` → clear error.
✅ JSON round-trip; **`ui` preserved** through load/validate/serialize; **semantic equality excludes
`ui`**.
✅ JSON Schema generated via a **deterministic codegen command** (documented in `CLAUDE.md`); TS types
generated from the schema; **CI fails on stale generated types**.
✅ An injected **`NodeCatalog` protocol** + a small **test catalog** as scaffolding only — **no**
closed central switch and **no** real node implementations.
✅ Contract tests: representative payloads (incl. both reference strategies' documents) validate
consistently across Pydantic and the published schema.
✅ Deterministic **valid and invalid** fixtures committed; the **fixture data contract** (calendar,
timezone, sessions, open/close instants, prices, availability timestamps, ≥1 weekend/holiday
boundary, warm-up history) is implemented and documented.
✅ Repository commands (install, codegen, test, lint, type-check) defined and runnable; acceptance
tests run in CI.

**Dependencies:** M0. **Defers:** ⤵ registry, ⤵ node semantics, ⤵ engine, ⤵ persistence, ⤵ API.
**Risks:** ⚠ codegen toolchain friction (mitigate: pin tools, document command, test the staleness
gate). ⚠ scope creep into M2 (mitigate: no registry/types here).

---

## M2 — Node registry + SEMANTIC validation + the 12 core nodes *(no UI)*

**Objective:** The registry and the smallest set of correct, tested primitives; semantic validation.

✅ Registry: node types self-register the uniform contract; **no central switch**.
✅ **Semantic** validation (registry-dependent): known node types, **input/output port-name
existence**, required ports connected, **port-type compatibility** via the single `is_compatible`,
parameter schemas, node-specific validation. (Port-name existence is checked **here**, never in M1.)
✅ A **minimal trace-event envelope** is fixed here (`run_id, timestamp, node_id, component_path,
event_type, payload`) so each registered node declares its `trace_schema`; detailed trace
**construction** is M6, **persistence/retrieval** M7. (Resolves the M2/M6 ordering.)
✅ Documented compatibility table; valid/invalid edge tests (incl. both strategies' wirings).
✅ Implement the 12 core nodes (`STRATEGY_LANGUAGE.md §3`): `universe.fixed_list`, `data.price`,
`transform.trailing_return`, `transform.moving_average`, `transform.latest`, `transform.rank`,
`logic.greater_than`, `portfolio.select_top_n`, `portfolio.equal_weight`, `portfolio.fixed_weight`,
`portfolio.apply_mask`, `risk.max_weight`, terminating in `output.target_portfolio`.
✅ Per-node unit tests: correctness, **missing-data exclusion**, **canonical alignment/tie-breaks**,
**warm-up**, **look-ahead safety**, weight tolerance, cap redistribution, cash-as-remainder.
✅ The **registry descriptor model** (the data the editor will later need) is defined here, even
though its API surface ships in M10.

**Dependencies:** M1. **Risks:** ⚠ alignment/edge-case subtleties (mitigate: golden per-node tests).

---

## M3 — Graph evaluator + compositional component resolution *(single eval instant; no UI)*

**Objective:** Evaluate a strategy graph at one evaluation instant over an as-of `DataView`,
**including real compositional `ComponentRef` evaluation** — **no flattening, no stub expansion**.
This precedes any milestone that executes components.

✅ Topological planning; warm-up resolution; single-instant evaluation producing `PortfolioTargets`.
✅ `ComponentDefinition` resolution: missing-reference errors, dependency resolution, direct &
transitive recursion rejection, port mapping, parameter binding.
✅ Component evaluation is compositional; trace plumbing carries **hierarchical component paths**.
✅ Both reference strategies' graphs evaluate at a single instant over the fixture; a simple
component is evaluated end-to-end.
✅ Look-ahead test at evaluator level (an instant's evaluation cannot read data with availability >
that instant).

**Dependencies:** M1, M2. **Risks:** ⚠ component port/param edge cases (mitigate: dedicated tests).

---

## M4 — Session-level execution engine + Strategy A historical + golden *(no UI)*

**Objective:** The session-level event lifecycle wraps the M3 evaluator; Strategy A runs end-to-end
historically and deterministically.

⛔ **Design gate (blocking):** `docs/ADRS/0005-order-reconciliation.md` must be **completed and
accepted before M4 starts** — fractional vs. whole shares, sizing price, sell-before-buy ordering,
transaction-cost reserves, insufficient cash, no-op rebalances, weight tolerances. **No reconciliation
is designed or implemented in M1–M3.**
✅ Engine implements the 6-step lifecycle (`ARCHITECTURE.md §3`) with Clock/MarketData/Broker(sim)/
Storage adapters: session progression, order queue, fills at next valid session open, transaction
costs, valuation at session close, scheduled evaluation; **run record preserves calendar + timezone**.
✅ Engine owns reconciliation per ADR-0005: `current portfolio + PortfolioTargets + policy → OrderList`.
✅ Separately-modeled timestamps recorded in results.
✅ Strategy A end-to-end on the fixture → portfolio value, trades, returns, drawdown.
✅ **Golden snapshot** of Strategy A committed; numbers change only via reviewed diffs.

**Dependencies:** M3 **and accepted ADR-0005**. **Risks:** ⚠ metric math errors (mitigate: golden +
targeted metric tests).

---

## M5 — Strategy B historical (fixed sleeves, cash remainder) + risk redistribution + golden

**Objective:** Validate the fixed-sleeve / no-renormalization / cash-as-remainder semantics and cap
redistribution that Strategy A does not exercise.

✅ Strategy B end-to-end on the fixture; survivors keep fixed 0.25 sleeves, failures → 0, cash =
`1 − Σ(surviving sleeves)`, no renormalization.
✅ `risk.max_weight` iterative-proportional-waterfall redistribution test (a case that actually
overflows the cap).
✅ **Golden snapshot** of Strategy B committed.

**Dependencies:** M4. **Risks:** ⚠ sleeve/cash arithmetic (mitigate: explicit golden + unit tests).

---

## M6 — Structured trace CONSTRUCTION

**Objective:** Decision tracing as structured data, assembled during evaluation (not yet persisted).
Builds on the **minimal trace-event envelope fixed at M2** — this milestone is detailed
*construction*, not the envelope itself.

✅ Detailed `TraceEvent` payloads per node (event types + schema-versioned payloads over the M2
envelope): inputs, conditions passed/failed, assets filtered or excluded for missing data (incl. the
domain-preserving comparison case), ranks/tie-breaks, target weights, applied constraints, engine's
proposed orders, **reasons an order did not fire**.
✅ Events carry separately-modeled timestamps and **hierarchical component paths**.
✅ Engine assembles per-evaluation-instant trace trees in memory; covered by tests.

**Dependencies:** M4 (M5 in parallel acceptable). **Risks:** ⚠ trace schema churn (mitigate: version
trace events).

---

## M7 — Persistence + migrations + durable result/trace storage & retrieval

**Objective:** Durably store and retrieve strategies, components, runs, results, and traces.

✅ SQLite via repository layer; **migrations from this commit**; UUID/UTC; Postgres-targeted schema.
✅ Store validated IR documents and standalone `ComponentDefinition` docs; store run results and
trace trees keyed by run + session/instant.
✅ Retrieval: fetch results and the trace for a selected run + date/order without rerunning.

**Dependencies:** M6. **Risks:** ⚠ schema drift vs. IR evolution (mitigate: migrations + round-trip
tests).

---

## M8 — Forward/paper deterministic replay + backtest↔forward consistency

**Objective:** Prove shared semantics across modes using local data only.

✅ Forward driver reuses the **same** evaluator/engine/nodes via the Clock/MarketData adapters,
replaying fixture/uploaded data **one session at a time** (no network, no live feed, no broker).
✅ **State-consistency test uses a test-only stateful accumulator/counter node** (defined in the test
suite, **not** the product registry) to exercise stateful update cadence — no premature product
stateful node is added.
✅ **Consistency test:** Strategy A and B run historically and via forward replay agree on overlapping
decisions; the test-only accumulator's state trajectories agree given equivalent data; documented
environment differences are explicit.
✅ Both modes record the separately-modeled timestamps.

**Dependencies:** M4, M5, M6, M7. **Defers:** ⤵ live data adapter, ⤵ real broker.
**Risks:** ⚠ subtle timing mismatch (this test exists to catch exactly that).

---

## M9 — API boundary + strategy & component versioning

**Objective:** Save, version, and serve over a thin JSON boundary.

✅ FastAPI endpoints: validate IR (structural + semantic), run backtest, run forward replay, fetch
results, fetch traces, save strategy version, load strategy/version, create/list/load
`ComponentDefinition`s. **JSON DTOs only — no pandas/Python objects in contracts.**
✅ Strategy versioning ("save as new version" → increment `strategy.version`; `forked_from` lineage);
components immutable per version; `ComponentRef`s pinned.

**Dependencies:** M7, M8. **Risks:** ⚠ contract drift (mitigate: generated types + contract tests).

---

## M10 — Registry-descriptor + parameter-form metadata API *(editor prerequisites)*

**Objective:** Give the editor everything it needs to render nodes/params **before** building it.

✅ An endpoint exposes, per node type: ports (names/types), parameter schema + defaults, description,
and compatibility metadata derived from `is_compatible`.
✅ Parameter-form metadata sufficient for the editor to render and validate inputs without embedding
logic.

**Dependencies:** M2, M9. **Risks:** ⚠ descriptor/registry divergence (mitigate: generate descriptors
from the registry).

---

## M11 — Editor (the first legible screen)

**Objective:** Build→Test→Run→Inspect→Modify in the browser.

✅ React + React Flow: add nodes, connect compatible ports, **incompatible connections rejected with a
clear reason** (via the shared compatibility metadata), edit parameters (from M10 metadata).
✅ Validate, Run (backtest + forward replay), view results (portfolio value, trades, returns,
drawdown).
✅ Click a date / order / decision → render its structured trace (with component hierarchy).
✅ Save as a new version. Frontend imports **generated** TS types; contains **no** numerical logic.

**Dependencies:** M9, M10. **Risks:** ⚠ UI temptation to embed logic (mitigate: invariant + review).

---

## M12 — Component authoring/extraction UI *(separate from M3 component runtime)*

**Objective:** Reuse a connected subgraph as a real, versioned component, in the editor.

✅ Select a connected subgraph → convert to a `ComponentDefinition` → name it → expose ports/params →
reuse it via a pinned `ComponentRef`.
✅ Recursion rejected clearly in the UI; collapse/expand; traces preserve component hierarchy (runtime
already from M3).

**Dependencies:** M3, M11. **Risks:** ⚠ extraction edge cases (mitigate: rely on M3 runtime + tests).

---

## Cross-cutting acceptance (the MVP is done when…)

Mirrors `PRODUCT.md`: both reference strategies composed from general-purpose nodes; the versioned
JSON IR is the source of truth; invalid graphs/ports rejected clearly (structural + semantic); one
set of semantics for historical & forward replay; deterministic backtest reproduces goldens; user
inspects value/trades/returns/drawdown and structured decision reasons; a subgraph saved as a
reusable component (real compositional object); strategy modified & saved as a new version; unit/
integration/e2e tests pass; a **documented** path to custom math/Python components exists without
pretending it is built.

## Globally deferred (paths preserved, see ARCHITECTURE.md §7)

⤵ Marketplace/discovery/social/payments/licensing enforcement · ⤵ AI strategy generation · ⤵ live
data / real brokerage / streaming / intraday · ⤵ corporate actions (splits/dividends/symbol changes/
mergers/delistings) · ⤵ multi-user/teams/Postgres cutover · ⤵ vectorized performance optimization ·
⤵ broad indicator libraries · ⤵ additional execution policies · ⤵ custom math/Python/ML node
*implementations* (contract preserved, not built).

## Standing risks (watch every milestone)

⚠ Look-ahead leakage → temporal access is structurally constrained **and tested** (per-node +
evaluator + engine).
⚠ Backtest/forward drift → shared evaluator/engine/nodes; the M8 consistency test asserts agreement
given equivalent data; environment differences are explicit.
⚠ Cross-language schema drift → codegen + CI staleness gate + contract tests.
⚠ Scope creep ("add an asset class/indicator/policy to look broad") → guarded by CLAUDE.md/AGENTS.md
and review; new node types only when a concrete strategy needs them.
