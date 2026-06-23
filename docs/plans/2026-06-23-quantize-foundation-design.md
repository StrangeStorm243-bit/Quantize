# Quantize — Foundation Design (M0)

**Date:** 2026-06-23
**Status:** **Approved — accepted as the initial repository baseline.** Four foundational decisions
ratified by the founder; revised after the M0 adversarial audit and a focused Codex re-review (see
`docs/prompts/m0-remediation.md`) to calibrate overconfident claims, adopt the session-level
lifecycle, make both reference strategies fully typed, separate structural/semantic validation,
model standalone components with pinned nested dependencies, and the source-of-truth hierarchy.
M0 is documentation-only and complete; M1 (IR schema) is the next milestone and has **not** begun.
**Scope:** Architectural foundation for the smallest serious MVP of a visual operating system for quantitative trading.

This document is the durable record of the design conversation that produced the
documentation set under `docs/`. It captures *why* the foundation is shaped the way it
is. The normative specifications live in the individual docs it points to.

---

## 1. Product in one sentence

A visual IDE in which a self-directed systematic trader composes a strategy as a
**single versioned, serializable JSON document (the IR)** that one runtime evaluates for historical
backtesting and forward/paper replay **using the same node implementations and semantics**, with
**structured decision tracing** explaining every order.

Central promise: *Turn an existing systematic strategy into a visual, runnable system
without rewriting it between backtest and paper execution.*

## 2. The four ratified decisions

### A. One session-level engine over one graph evaluator
A session-level engine runs a market-session event lifecycle (session progression, order queue,
fills at the next valid session open, valuation at close, scheduled evaluation), calling a
single-instant graph evaluator only when the schedule fires. The evaluator sees only data whose
availability time ≤ the evaluation instant. Backtest replays history; forward is **deterministic
incremental replay** over local data with the same evaluator/engine/nodes — only adapters differ.
**Calibrated claims:** temporal access is *structurally constrained and tested* (not "impossible");
backtest and forward *share semantics and node implementations* (removing implementation drift),
while data/environment differences remain explicit and are tested. The graph terminates in
`PortfolioTargets`; the engine — not the graph — reconciles targets into orders. v0 implements
exactly one execution policy (`close_signal_next_session_open`). Vectorization is allowed later only
as a proven-equivalent optimization for pure nodes.

See: `docs/ADRS/0003-historical-vs-incremental-execution.md`, `docs/ARCHITECTURE.md`.

### B. Python runtime + TypeScript editor, explicit source-of-truth hierarchy
Python owns numerics; React/TS owns the editor; FastAPI is a thin JSON boundary. Source-of-truth
hierarchy: the **JSON strategy document** is the semantic source of truth; the published **JSON
Schema** is the structural contract; **Pydantic** is the v0 authoring/validation implementation;
**registry + invariants** give semantic validation; **TS types are generated** from the schema.
Domain types are never hand-duplicated; CI fails on stale generated types.

See: `docs/ADRS/0001-technology-stack.md`.

### C. Small explicit typed lattice
A deliberately small set of executable port types separating **structural shape** from
**financial meaning**, with exact compatibility plus a few explicit widening rules. One
central compatibility function serves both graph validation and editor feedback.

See: `docs/STRATEGY_LANGUAGE.md` §Type System.

### D. First-class versioned components (standalone)
Reusable subgraphs are **standalone immutable `ComponentDefinition` documents** referenced by pinned
`ComponentRef`s (identity, immutable version, schema version, internal graph, exposed typed ports with
internal-port mappings, exposed params with binding semantics, provenance). Evaluated compositionally
(never flattened, no stub expansion), with hierarchy-preserving traces. **Direct and transitive**
recursion is rejected. Component **runtime** precedes any milestone that executes components;
component **authoring UI** is a separate, later milestone.

See: `docs/STRATEGY_LANGUAGE.md` §Component Model.

## 3. The five risks this foundation is built to contain

1. **Look-ahead bias** → *constrained and tested* by the session-level engine's as-of evaluation +
   the eight explicit temporal stamps + the close-signal / next-valid-session convention. Not claimed
   impossible; the look-ahead tests target the residual paths (bad timestamps, fixture/node bugs).
2. **Backtest/forward drift** → *implementation* drift removed by one engine/evaluator/node set,
   adapters at the edges only; data/environment differences remain explicit and are tested (M8).
3. **IR/runtime coupling & versioning** → contained by the source-of-truth hierarchy (JSON document
   first), schema version from v0, `ui.*` preserved-but-excluded-from-semantics, standalone components.
4. **Type-system mis-design** → contained by a small explicit lattice with a single
   compatibility function and a registrable type representation.
5. **Cross-language schema drift** → contained by codegen from one source + CI staleness gate +
   contract tests on representative payloads.

## 4. Milestone sequence (summary)

M0 docs → M1 IR + **structural** validation + codegen + fixtures → M2 registry + **semantic**
validation + core nodes → M3 graph evaluator + **compositional component runtime** → M4 session
engine + Strategy A → M5 Strategy B + risk redistribution → M6 trace **construction** → M7
persistence + trace **storage/retrieval** → M8 forward replay + consistency → M9 API + versioning →
M10 registry-descriptor API → M11 editor → M12 component authoring UI.

Detail and acceptance criteria: `docs/MVP_PLAN.md`.

## 5. What is deliberately deferred

Marketplace, social, payments/licensing enforcement, AI strategy generation, real brokerage, live
data feeds, streaming/intraday, corporate actions (splits/dividends/symbol changes/mergers/
delistings), additional execution policies, multi-tenant orgs, vectorized performance optimization,
broad indicator libraries. These are preserved as *paths* (see `docs/ARCHITECTURE.md` §Future
Boundaries), not built.
