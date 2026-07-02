# M3 — Graph Evaluator + Compositional Component Runtime (as-built design record)

**Scope:** M3-PRE (market-data fixture contract) + M3 (single-instant graph evaluator, the 12 core
node implementations, compositional component resolution/evaluation, trace plumbing).
**Status:** implemented 2026-07-01. This documents what was built, not aspiration.

## Runtime architecture (data flow)

```
StrategyDocument (persisted IR, M1)          ComponentDefinition docs (pinned refs)
        │                                              │
        │  1. structural validation (M1, reused)       │
        │  2. semantic validation (M2, reused,         │
        │     against the catalog's own descriptors)   │
        │  3. component resolution (M3) ───────────────┘
        │     fetch closure → recursion rejection → mapping/binding checks → instance tree
        │  4. M3 pre-flight: component-endpoint wiring, ambiguous fan-in, terminal rule
        ▼
   evaluate_strategy(document, catalog, market_data, run_id, evaluation_instant, components)
        │
        │  MarketDataSet.as_of(instant) ──► DataView   (availability-gated; THE temporal boundary)
        │  topological_order(...)          (Kahn + lexicographic tie-break; deterministic)
        ▼
   per node, in plan order:
        resolve binding by exact (type_id, type_version) → assemble inputs from the value store
        → NodeInvocation(params, inputs, view, trace sink) → evaluate → verify output ports/types
        → store under (node_path, port)
   component node: route exposed inputs to mapped internal ports → recurse into the internal
        graph under path + instance id (never flattened) → surface mapped exposed outputs
        ▼
   EvaluationOutcome { ok, diagnostics, targets (PortfolioTargets at the single terminal),
                       outputs (per node path/port), trace (ordered TraceEvents) }
```

Order reconciliation, fills, cash accounting, session progression, and persistence do **not**
exist here — the graph terminates in `PortfolioTargets` at `output.target_portfolio`; the engine
(M4, gated on ADR-0005) owns everything after that.

## Package map (new in M3)

- `quantize/market/` — M3-PRE. `calendar.py` (`MarketSession`, `ExchangeCalendar`), `data.py`
  (`PriceObservation`, `MarketDataSet`, `DataView`). Construction enforces the fixture data
  contract (calendar alignment, positive finite prices, availability ≥ session open/close).
  `as_of(instant)` is the only read path at evaluation time.
- `quantize/runtime/` — `values.py` (typed runtime values mirroring the `PortType` lattice,
  canonical asset order, domain-carrying cross-sections/series, portfolio invariants enforced at
  construction); `binding.py` (`NodeImplementation`, `ImplementationCatalog`, `NodeInvocation`);
  `diagnostics.py` (`RuntimeDiagnostic` + deterministic ordering).
