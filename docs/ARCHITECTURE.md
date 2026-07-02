# ARCHITECTURE.md — Quantize

System boundaries and how the pieces fit. The invariants here are enforced in `CLAUDE.md`/`AGENTS.md`
and in tests.

---

## 1. System boundaries (the big picture)

```
┌──────────────────────────────────────────────────────────────────────┐
│  EDITOR (React + TypeScript)                                           │
│   • React Flow canvas  • parameter forms  • result & trace views      │
│   • imports GENERATED TS types from the published IR JSON Schema      │
│   • contains NO numerical / portfolio / type-compatibility logic      │
└───────────────▲───────────────────────────────────┬──────────────────┘
                │  JSON (IR in, results/traces out)  │
                │            FastAPI                  │
┌───────────────┴───────────────────────────────────▼──────────────────┐
│  API BOUNDARY (FastAPI)  — thin; serializes IR & results; no biz logic │
└───────────────▲───────────────────────────────────┬──────────────────┘
                │ validated IR document              │ results / traces
┌───────────────┴───────────────────────────────────▼──────────────────┐
│  PYTHON RUNTIME                                                        │
│   schema/        Pydantic models authoring the published JSON Schema  │
│   validation/    M1 structural · M2 semantic (registry-dependent)     │
│   registry/      node-type registry (uniform contracts; no switch)    │
│   runtime/       typed runtime values · executable node bindings (M3) │
│   market/        calendar · dataset · as-of DataView (M3-PRE; the     │
│                  MarketData adapter seam)                             │
│   nodes/         node implementations (pure in v0)                    │
│   components/    ComponentDefinition resolution + compositional eval   │
│   evaluator/     single-instant graph evaluation                      │
│   engine/        session-level event lifecycle (M4; wraps evaluator)  │
│   adapters/      Clock · Broker/Fills · Storage (M4+)                 │
│   tracing/       trace-event envelope (M2) + emission plumbing (M3)   │
│   results/       portfolio value, trades, returns, drawdown (M4)      │
│   persistence/   SQLite repo + migrations (M7; Postgres-targeted)     │
└───────────────────────────────────────────────────────────────────────┘
```

Arrows are JSON only. **pandas/numpy never cross the boundary**; they are runtime implementation
details. The published JSON Schema (authored in Pydantic) is the structural contract both sides obey.

### Source-of-truth hierarchy (used consistently across all docs)
1. The versioned **JSON strategy document** — persisted instance and semantic source of truth.
2. The published **JSON Schema** — language-neutral structural contract for a schema version.
3. **Pydantic** — the v0 authoring/generation/parsing/validation implementation.
4. **Registry rules + runtime invariants** — semantic validation.
5. **Generated TypeScript types** — consume the schema; never hand-maintained.

---

## 2. Frontend / backend separation (hard invariants)

- The frontend **edits the IR and renders results/traces. Nothing else.** No backtest math, no
  portfolio construction, no hand-duplicated type-compatibility logic.
- TS domain types are **generated** from the published JSON Schema. They are never hand-written; CI
  fails if they are stale (ADR-0001).
- The single `is_compatible` function lives in Python; the editor gets edge-compatibility from the
  API / generated metadata — it does not re-implement the rules.
- API contracts are plain JSON DTOs. No pandas DataFrame / numpy array / Python object is a contract.
- `ui.*` (coordinates, collapsed state) travels with the IR and is **preserved through round-trip**;
  it is **excluded from execution and semantic equality**, never discarded.

---

## 3. Runtime design — one session-level engine over one graph evaluator

Two layers, separated:

- **Graph evaluator** (single evaluation instant): given an as-of `DataView` + state, evaluates the
  DAG — including **compositional `ComponentRef` resolution** (no flattening, no stubs) — to produce
  `PortfolioTargets`.
- **Session-level engine**: drives the market-session lifecycle, calling the evaluator only when the
  schedule fires, and owning order reconciliation, fills, valuation, and persistence.

### Concerns kept separate (do not mix in one module)
market-session progression · strategy evaluation schedule · order queue · fill events · portfolio
valuation · stateful-node update cadence · trace construction · trace/result persistence ·
presentation (frontend only).

### The session-level event lifecycle (per market session)
```
1. Advance to the next market session.
2. At session OPEN: process orders due for this session.
3. Apply transaction costs; update cash and holdings.
4. At the VALUATION INSTANT (session close, v0): mark the portfolio to close prices.
5. At the EVALUATION INSTANT (after close), IF the schedule fires:
      • expose only data with data_available_at ≤ this instant
      • evaluate the strategy graph (compositional components)
      • produce PortfolioTargets
      • reconcile against current portfolio IN THE ENGINE:
            current portfolio + PortfolioTargets + execution policy → OrderList
      • queue resulting orders for the next permitted fill event (next valid session open)
6. Persist events, state, valuation, and structured traces.
```

