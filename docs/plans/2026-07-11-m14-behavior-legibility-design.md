# M14 — Behavior Legibility: the Node Value Tap (Design)

> Design record for the M14 sprint. The companion implementation plan is
> `2026-07-11-m14-implementation-plan.md`; the directional successor roadmap is
> `2026-07-11-post-m14-roadmap-m15-m16.md`. This document decides *what M14 is and why*; the
> plan decides *how it is built and verified*. Documentation only — no code was changed
> alongside this document.
>
> **Founder decisions (2026-07-11), embedded throughout:**
> **D-1** The tap mechanism is **recompute-on-demand** (approach B in §6), not capture-at-run.
> **D-2** The four **flip-triggers** in §7 are the pre-made decision record for when
> capture-at-run becomes admissible; until one fires, capture is scope creep.
> **D-3** **Sequencing:** §13 external validation starts *first*; M14.1–M14.2 are built in
> parallel with it. A §13 finding that contradicts M14's premise halts remaining slices.
> **D-4** **M14.3 (edge-hover canvas dataflow) is gated on §13 feedback** and is *not* default
> M14 scope.
>
> **Pre-implementation audit (2026-07-11), incorporated throughout:** dataset resolution is
> **by content fingerprint** — a run does not store a dataset id (§6); legacy
> unknown-provenance runs get their own refusal (§6); `series_preview` is **per-asset** and
> `value_summary` is a **discriminated union** (§5); the trace cross-check is an
> **envelope-level comparison**, not per-event-type semantics (§6); `session_date` resolves to
> the **persisted evaluation instant**, never a reconstructed one (§6); `ok:false` runs are
> tappable with defined semantics (§6); two stop conditions added (§10).

## 1. Post-M13 diagnosis

M1–M13 are complete and merged (`main` = PR #22). M13 delivered structure legibility (canvas-
first shell, Data Source card, stage strip, category-aware node cards, Inspector
role/math/parameters/ports) and decision legibility (served trace tree, Results ↔ Trace ↔
Canvas ↔ Inspector loop, session cursor, component breadcrumbs, read-only component
internals). The 30-second legibility instrument passes 5/5 on the demo.

What a user still cannot do — verified against the merged codebase — is the core IDE-debugger
act: *point at a node and see the value it produced*.

- Trace payloads carry **decisions, not values**. `transform.computed` emits only the *list*
  of computed assets (`quantize/nodes/transform.py:103`); the trailing return's actual numbers
  are never persisted. Value coverage in traces is incidental and uneven (the data node happens
  to trace per-asset observations; transforms do not).
- The Inspector's **"At session" section is a designed slot, not a capability**. Since M13.7 it
  renders the selected node's served *trace events* at the cursor, addressed by
  `(node_id, component_path)` — deliberately the exact request shape of the reserved Node Value
  Tap endpoint (M13 design §4 W4). Values were explicitly excluded from M13 scope.
- The read-only component-internals Inspector (M13.9 O3) ships **without** an "At session"
  section at all — wiring it requires the `component_path` value addressing that M13.9 named
  "a feature, not a closeout fix."

Meanwhile the runtime already computes everything the tap needs:
`evaluate_strategy(...)` (`quantize/evaluator/evaluate.py:287`) returns an
`EvaluationOutcome` whose `outputs` mapping is keyed by
`((*component_path, node_id), output_port) → RuntimeValue` — every node's every output port,
at every evaluation instant, including component internals (the compositional evaluator fills
the same store through exposed-output mapping). The values exist at run time; they are simply
never persisted or served. M14 closes exactly that gap.

## 2. Problem statement

**M13 made structure and decisions legible; M14 must make behavior/dataflow legible.**

The vision sentence at the center of the product thesis — *data enters, features/signals are
computed, models/conditions/rankings are applied, assets are selected, weights/risk are
produced, the engine creates simulated orders/fills, and the user can understand why* — is
served by M13 everywhere except one step: watching the data itself flow through the graph.
A debugger without variable inspection undercuts the whole IDE claim, and §13 validation
testers will ask "what value did this node produce?" within their first minutes.

## 3. Product goal

**Select a session, click a node, see the value it produced.**

Concretely: with a run selected and the session cursor set, selecting any node (including a
node *inside* a component, at any nesting depth) shows, in the Inspector's existing
"At session" slot, the value each of its output ports produced at that evaluation instant —
a server-computed summary plus the per-asset values or a bounded series preview, with honest
provenance. Zero relayout: the slot was designed for this in M13.5/M13.7.

