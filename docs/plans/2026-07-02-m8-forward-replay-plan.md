# M8 — Deterministic Forward/Paper Replay + Backtest↔Forward Consistency (2026-07-02)

Plan-of-record per `PLAN_TEMPLATE.md`. Implements MVP_PLAN §M8 / ARCHITECTURE §3 (adapter table,
calibrated consistency claim) / STRATEGY_LANGUAGE §5 (test-only stateful node).
**Core invariant (Architectural invariant 2): one engine, one evaluator, one node set. Forward
replay must be the SAME loop body as the backtest — never a second implementation of any node,
reconciliation, fill, trace, or persistence rule. The modes differ only in how sessions are
fed (Clock) — MarketData/Broker/Storage adapters are already mode-identical.**

## Authoritative contract (reconstructed)
- Forward/paper = deterministic incremental replay over LOCAL fixture/uploaded data, one market
  session at a time. No network, live feed, or broker (deferred adapters).
- Both modes share evaluator/engine/nodes via the Clock/MarketData seams; consistency test
  asserts agreement on overlapping decisions for Strategies A and B, identical test-only
  accumulator state trajectories given equivalent data, and documents environment differences.
- Both modes record the separately-modeled timestamps (M6 instants — already mode-agnostic).
- M7-loaded run records/traces serve as STORED HISTORICAL FACTS in the comparison — loaded via
  the repositories, never recomputed-and-pretended.

## Design

### Engine core extraction (`quantize/engine/backtest.py`)
Extract the existing per-session loop body verbatim into an engine core (`SessionEngine`) owning
the mode-agnostic machinery: document-derived config (schedule, warm-up, costs), calendar,
accumulators (valuations, evaluations, fills, notes, stale marks, trace), `state`, `pending`
(order list + scheduled fill session), `step(session)` (the CURRENT loop body, moved — not
rewritten), and `finish() -> BacktestResult` (metrics + assembly, current code moved).
`run_backtest` becomes: construct `SessionEngine`, iterate `run_window` sessions through `step`,
`finish()`. Byte-identical behavior is enforced by the full existing suite (657 tests + all
goldens) passing untouched.

### Clock seam (as built)
The Clock contract per ARCHITECTURE's adapter table is the pure `run_window` session sequence
(already in `backtest.py`, reused verbatim by both modes — never a re-derived filter): the
backtest iterates it wholesale; `ForwardReplay` holds a cursor over the SAME sequence and
feeds one session per `advance()`. No separate protocol module is warranted at v0 — the clock
decides ONLY which sessions are fed and when, never what happens within one.

### Forward driver (`quantize/engine/forward.py`)
`ForwardReplay(document, catalog, market_data, run_id, initial_state, last_session,
first_session=None, collect_trace=True)` — `last_session` REQUIRED (amendment 1), enforced at
runtime, not just by type:
- `advance() -> SessionAdvance | None` — feeds exactly the next eligible session to the SAME
  `SessionEngine.step`; returns a small frozen summary (session date, whether an evaluation fired,
  fills applied, portfolio value) or `None` when the clock is exhausted.
- `result() -> BacktestResult` — `finish()` over everything advanced so far (callable at any
  point; the consistency tests call it after full replay).