"D+1" always means the **next valid exchange session**, not the next calendar day (weekends/holidays
skipped). v0 supports exactly **one** execution policy (`close_signal_next_session_open`), represented
explicitly so more can be added later, but no alternatives are implemented.

> **Reconciliation is a gated design decision (ADR-0005), not M1 work.** Step 5's
> `current portfolio + PortfolioTargets + policy → OrderList` is **not designed or implemented in M1**.
> Before the engine milestone (M4), an explicit reconciliation design decision must resolve:
> fractional vs. whole shares · sizing price · sell-before-buy ordering · transaction-cost reserves ·
> insufficient cash · no-op rebalances · weight tolerances. See `docs/ADRS/0005-order-reconciliation.md`.

### Separately modeled timestamps (recorded in results and traces)
observation time · data-availability time · evaluation time · signal time · order-creation time ·
scheduled-fill time · actual-fill time · valuation time.

### Temporal safety (calibrated claim)
The engine **structurally constrains** each evaluation to data whose availability time ≤ the
evaluation instant, and that constraint is **tested** at the node and engine levels. This eliminates
a whole *class* of look-ahead errors. It does **not** make look-ahead categorically impossible —
wrong availability timestamps, fixture mistakes, or node bugs can still introduce it, which the
look-ahead tests exist to catch.

### Adapter seam (the ONLY thing that differs between modes)
| Adapter | Backtest | Forward/paper (MVP) | Contract |
|---|---|---|---|
| **Clock** | iterate historical sessions | iterate fixture/uploaded sessions one at a time | `sessions()`, `next()` |
| **MarketData** | historical bars gated by availability | local fixture/uploaded data, same gating | `as_of(instant) -> DataView` |
| **Broker/Fills** | simulated fills + costs | simulated fills + costs | `fill(orders, session) -> fills` |
| **Storage** | run artifacts | run artifacts | `record(...)`, `load(...)` |

For the MVP, **forward/paper means deterministic incremental replay** over local fixture or uploaded
data, one market session at a time. There is **no** external real-time/EOD provider, network
scheduling, or brokerage integration. The same forward-driver contract later admits a live data
adapter and a real broker adapter — that is the only thing that changes.

### Backtest vs. forward consistency (calibrated claim)
Backtest and forward **share strategy semantics and node implementations** (one evaluator, one engine,
one set of nodes). This removes *implementation* divergence as a source of drift. It does **not**
guarantee identical outcomes: data sources, available history, and execution-environment differences
remain explicit and are exercised by the M8 consistency test, which asserts agreement on overlapping
decisions and stateful trajectories given equivalent data.

### Node registry (no giant switch statements)
Node types self-register a uniform contract (`STRATEGY_LANGUAGE.md §3`). Validator, planner,
evaluator, and the editor's descriptor endpoint all read the registry. Adding a node type is one
self-contained registration.

### Vectorization (deferred optimization, fenced by an invariant)
A future batch path may evaluate *pure* nodes over whole-history arrays for speed — admissible
**only** with a test proving identical outputs and identical timing to the incremental path. Until
that test exists, the incremental path is the only path. It must never become a second strategy
implementation.

---

## 4. Persistence

- **SQLite** for the MVP behind a thin **repository layer**. The schema is authored for PostgreSQL:
  UUID primary keys, explicit UTC timestamps, no SQLite-only features.
- **Migrations exist from the first persistence commit** — no ad-hoc `CREATE TABLE` drift.
- Stored entities: strategies `(id, version)`, standalone `ComponentDefinition` `(component_id,
  version)` with their pinned `component_refs`, runs, and results/traces keyed by run + session/instant.
- The **run record preserves the exchange calendar and timezone** used for that run, so session
  boundaries (and therefore weekly/monthly evaluation instants) are reproducible.
- The IR is stored as **validated canonical JSON** (the document is the unit of truth), not exploded
  into per-node tables.
- Moving to PostgreSQL later is **localized to the repository layer**, but still entails real work:
  dialect testing, migration authoring, and data migration. It is not a no-op (see ADR-0004).

---

## 5. Trace pipeline

Tracing is structured data, not log strings. A **minimal trace-event envelope** is fixed **early
(M2)** so registered node types can declare their `trace_schema` as soon as they exist; **detailed
construction is M6** and **persistence/retrieval is M7** (visualization M11). This resolves the
M2/M6 ordering: the envelope exists at M2; trees and storage come later.