## 4. Non-goals

Explicitly out of M14 scope (deferral targets in parentheses where one exists):

- **Live trading, broker execution, or any real-money automation** (adapter seam, far future;
  UI continues to frame Live as deferred).
- **User-specific financial advice** of any kind — the tap reports what the machine computed,
  never what the user should do.
- **A new model zoo / new node types** — no statistics/modeling/optimization/ML vocabulary in
  M14 (M15/M16 candidates, driven by a concrete strategy; see the post-M14 roadmap doc).
- **Component editing / forking / version-upgrade** (invariant 8; a future authoring
  milestone).
- **Value-over-time series** (a node's output *across* sessions — sparkline/timeline UI). This
  is the most likely first consumer of capture-at-run and is its own future decision (§7).
- **Capture-at-run persistence** — no run option, no migration, no value tables (§6/§7).
- **Frontend numerical derivation** — the web client renders served digests only
  (invariant 5); it never computes a summary, sum, rank, or statistic.
- **M15/M16 statistical vocabulary** — named here only so nobody smuggles it in as "just one
  more node for the demo."
- **Counterfactual evaluation** — the tap serves only instants at which the run actually
  evaluated; it never evaluates sessions the schedule skipped.
- **Edge-hover canvas dataflow (M14.3)** — designed as a gated follow-on (D-4), not built by
  default.

## 5. The Node Value Tap contract (frozen in M13; unchanged here)

M13 fixed this shape so that nothing built since would move (M13 plan "Contracts &
invariants"); M14 implements it verbatim:

```text
GET /v1/runs/{run_id}/values
      ?node_id= &component_path= &session_date= &output_port=
→  {
     node_id, component_path, session_date, output_port,
     value_summary,        # server-computed: port_type + type-appropriate digest
                           # (count/min/max for cross-sections, weight sum for targets, …)
     asset_values?,        # [{asset, value}] for CrossSection/PortfolioTargets/AssetSet
     series_preview?,      # [(date, value)] window for TimeSeries ports
     provenance            # {run_id, dataset_fingerprint, captured: bool}
   }
```

M13's obligations to this contract are already met and are consumed as-is: the Inspector
"At session" section is the rendering slot; trace/canvas addressing speaks
`(node_id, component_path)`; the session cursor supplies `session_date`; node cards' output
handles are the `output_port` affordance.

Serving rules M14 adds *within* this shape (they refine, never change, the contract):

- `component_path` is the enclosing component-instance ids, outermost first (envelope
  convention, `quantize/tracing/events.py`); empty/omitted at top level, **comma-separated**
  in the query string. Comma encoding is provably unambiguous: `NodeId`/`RefId` are
  schema-constrained to `^[A-Za-z0-9_]+$` (`quantize/schema/primitives.py`), so a comma can
  never appear in a segment; the parser re-validates each segment against that pattern
  (422 otherwise) as defense in depth. The value lookup key is
  `((*component_path, node_id), output_port)` — exactly the evaluator's `ValueStore` key
  (`quantize/evaluator/evaluate.py`).
- A `ComponentRef` node's **own exposed output ports are tappable** as
  `((instance_id,), exposed_port)` — the evaluator already stores exposed outputs under the
  instance path, so clicking the component card itself works with no special case.
- `output_port` may be omitted **only** when the node has exactly one output port (it
  defaults to that port); ambiguous omission is a structured 422.
- **`value_summary` is a discriminated union**, keyed by value kind (`scalar` | `asset_set` |
  `cross_section` | `time_series` | `portfolio_targets`, mirroring
  `quantize/runtime/values.py`) and refined by `dtype` — a Boolean cross-section (Strategy
  B's trend filter) digests as true/false counts, never min/max; digests stay within the
  contract's own examples (count/min/max, weight sum — no mean/std/other statistics, which is
  where M15 vocabulary would leak in). Two summary-shape refinements are decided here:
  `asset_set` carries its members inside the summary (an AssetSet has no per-asset value to
  put in `asset_values`), and `portfolio_targets` carries the explicit **cash remainder**
  (`1 − Σ weights`) computed server-side — cash is load-bearing for Strategy B and the client
  must never compute it. Exact field lists are fixed in the plan's Contracts section.
- **`series_preview` is per-asset**: `TimeSeriesValue` is per-asset date-indexed history
  (`quantize/runtime/values.py`), so a flat `[(date, value)]` cannot represent a multi-asset
  series port. The preview is `[{asset, points: [[date, value], …]}]` with a
  **server-enforced cap of the most-recent points per asset** (constant fixed in the plan);
  assets with empty histories appear with empty `points` — the domain stays honest. An
  unbounded series never crosses the API (invariant 6).
- `asset_values` and all asset lists are served in the value's **canonical ascending-asset
  order** (enforced by the value constructors); the served order is authoritative — ordering
  is server-decided, per the trace-tree precedent ("no ordering is re-decided here").
- `provenance.captured` is `false` for every M14 response — the honest label that the value
  was recomputed now, not read from a run-time artifact. The flag exists in the contract
  precisely so capture-at-run can later flip it without any shape change.
- All summarization is server-side. The frontend renders `value_summary` /
  `asset_values` / `series_preview` fields verbatim.

## 6. Mechanism: recompute-on-demand (founder decision D-1)

### Approaches considered

- **A. Capture-at-run.** A run option persists every node's output `RuntimeValue` per
  evaluation instant; the endpoint is read + summarize. Exact provenance (`captured: true`),
  but: a persistence migration; a storage-policy problem (a TimeSeries port's value *at an
  instant* is the entire visible history — naïve capture is O(nodes × instants × history) and
  forces truncation policy now); capture overhead on every run; flag plumbing; and it serves
  no run that already exists.
- **B. Recompute-on-demand (chosen).** v0 ships no stateful nodes; every graph node is pure
  over an availability-gated `DataView`, and the run record preserves the pinned
  `strategy_version`, the exact per-evaluation `evaluation_instant`s, and dataset + calendar
  content fingerprints (`quantize/persistence/records.py`). The endpoint therefore resolves
  the dataset **by fingerprint** (see below — a run does *not* store a dataset id), rebuilds
  the run's `MarketDataSet`, calls the **existing** `evaluate_strategy` at the persisted
  instant, and projects one entry out of the returned `outputs` store. Zero persistence change; works
  retroactively on every existing run; and **component nesting comes free** — the
  compositional evaluator produces inner-node values naturally, which also unlocks the
  "At session" section for the read-only component-internals Inspector.
- **C. Enrich trace payloads with values.** Rejected: bloats every run whether or not anyone
  inspects; mixes two separated concerns (tracing = decisions, values = data); cannot
  represent TimeSeries ports; helps no existing run.

### Dataset resolution by fingerprint (audit correction, 2026-07-11)

A persisted run stores **input provenance** — dataset and calendar **content hashes**
(`RunInputProvenance`, `quantize/persistence/provenance.py`) — not a dataset row id; neither
`PersistedRunRecord` nor the `runs` table references a dataset row. The tap therefore
resolves its recompute input by matching the run's recorded fingerprints against the
`datasets` table (which stores `dataset_fingerprint` / `calendar_fingerprint` as columns —
an indexed lookup, not a hash-all-payloads scan):

- **Exactly one match:** load it — this is verifiably the run's input.
- **Zero matches:** structured refusal ("the run's input dataset is no longer stored —
  deterministic recomputation cannot be guaranteed"). Never a best-effort substitute.
- **Multiple matches:** any row is acceptable — identical fingerprints mean identical
  content, and content identity is exactly what replay requires.

This is *more* replay-stable than a stored dataset id would be: an id can dangle after a
deletion while an identical-content dataset still exists; a fingerprint match cannot lie.
`provenance.py`'s own contract is the foundation: "re-supplying data with the same
fingerprints reproduces the run (deterministic engine)."

**Session mapping:** the request's `session_date` resolves to the run's persisted
`PersistedEvaluation.evaluation_instant` for that date (at most one evaluation exists per
session), and **that persisted instant** — never a calendar-reconstructed `close_at` — is
what is passed to `evaluate_strategy`. This reproduces the engine's own call verbatim
(`quantize/engine/backtest.py` passes `session.close_at`, which is the recorded fact).

### Why B is safe here (and where it honestly is not)

The recompute path reuses the one evaluator (invariant 2 — a "lightweight value recomputer"
would be a second implementation and is a stop condition). Determinism is an already-tested
core property: same document version + same as-of view ⇒ same outputs.

B's real weakness: if a **node implementation changes** between run time and tap time, the
recomputed value can differ from what the run acted on — and a debugger showing numbers the
bot never saw is worse than no debugger. Mitigations, all inside existing invariants:

1. **`provenance.captured: false`** labels every response as recomputed (contract seam).
2. **Fingerprint gate:** the tap refuses, with a structured error, when no stored dataset
   matches the run's recorded fingerprints, and refuses **legacy unknown-provenance runs**
   (format-1 migrations carry an explicit `status: "unknown"` — hashes were never recorded
   and are never fabricated): "replay cannot be verified — re-run to enable the value tap."
   Existing stable codes are reused (`UNKNOWN_PROVENANCE`, `DATASET_MISMATCH`,
   `CALENDAR_MISMATCH` from `input_provenance_mismatches()`), aligned with the
   `replay_verifiable` flag `GET /v1/runs/{id}` already serves. Fail loud (invariant 9); no
   silent best-effort serve.
3. **Trace cross-check (envelope-level, not semantic):** the recompute runs with
   `collect_trace=True`; the service compares the **fresh trace events for the tapped node**
   against the **persisted events** at the same `(evaluation_instant, component_path,
   node_id)` — an ordered comparison of `(event_type, payload)` after canonical JSON
   normalization. This is generic over every node type (no per-event-type knowledge — a
   semantic comparison would be a creeping parallel interpretation layer) and deterministic
   by the evaluator's own contract (events are appended in evaluation order and stamped with
   the evaluation instant, never wall-clock). Guards: tapped node only (`engine.*` events are
   excluded automatically by node-identity filtering); **skipped silently when the run has no
   persisted events for that node** — a trace-less run must not make the tap unusable.
   Mismatch → structured "engine drift — re-run to refresh" refusal. It is a tripwire, not a
   proof.
4. The repo's golden-snapshot discipline already makes any numeric engine change a reviewed
   diff, so drift is rare *and* visible when it happens.

### Failure modes (all structured, never an empty 200 — the M13 honest-empty-state pattern)

| Condition | Behavior |
|---|---|
| Unknown run | 404, structured (repository `artifact_not_found`, as the trace endpoints behave) |
| `session_date` has no recorded evaluation | 404 `no_evaluation_at_session`, citing the run's recorded no-eval/warm-up note verbatim when one exists (as TraceView/Inspector already do) |
| Unknown `node_id` / `component_path` / `output_port` in the run's pinned strategy version | 404 `value_address_not_found` with the offending subject named |
| `output_port` omitted on a multi-output node | 422 "ambiguous port" naming the candidates |
| Malformed params (bad date, segment failing the identifier pattern) | 422 (query parsing) |
| **Unknown provenance** (legacy format-1 run) | 409 `unknown_provenance` — "replay cannot be verified — re-run to enable the value tap" |
| No stored dataset matches the run's fingerprints | 409 `dataset_mismatch`/`calendar_mismatch` — "deterministic recomputation cannot be guaranteed" |
| Recompute evaluation not `ok` | 409 surfacing the runtime diagnostics |
| Trace cross-check mismatch | 409 "engine drift" refusal (mitigation 3) |
| **Run persisted with `ok: false`** | Tappable, with defined semantics: execution faults stop at the first failing node and the outcome carries whatever outputs completed — completed addresses serve normally; a missing address on a not-ok evaluation surfaces the recompute diagnostics rather than a bare 404 |
| Asset excluded by the node's missing-data rule | Not an error: absent from `asset_values`, present in the domain — mirroring the node's documented exclusion semantics |

Address-existence rule (so "unknown address" and "didn't produce" stay distinguishable):
**node existence** is validated against the run's pinned strategy document (and component
definitions for nested paths) for a crisp 404; **port enumeration** comes from the recomputed
store's keys at that path — never from a re-implemented descriptor lookup.

### Performance posture

At MVP scale (a handful of ETFs, daily bars, ~10-node graphs) a single-instant subgraph
evaluation is far below perceptibility. No memo is used (`EvaluationMemo` is a run-scoped,
monotonic, speed-only channel; the tap evaluates one instant). The service logs elapsed time
per tap so the ~1s flip-trigger (§7) is *observable*, not anecdotal. No caching layer is
built until a measurement demands it.

## 7. Flip-triggers to capture-at-run (founder decision D-2)

This section is the pre-made decision record so the A-vs-B choice is never re-litigated
ad hoc. Capture-at-run becomes admissible — as its own designed, founder-approved milestone
with a persistence migration and a storage policy — when **any** of these fires:

1. **Stateful nodes land.** Recompute then requires checkpointed state; purity no longer
   carries the tap.
2. **Value-over-time UI becomes required.** A per-node series across a run wants a column
   scan, not N re-evaluations.
3. **Observed tap latency exceeds ~1s on real datasets** (as measured by the §6 logging, not
   estimated).
4. **Datasets become mutable, or deterministic recomputation cannot otherwise be
   guaranteed** (e.g. a data source without stable fingerprints).

Until one fires, any capture/persistence work appearing in an M14 branch is a stop condition.

## 8. Sequencing (founder decision D-3)

- **§13 external validation starts first.** The instrument (the verbatim 30-second script and
  journey checklist) exists from M13.9; running it with 3–5 quant-literate testers is
  founder-led human work and does not contend with build work.
- **M14.1–M14.2 are built in parallel.** They are low-regret regardless of validation
  outcome: the contract was pre-committed in M13, the tap is thesis-core, and the §13 demo
  itself is stronger with values inspectable.
- **Everything beyond M14.2 is gated on what testers actually say** — the edge-hover canvas
  dataflow (M14.3, D-4), value-over-time, and the M15/M16 direction (vocabulary vs. data
  reality vs. authoring depth). Standing stop condition: a §13 finding that contradicts
  M14's premise (e.g. "legibility is fine; my blocker is getting my data in") halts the
  remaining M14 slices for a founder decision.

## 9. M14.3 — edge-hover canvas dataflow (designed, gated, not built)

For the record so a later slice needs no re-design: hovering an edge while a run is selected
and the cursor is set shows the value summary flowing across that edge at that instant — the
one-glance "watch data flow" moment. It is pure presentation over the *same* endpoint (the
edge's source `(node_id, component_path, output_port)` is the request address; nothing new is
computed anywhere). Include only if §13 feedback says the Inspector surface is not enough.

## 10. Stop conditions

Halt the slice and bring the question to the founder when:

1. Any number would be computed or derived client-side (invariant 5) — including
   **comparison-derived presentation** (max-weight highlighting, client-side sort-by-value):
   ordering and emphasis are server-decided, per the trace-tree precedent.
2. The recompute path wants any evaluation code that is not the existing planner/evaluator —
   a second implementation, however "lightweight" (invariant 2). Ancestor-subgraph pruning
   counts: a modified execution plan is a second path in spirit; full-document
   `evaluate_strategy` is the only recompute.
3. Anyone asks the tap to serve **engine-boundary** values (orders, fills, cash, positions):
   those are engine facts, already served as traces/reconciliation rows; the graph terminates
   at `PortfolioTargets` (invariant 2). (The `portfolio_targets` summary's cash *remainder*
   is a graph fact — `1 − Σ weights` of the terminal value — not an engine fact.)
4. A persistence migration or value table creeps into M14 "for convenience" — that is the
   capture decision, and it is trigger-gated (§7).
5. **Any persisted or cross-request memoized recompute result** — a results cache is
   capture-at-run's sneaky entry point ("the port selector makes two requests, let's
   memoize"). A per-request recompute *is* the M14 semantics.
6. Any change to the frozen contract shape (§5), or any serve of a session the strategy did
   not evaluate.
7. `series_preview` without the server-enforced per-asset window cap.
8. A §13 finding contradicts M14's premise (§8).

## 11. Testing commitments (financial correctness is non-negotiable)

The plan operationalizes these; the design commits to them:

- **Golden value tests:** for both reference strategies at known fixture sessions, the tapped
  value equals the value the run produced (asserted against the **existing** committed
  goldens wherever they already record the number, and against the run's persisted trace
  facts where they overlap).
- **Byte determinism:** two identical taps return identical response bodies — cheap, and it
  guards the whole recompute premise.
- **Dataset resolution:** fingerprint resolves exactly one dataset; resolves none → refusal;
  duplicate-content datasets → served from any matching row.
- **ComponentRef exposed-port tap:** tapping the component instance's exposed output equals
  the inner mapped node's value.
- **Look-ahead safety on the tap path itself:** the rebuilt view at instant *t* must expose
  only data with availability ≤ *t*; a tap can never see more than the run saw.
- **Nested component tap:** an inner node addressed by `component_path` returns the same
  value the compositional evaluation produced; the trail the M13.8 breadcrumb carries is a
  valid request address.
- **Missing-data semantics:** excluded assets absent from `asset_values`, present in domain;
  the exclusion reason remains discoverable via the existing trace rendering.
- **Every failure mode in §6 returns its structured error** — asserted per mode.
- **Contract tests:** the new DTO ships through the API-DTO codegen bundle; stale generated
  types fail CI as everywhere else.