- `quantize/components/` — `resolve.py`: `ComponentCatalog`, closure fetch, recursion rejection
  over the fetched closure (completing M1's bounded supplied-set check), exposed port/param
  mapping checks, per-instance effective-parameter binding (`ResolvedStrategy` instance tree).
- `quantize/evaluator/` — `plan.py` (deterministic topological order; declared warm-up
  resolution), `evaluate.py` (pre-flight + execution + terminal extraction), `errors.py` (codes).
- `quantize/nodes/` — the 12 core nodes + terminal, one self-contained registration each;
  `build_core_catalog()` returns a fresh catalog (no module-level mutable registry).
- `quantize/tracing/recorder.py` — ordered `TraceEvent` collection; events are stamped with the
  run id and the evaluation instant (never wall-clock).

## The implementation-binding boundary

Static **descriptors** (M2, editor-facing) and executable **bindings** (M3) are separate objects.
`ImplementationCatalog.register` also registers the descriptor into an internal `NodeRegistry`,
so semantic validation and execution can never disagree about a node type's contract
(`catalog.descriptor_registry` is what `evaluate_strategy` validates against). Resolution is
exact `(type_id, type_version)` — never "latest". Execution dispatches ONLY through the catalog;
there is no type-id switch (`output.target_portfolio` appears as a constant solely for the
terminal *rule*, not for dispatch). Future implementation forms (formulas, sandboxed code, model
artifacts, external services) become new ways to construct a `NodeImplementation`.

## Temporal semantics

- `DataView` is built once per evaluation from `MarketDataSet.as_of(instant)` and contains only
  observations with `*_available_at <= instant`; nodes cannot reach past it (constrained and
  tested — not "impossible").
- The dataset contract forbids an observation being *available* before its session
  opens/closes; delayed availability (vendor lag) is representable and gated correctly.
- "The latest session" is always the calendar's most recent close-visible session
  (`view.session_dates[-1]`), never an asset's own stale last observation.
- Signal evaluation and fills are not collapsed: M3 produces targets at the evaluation instant;
  fill timing is engine policy (M4).

## Missing-data semantics (per node, tested)

- `data.price`: assets keep an empty history (domain preserved) + trace event; no dropping.
- `transform.trailing_return`: needs closes at D and exactly D−L; missing either (or a calendar
  shorter than L+1 sessions, or a zero anchor in a derived series) excludes the asset (traced).
- `transform.moving_average`: an MA point exists only where all `window` calendar-session
  observations exist; gaps produce no point — never forward-filled.
- `transform.latest`: the value at the latest visible session; no stale substitution.
- `transform.rank`: ranks the present values only (1 = best; ratified tie-break by ascending
  canonical ticker); upstream-excluded assets stay excluded but remain in the domain.
- `logic.greater_than`: domain-preserving — every asset of the union domain appears; a missing
  operand yields `false` (traced), never omission.
- `portfolio.select_top_n`: smallest score wins (consumes rank output); unscored universe assets
  are excluded (traced); fewer than `n` qualifying is allowed.
- `portfolio.equal_weight` / `fixed_weight`: empty selection/universe → empty targets (all cash,
  traced); `fixed_weight` fails loudly on numeric over-allocation and never renormalizes.
- `portfolio.apply_mask`: false or missing mask → weight zeroed (traced); no renormalization.
- `risk.max_weight`: ratified iterative proportional waterfall; unresolvable remainder stays in
  cash; the cap is never violated.

Weight tolerance: `WEIGHT_TOLERANCE = 1e-9`, enforced at `PortfolioTargetsValue` construction
(weights finite, ≥ 0, sum ≤ 1 + tolerance; cash = remainder).

## Failure policy

Pre-flight (validation, resolution, wiring, terminal, no-visible-session) **accumulates**
diagnostics with their original stable codes and refuses to execute. Execution **stops at the
first failing node** (`node_execution_failed`, `wrong_output_ports`, `wrong_output_type`) — the
outcome keeps the diagnostics, the already-computed outputs, and the trace so far. Unexpected
programmer errors (naive instants, non-UUID run ids, cycles reaching the planner) still raise.

## The deterministic fixture (tests/market_fixture.py)

Synthetic exchange "QSE", fixed UTC-05:00 (no tz database dependency), weekday sessions
2025-01-02..2026-06-30 minus 15 listed holidays; opens 14:30Z, closes 21:00Z. Prices are exact
geometric paths (`100 * GROWTH[a]**session_index`), so trailing returns are `GROWTH**L - 1` and
the momentum order equals the growth order (QQQ > SPY > IWM > EFA > GLD > AGG > TLT > VNQ);
rising assets pass the 200-session MA trend filter, falling ones (TLT, VNQ) fail. Deliberate
irregularities: GLD lists 60 sessions late (warm-up exclusion); IWM has no observation on
2026-05-15 (missing-session exclusion).

## Explicitly deferred (not in M3)

Engine lifecycle/sessions loop, reconciliation/`OrderList`/fills/costs/cash (M4, ADR-0005 gate),
Strategy A/B end-to-end goldens (M4/M5), detailed trace payload construction + `trace_schema`
declarations for the core nodes (M6), trace/result persistence (M7), forward replay (M8), API
(M9), descriptor API (M10), UI (M11+). Runtime-value metadata (`as_of`/`data_available_at`/
`warmup_satisfied` per value, STRATEGY_LANGUAGE §2) is deferred to the engine/trace milestones
that consume it — M3 values are bare typed data over one shared evaluation instant. The
scalar-right-operand variant of `logic.greater_than` is deferred until a strategy needs it.

Carried debt (from the M3 Codex audit, deferred to the named milestones): the
`node_execution_failed` diagnostic message embeds the raised exception's text — fine for local
runs, but before the M9 API boundary the failure cause must become structured fields rather than
free text in a public contract.