- **Minimal envelope (M2):** `{ run_id, timestamp, node_id, component_path, event_type, payload }`
  (`STRATEGY_LANGUAGE.md §3`). `component_path` holds the ENCLOSING component-instance ids only
  (`[]` at top level); the emitting node is `node_id`, so full identity is
  `(component_path, node_id)`.
- Each node type declares a `trace_schema` (event types + payload shapes over the envelope) and emits
  typed events during evaluation: inputs seen, outputs produced, conditions passed/failed, assets
  removed by filters or missing-data exclusion, ranking results (with tie-breaks), target weights,
  applied constraints (e.g. cap redistribution), the engine's proposed orders, and **reasons an
  expected order did not fire**.
- Events carry the separately-modeled timestamps and the **hierarchical component path** so component
  structure is preserved.
- The engine assembles per-evaluation-instant trace trees (M6); persistence stores and serves them by
  run + instant/order (M7); the frontend renders what the schema defines — it never invents trace
  semantics.

---

## 6. Testing strategy

Financial correctness demands determinism and explicit data rules.

1. **Per-node unit tests** — correctness, **missing data** (exclusion rule), **canonical alignment**,
   **warm-up**, **look-ahead safety** (a node given an as-of `DataView` cannot read beyond it). No
   silent forward-fill/drop — the rule is asserted.
2. **Type/compatibility tests** — valid and invalid connections, including both reference strategies'
   exact wirings; the widening allow-list; rejection messages.
3. **Structural tests (M1)** — schema-version structure, field shape, unique ids, **source/target
   node-id existence (dangling node references)**, self-edge/cycle rules, `component_refs` shape
   (pinned versions, duplicate ref-ids, missing/recursive dependency references), JSON round-trip,
   **`ui` preservation**, **semantic equality excluding `ui`**, JSON Schema generation, TS generation,
   **stale-codegen detection**, deterministic valid/invalid fixtures. **M1 never checks port-name
   existence** (no node-type knowledge).
4. **Semantic tests (M2)** — registry-dependent: known node types, **input/output port-name
   existence**, required ports connected, port-type compatibility, parameter schemas, node-specific
   validation.
5. **Engine integration + golden** — Strategy A and B end-to-end over the fixture; portfolio-weight
   constraints, cap redistribution, cash-as-remainder, transaction costs, drawdown; committed golden
   snapshots so numeric changes are visible diffs.
6. **Backtest↔forward consistency (M8)** — same strategy historical vs. forward replay agree on
   overlapping decisions and stateful trajectories given equivalent data.

### Fixture contract (deterministic, no corporate actions, no network)
A fixture provides: an **exchange calendar**; a **timezone**; the set of **valid market sessions**;
each session's **open and close instants**; **open and close prices**; **data-availability
timestamps**; at least one **weekend or holiday boundary**; and **enough history for warm-up tests**.
Fixtures are synthetic/curated with **no corporate actions** and unambiguous prices; no reliance on
undocumented adjusted-price behavior.

---

## 7. Future boundaries (preserved, not built)

- **Custom math / sandboxed Python / ML inference** → new *node types* behind the registry (+ a
  sandbox executor for Python). Port/trace contracts unchanged; security/ops are out of MVP scope.
- **Optimizers** → `PortfolioTargets`-producing node types; may register a `Matrix` type via the type
  registry without touching existing validators.
- **Custom datasets / external APIs / event-driven data** → new input node types behind the
  **MarketData adapter**, obeying the availability-time discipline.
- **Live data + broker adapters / venues** → new implementations of the **MarketData** and
  **Broker/Fills** adapters. The IR, nodes, evaluator, and engine do not change. This is where live
  data and real-money execution would later plug in — a single, well-defined seam. Live trading would
  additionally require reconciliation of real fills plus operational/regulatory concerns, all out of
  scope now.
- **Collaboration / publishing / marketplace / licensing** → provenance, visibility, version pinning,
  and `forked_from` already exist; enforcement and discovery layer on later.
- **PostgreSQL / multi-user** → repository layer + UUID/UTC schema localize the change, which still
  requires migration and dialect-testing work.

No distributed infrastructure, message bus, Redis, Kubernetes, or microservices are introduced. The
MVP is a single Python process + a single-page editor + SQLite. Infrastructure is added only when a
demonstrated requirement forces it.

### The broker-adapter boundary (called out explicitly)
The path from "paper" to "live" is **one adapter implementation plus the operational/regulatory work
around it**, not a re-architecture. The engine emits an `OrderList` with explicit
order-creation/scheduled-fill times; a Broker adapter turns that into venue actions. Nothing upstream
of the adapter changes.