- `snapshot() -> ForwardCheckpoint` / `ForwardReplay.resume(checkpoint, document, catalog,
  market_data, ...)` — deterministic restart: the checkpoint carries the session cursor,
  `PortfolioState`, pending orders (they legitimately span the overnight boundary), and the
  accumulated record tails. In-memory value object; durable checkpoint STORAGE is deferred
  (persistence of the completed run is M7's `save_run`, which gains a `mode` parameter).
- The MarketDataSet is full-history local fixture data in v0; availability gating (`as_of`)
  already guarantees each step sees only what is knowable — same adapter, both modes.

### Run mode in persistence (additive)
`record_from_result(..., mode=RUN_MODE_BACKTEST)` gains the parameter; `RUN_MODE_FORWARD =
"forward"` joins `records.py`; `RunRepository.save_run(document, result, mode=...)` passes it
through. The `runs.mode` column (added in M7 exactly for this) now carries real values. No DB
migration needed.

### Test-only stateful accumulator (test suite ONLY — never the product registry)
Per STRATEGY_LANGUAGE §5: a counter/accumulator node defined in `tests/stateful_fixture.py`,
declaring `purity="stateful"`, cadence `evaluation_only`, with serializable state held in a
test-owned trajectory store (the v0 engine has no stateful-node state plumbing — building it
is NOT M8 scope; the node exercises TIMING equivalence: at each evaluation it appends
`(evaluation_instant, count, sum of visible closes)` to its store). Assert the historical and
forward trajectories are identical element-for-element. The `every_session` cadence cannot be
driven by the v0 engine (evaluations fire only on schedule) — documented explicit deferral.

## Consistency test battery (`tests/test_forward_replay.py`)
1. **Full-equality consistency (A and B):** backtest over the fixture vs `ForwardReplay`
   advanced to exhaustion — `result()` equals the backtest `BacktestResult` on EVERY field
   (targets, orders, fills, valuations, notes, stale marks, metrics, final state, diagnostics,
   trace incl. instants). Identical local data ⇒ the calibrated claim's strongest form.
2. **Persisted-facts comparison:** run backtest → `save_run` (M7) → REOPEN the database → load
   `PersistedRunRecord` + `load_trace` → forward replay independently → compare the forward
   run's facts against the LOADED record field-by-field and the forward trace against the
   LOADED events. The stored artifact is the oracle; nothing recomputed then relabeled.
3. **One-session-at-a-time discipline:** after each `advance()`, the driver's visible progress
   (valuations length, last session) grows by exactly one session; decisions made by session k
   never change when later sessions are subsequently fed (prefix stability: a forward replay
   stopped at k equals the backtest truncated at k — run_backtest(last_session=k)).
4. **Restart/replay:** snapshot at an arbitrary mid-replay point (including one with PENDING
   overnight orders), resume in a fresh driver, replay to the end → `result()` identical to
   the uninterrupted forward run AND the backtest. Also resume-at-eval-boundary case.
5. **Stateful trajectories:** the accumulator strategy run both modes → identical trajectories.
6. **Forward run persisted:** `save_run(..., mode="forward")` round-trips; `list_runs`
   partitions by mode; record equality with the backtest-mode record except `mode`/`run_id`.
7. **Environment differences documented:** a short section in this plan (below) — v0 has NONE
   by construction (same fixture, same gating); the documented list is the deferred live-data
   divergences (data source, history availability, wall-clock arrival) the M8 test would catch.

## Explicitly out of scope / deferrals
Live data adapter; real broker; network scheduling; product stateful nodes and engine state
plumbing (incl. `every_session` cadence); durable checkpoint persistence; M9 API. Environment
differences in v0: none (identical local data + gating); with a future live adapter the
explicit divergence axes are data source, available history depth, and arrival timing.

## Slices
- **M8.1** Plan + adversarial review.
- **M8.2** Engine core extraction (`SessionEngine.step/finish`), `run_backtest` re-expressed over
  it; full suite must pass UNTOUCHED (the extraction-correctness gate).
- **M8.3** Clock seam + `ForwardReplay` (advance/result/snapshot/resume).
- **M8.4** Persistence `mode` parameter.
- **M8.5** Consistency battery + stateful fixture + restart tests.
- **M8.6** Self-review, gate, learning log, report. STOP before commit.

## Test blueprint
As the battery above, plus: extraction gate = zero changes to existing tests/goldens; forward
window edges (empty window → immediate exhaustion; single-session window); `advance()` after
exhaustion returns None idempotently; snapshot immutability (advancing the original does not
disturb a taken checkpoint); trace equality includes engine events and instants; accumulator
trajectory non-trivially long (>3 evaluations) and sensitive to visibility (uses only
`as_of`-gated data).

## Adversarial plan-review amendments (two reviewers; all findings adopted)
1. **Bounded replay is the v0 contract (both reviewers' blocker).** The engine's window-tail
   branch (`fill_outside_window` when the next fill session exceeds `last_session`) requires a
   KNOWN end: an open-ended forward driver would instead queue a pending order that dangles —
   a genuinely different tail semantics. `ForwardReplay` therefore REQUIRES `last_session`;
   full equality (battery 1) is claimed for a forward window equal to the backtest window,
   advanced to exhaustion, with the SAME `run_id` (trace events embed it; `ForwardReplay`
   applies the same UUID normalization). Open-ended replay is a documented deferral.
2. **Prefix stability split into two honest oracles:** (3a) bounded equivalence — a FRESH
   `ForwardReplay(last_session=k)` exhausted equals `run_backtest(last_session=k)` exactly,
   including eval-boundary k (both apply the same tail note); (3b) no-retro-mutation — a
   long replay's per-advance observations are prefixes of its own final result (later sessions
   never rewrite earlier decisions). End-of-window logic is NEVER duplicated into `result()`.
3. **Abort contract:** the extracted `step` surfaces the loop's five terminal exits; a failed
   step ends the run (`ok=False` partial result), `advance()` thereafter returns `None`
   idempotently, and `SessionAdvance` carries the failure signal.
4. Checkpoints include `run_id` (+cursor, state, pending, accumulator tails — tails are
   REQUIRED: `finish()` computes metrics over the full valuation series); derived config is
   rebuilt from inputs, not stored.
5. **Direct lookahead witness:** the accumulator trajectory records the view's last visible
   session at each firing — asserting the evaluation at k never saw k+1 (shared-gating carries
   M3/M4 coverage; prefix stability alone cannot catch a bug shared by both modes).
6. The stateful-fixture catalog and its trajectory store are built FRESH per mode/run (a shared
   closure would concatenate trajectories and silently pass a doubled list); the test proves
   TIMING equivalence only — engine state plumbing/checkpointable node state stays deferred.
7. Battery 2 normalization: same `run_id`, forward candidate reshaped via `record_from_result`
   (a pure, M7-field-tested copy — injects no backtest data; the stored record stays the sole
   oracle); acknowledged as a strict SUBSET of battery 1's coverage (no calendar/trace in the
   record) — complementary because it crosses the serialization boundary.
8. The forward clock's eligibility reuses `run_window` — never a re-derived filter.
9. Blueprint additions: `result()` then further `advance()`; resume-from-final-checkpoint
   no-op; snapshot taken → original advanced ≥2 → same checkpoint resumed twice identically;
   `list_runs` partitioning with both modes present. Fixture scoping: module-scoped immutable
   market/catalog/backtest results; per-test forward drivers, databases, and stateful catalogs.

## Stop conditions
Standing ones. The engine-core extraction must not change ANY observable M4–M7 behavior — if
byte-identical extraction proves impossible, stop. None anticipated.
