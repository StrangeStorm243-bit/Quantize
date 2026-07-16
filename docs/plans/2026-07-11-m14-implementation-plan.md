# M14 — Behavior Legibility / Node Value Tap — Implementation Plan (2026-07-11)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Design record: `2026-07-11-m14-behavior-legibility-design.md` (read it first —
> this plan does not restate the *why*). Founder decisions D-1…D-4 are embedded there and are
> binding here.
>
> **Goal:** select a session, click a node, see the value it produced — via the frozen
> `GET /v1/runs/{run_id}/values` contract, implemented as recompute-on-demand over the one
> existing evaluator, rendered in the Inspector's reserved "At session" slot.
>
> **Architecture (one paragraph):** the endpoint loads the run record (pinned
> `strategy_version`, per-evaluation instants, dataset + calendar **content fingerprints** —
> a run stores no dataset id), **resolves the dataset by fingerprint** against the
> content-addressed `datasets` table, refuses unless deterministic recomputation is
> guaranteed (unknown provenance included), rebuilds the availability-gated `MarketDataSet`,
> calls the existing `evaluate_strategy` at the **persisted** evaluation instant, and projects
> one entry from the returned `outputs` store — keyed
> `((*component_path, node_id), output_port)` — through a server-side summarizer into the
> frozen DTO. No persistence change, no second evaluator, no client-side numerics.
> `provenance.captured` is always `false` in M14.
>
> **Pre-implementation audit (2026-07-11) incorporated:** dataset-by-fingerprint resolution;
> unknown-provenance refusal; per-asset `series_preview`; discriminated `value_summary`
> shapes; envelope-level trace cross-check split into its own slice (M14.1a′); persisted-
> instant session mapping; exact HTTP status table; `ok:false`-run semantics;
> address-existence rule; determinism/ComponentRef tests. Design §5/§6 carry the rationale.
>
> **This plan was authored docs-only.** No code changes accompany it; implementation begins
> only when the founder starts M14 execution. Per D-3, §13 external validation starts first
> and runs in parallel.

## Purpose & definition of done

M14 is done when all of the following hold (each is verified in its slice; the closeout
re-verifies the set):

- [x] `GET /v1/runs/{run_id}/values` serves the frozen M13 W4 contract shape, recompute-on-
      demand, with `provenance.captured: false` and the run's recorded
      `dataset_fingerprint`.
      *(M14.1 — tests/api/test_values_endpoint.py::test_happy_path_targets_equal_persisted_weights
      + ::test_body_validates_against_committed_schema; `captured=False` is assigned at
      `quantize/valuetap/service.py:263`, with the run's recorded `dataset_fingerprint`.)*
- [x] The recompute dataset is **resolved by fingerprint** (runs store no dataset id): one
      match serves; zero matches and unknown-provenance runs refuse with structured errors;
      duplicate-content rows are all acceptable.
      *(M14.1a — tests/test_valuetap_service.py::test_dataset_resolves_by_fingerprint /
      ::test_absent_dataset_is_refused / ::test_unknown_provenance_run_is_refused /
      ::test_duplicate_content_dataset_rows_still_serve.)*
- [x] The tapped value at a fixture session equals the value the run produced there, for
      **both** reference strategies, asserted against the existing committed goldens.
      *(M14.9 Task 1.5a, commit 2b1fe06 —
      tests/test_valuetap_goldens.py::test_strategy_a_cap_targets_match_committed_golden /
      ::test_strategy_b_mask_targets_match_committed_golden vs the committed
      `strategy_{a,b}_backtest.json`; ::test_reference_signal_taps_match_minted_value_golden
      vs minted `tests/goldens/valuetap_reference_signals.json`.)*
- [x] A node **inside a component** (any depth) is tappable by `component_path`, and a
      `ComponentRef` node's exposed output ports are tappable as the instance's own ports.
      *(M14.9 Task 1.5b, commit 0b7697b —
      tests/test_valuetap_service.py::test_depth_two_inner_core_node_is_tappable_by_two_segment_path
      + ::test_nested_inner_node_and_exposed_output (also the endpoint's
      ::test_nested_inner_node_and_exposed_output); the single-segment `("mom",)` case covered by
      the sibling service tests.)*
- [x] Every failure mode in design §6 returns its structured error per the status table
      below; none returns an empty 200. The no-eval case cites the run's recorded note
      verbatim (M13 honest-empty-state pattern). `ok:false` runs serve completed outputs and
      surface diagnostics for missing ones.
      *(M14.1/M14.9 — tests/api/test_values_endpoint.py covers each mode
      (test_no_evaluation_session_is_404_with_recorded_note, the 404/409/422 rows, none empty-200);
      tests/test_valuetap_service.py::test_ok_false_recompute_serves_completed_upstream_nodes; live
      no-eval note (verbatim) + v1-run 404 in docs/reviews/2026-07-15-m14-closeout.md Steps 5a/5b.)*
- [x] `series_preview` is capped server-side at **64 most-recent observations per asset**
      (the plan's constant; changing it is a reviewed diff, not a tweak).
      *(M14.1 —
      tests/test_valuetap_summarize.py::test_time_series_preview_capped_to_most_recent_per_asset.)*
- [x] The Inspector's "At session" section renders `value_summary` + `asset_values` /
      `series_preview` for the selected node's output port(s) at the cursor, **with zero
      relayout of the slot**, alongside the trace facts it already shows.
      *(M14.2a — web/src/components/Inspector.values.test.tsx (served summary/asset rows/series,
      order preserved, per-port fetch) atop the pre-reserved M13.7 slot exercised in
      Inspector.atsession.test.tsx (same section across empty/loading/error/values, no branch
      relayout); live in docs/reviews/2026-07-15-m14-closeout.md Step 2, screenshot m149-02.)*
- [x] The read-only component-internals Inspector (M13.9 O3) gains an "At session" section
      for inner nodes, addressed by the breadcrumb trail's `component_path`.
      *(M14.2 — web/src/components/Inspector.componentNode.test.tsx +
      web/src/App.componentInspect.test.tsx (inner-node "At session" addressed by the breadcrumb's
      `component_path`); live in docs/reviews/2026-07-15-m14-closeout.md Steps 3–4, screenshots
      m149-03 (exposed port) / m149-04 (inner `ret`).)*
- [x] No numeric derivation exists in `web/` (review + test-asserted: the client renders
      served fields verbatim).
      *(M14.2 PX-C — re-reviewed 2026-07-16: `web/src/format.ts` `fmtValue` is per-number display
      only (`toFixed(4)` + STRING trim gated on absence of `e` so exponent digits survive per
      05ae5b6; verbatim value kept in a `title`) — no arithmetic, no cross-value op; Inspector.tsx
      value path (lines 149–294) routes every served number through `fmtValue`, preserves server
      order (no client sort), and derives no order/emphasis — the only comparisons are
      `.length`/`!= null` render guards. Asserted by web/src/format.test.ts and
      Inspector.values.test.tsx's no-client-sort test.)*
- [x] The new response DTO ships through the API-DTO codegen bundle; `python -m
      quantize.codegen check` is clean; both `.d.ts` artifacts regenerate byte-stable.
      *(M14.1 — `NodeValueResponse` in quantize/api/dto/values.py generates into committed
      schema/quantize-api.schema.json + ts/quantize-api.d.ts; `python -m quantize.codegen check`
      is a green stage in the Task 1.6 gate (both `.d.ts` byte-stable); endpoint byte determinism
      separately pinned by test_values_endpoint.py::test_identical_gets_are_byte_identical.)*
- [x] `./scripts/gate.ps1` passes end-to-end.
      *(M14.9 Task 1.6 published gate — all stages green: pytest 1054, web 633 tests / 64 files;
      post-review fix pass 2026-07-16 reconciled the final published gate to pytest 1060, web
      633/64 — see the closeout report addendum.)*
- [x] Tap latency is logged server-side per request (flip-trigger 3 must be observable).
      *(M14.9 Task 1.5c, commits 65a0ae0/61169bf — quantize/valuetap/service.py `_log_attempt`
      emits exactly one `value tap … elapsed_ms=` INFO record per resolution ATTEMPT (serve and
      refusal alike); caplog tests test_valuetap_service.py::test_successful_tap_logs_one_elapsed_ms_line
      / ::test_refused_tap_logs_one_line_carrying_its_code /
      ::test_unknown_run_tap_logs_one_line_before_persistence_error_escapes; observed live (23-line
      console capture, PASS) in docs/reviews/2026-07-15-m14-closeout.md Latency section. Boundary:
      route-layer 422s never reach the service and are outside this instrument. Hardened by the
      2026-07-16 review fix pass: untyped exceptions now log `outcome=unexpected_failure`
      (::test_unexpected_failure_logs_one_line_before_escaping), and `create_app` enables the
      instrument under the documented plain-uvicorn launch (tests/api/test_app_logging.py;
      launch-path lines quoted in the closeout addendum).)*

**Explicitly NOT done in M14 (no claim of completion):** capture-at-run persistence,
value-over-time series, edge-hover canvas dataflow (M14.3 — gated on §13 per D-4), new node
types, component editing/forking, anything live/broker/real-money. See design §4.

## Authoritative inputs

- `docs/plans/2026-07-11-m14-behavior-legibility-design.md` — §5 contract + serving rules,
  §6 mechanism + failure-mode table, §7 flip-triggers, §10 stop conditions, §11 testing
  commitments.
- The frozen contract's origin: `docs/plans/2026-07-06-m13-ide-reorientation-design.md` §4 W4
  and `docs/plans/2026-07-06-m13-implementation-plan.md` "Contracts & invariants".
- `CLAUDE.md` invariants 1–11 (especially 2, 5, 6, 9); `docs/ARCHITECTURE.md` §3 (lifecycle,
  temporal safety), §4 (persistence), §5 (trace pipeline).
- Code seams (verified 2026-07-11): `quantize/evaluator/evaluate.py:287`
  (`evaluate_strategy` → `EvaluationOutcome.outputs`), `quantize/runtime/values.py`
  (`ScalarValue`, `AssetSetValue`, `CrossSectionValue`, `TimeSeriesValue`,
  `PortfolioTargetsValue`), `quantize/persistence/records.py` (run record:
  `strategy_version`, `evaluations`, input provenance), `quantize/persistence/provenance.py`
  (fingerprints), `quantize/api/routes/runs.py` + `quantize/api/dto/` (route/DTO precedent —
  the M13.6 trace-tree endpoint is the pattern to copy),
  `web/src/components/Inspector.tsx` (`AtSessionSection`),
  `web/src/components/Breadcrumb.tsx` (the trail carrying `component_path`).

## Scope

- **Backend:** one new package (`quantize/valuetap/`) for recompute orchestration +
  server-side summarization; one new route on the runs router; one new DTO module through
  codegen. Zero engine, evaluator, IR, or persistence-format changes.
- **Web:** Inspector "At session" value rendering (top-level and component-internal), output-
  port selection affordance on multi-output nodes. Zero numeric logic.
- **Docs:** LEARNING_LOG entry, README inspection-path touch-up if needed, closeout report.

## Exclusions (with deferral targets)

- Capture-at-run (run option, value tables, migration) — trigger-gated per design §7; its
  first likely consumer is value-over-time UI.
- Value-over-time series (per-node values across sessions) — future decision, likely the
  trigger that funds capture.
- M14.3 edge-hover dataflow — designed in design §9; built only on §13 signal (D-4).
- Batch/multi-node value requests, caching layers, memo reuse across taps — none until a
  measured need (the latency log is the instrument).
- Any engine-boundary "values" (orders/fills/cash) — engine facts stay traces/reconciliation.

## Contracts & invariants (binding for every slice)

- **Endpoint:** `GET /v1/runs/{run_id}/values?node_id=&component_path=&session_date=&output_port=`
  → `{node_id, component_path, session_date, output_port, value_summary, asset_values?,
  series_preview?, provenance{run_id, dataset_fingerprint, captured}}`. Shape changes are a
  stop condition.
- **Serving rules (design §5):** `component_path` = enclosing instance ids outermost-first,
  comma-separated in the query string, omitted/empty at top level — safe because
  `NodeId`/`RefId` match `^[A-Za-z0-9_]+$` (`quantize/schema/primitives.py`); each segment is
  re-validated against that pattern (422 otherwise). Lookup key is
  `((*component_path, node_id), output_port)` — the evaluator's `ValueStore` key verbatim.
  `output_port` optional only for single-output nodes. A `ComponentRef`'s exposed outputs are
  tappable as `((instance_id,), exposed_port)`. `captured` = `false` always (M14).
- **Dataset resolution (design §6):** runs store content fingerprints, not a dataset id.
  Resolve by matching `input_provenance.dataset_hash`/`calendar_hash` against the `datasets`
  table's fingerprint columns. One match → load; zero → 409 refusal; several → any row
  (identical content). `status: "unknown"` provenance → 409 `unknown_provenance` ("replay
  cannot be verified — re-run to enable the value tap"), reusing the stable codes from
  `quantize/persistence/provenance.py` and aligning with the run read's `replay_verifiable`.
- **Session mapping:** `session_date` → the run's `PersistedEvaluation.evaluation_instant`
  for that date; pass **that persisted instant** to `evaluate_strategy` — never a
  calendar-reconstructed `close_at`.
- **`value_summary` is a Pydantic discriminated union on `kind`** (five members mirroring
  `quantize/runtime/values.py`); `asset_values` values are typed `number | boolean`:
  - `scalar`: `{kind, dtype: "Number"|"Integer"|"Boolean", value}` — no `asset_values`.
  - `asset_set`: `{kind, count, members}` — members live in the summary (an AssetSet has no
    per-asset value); no `asset_values`.
  - `cross_section`: `{kind, dtype, domain_count, present_count, missing}` plus
    `{min, max}` for Number and `{true_count, false_count}` for Boolean (Strategy B's trend
    filter is Boolean — min/max would be nonsense); per-asset entries in `asset_values`.
  - `time_series`: `{kind, asset_count, total_points, window: {first_date, last_date}}`;
    data in `series_preview` = `[{asset, points: [[date, value], …]}]`, capped at the
    **64 most-recent points per asset**; empty-history assets appear with empty `points`.
  - `portfolio_targets`: `{kind, count, weight_sum, cash}` — `cash` is the explicit
    `1 − Σ weights` remainder, **computed server-side** (load-bearing for Strategy B; the
    client never computes it); weights in `asset_values`.

  Digests stop at the contract's own examples — no mean/std/other statistics (that is where
  M15 vocabulary would leak in). All ordering is the value classes' canonical ascending-asset
  order; the served order is authoritative.
- **HTTP status table (design §6):** unknown run → 404 `artifact_not_found` (repository, as
  the trace endpoints behave); unknown node/path/port → 404 `value_address_not_found` naming
  the subject; ambiguous omitted port / malformed params → 422; no evaluation at session →
  404 `no_evaluation_at_session` carrying the run's `notes[]` message verbatim; unknown
  provenance / fingerprint mismatch / missing dataset / recompute-not-ok / engine drift →
  409 with the stable codes. Only `code` + `message` cross the wire (`ApiError`).
- **Address-existence rule:** node existence is validated against the pinned strategy
  document (and component definitions for nested paths) → crisp 404; port enumeration comes
  from the recomputed store's keys at that path — never a re-implemented descriptor lookup.
  On an `ok:false` evaluation, completed addresses serve; missing ones surface diagnostics.
- **Honesty gates:** unknown provenance / fingerprint mismatch / missing dataset / non-ok
  evaluation / trace cross-check mismatch ⇒ structured refusal (design §6 table). Never a
  silent best-effort serve.
- **One evaluator:** the service calls `evaluate_strategy` (with `collect_trace=True`, memo
  `None`) over the **full document** — ancestor-subgraph pruning is a modified execution plan
  and therefore a second path (stop condition). Any new evaluation code path is a stop
  condition.
- **Trace cross-check (M14.1a′, design §6 mitigation 3):** compare the recompute's fresh
  trace events for the tapped node against the persisted events at the same
  `(evaluation_instant, component_path, node_id)` — ordered `(event_type, payload)`
  comparison after canonical JSON normalization. No per-event-type semantics. Skip silently
  when no persisted events exist for that node; mismatch → 409 engine drift.
- **Six concerns stay separate:** `quantize/valuetap/` is *presentation over evaluation*
  (orchestration + summarization). It contains no node math, no validation logic, no
  persistence schema.
- **Codegen:** the DTO is authored in Pydantic, exported to the API-DTO schema bundle, TS
  types regenerate; never hand-edit `.d.ts`.

## Unresolved decisions

None. D-1…D-4 (design header) resolve mechanism, triggers, sequencing, and the M14.3 gate.
If implementation surfaces a genuinely new decision, stop and bring it to the founder rather
than resolving it in-branch.

## Implementation slices

> Work on one branch per slice group (`feat/m14.1-value-tap-backend`,
> `feat/m14.2-value-tap-inspector`, `feat/m14.9-closeout`), TDD-first (RED → GREEN per test
> file), small commits, `./scripts/gate.ps1` before claiming a slice done. Node-dependent
> steps require `./scripts/node24.ps1` in the same shell first. Never claim a test passes
> without running it and reporting the real result.

### M14.1a — Recompute service (backend, no API surface yet)

**Files:**
- Create: `quantize/valuetap/__init__.py`, `quantize/valuetap/service.py`
- Test: `tests/test_valuetap_service.py`

**Behavior:** `resolve_node_value(run_id, node_id, component_path, session_date,
output_port, *, repo…) → ResolvedNodeValue | structured error` implementing, in order: run
lookup → session-date → **persisted `evaluation_instant`** mapping (surfacing the recorded
no-eval note verbatim when there is no evaluation) → provenance gate (unknown provenance →
typed refusal) → **dataset resolution by fingerprint** against the `datasets` table (zero
matches → typed refusal; several matches → any row) → strategy-version + component load →
`evaluate_strategy` at the persisted instant (`collect_trace=True`, memo `None`) → node
existence validated against the pinned document; port enumeration from the store keys →
address `outcome.outputs` by `((*component_path, node_id), output_port)` (defaulting a sole
output port) → return the `RuntimeValue` + fresh trace events (kept for M14.1a′) +
provenance + elapsed-time log line. Errors are typed results, not HTTP — the route maps them
in M14.1c.

**Steps (repeat RED→GREEN per numbered test):**
1. Write failing tests in `tests/test_valuetap_service.py` against the existing engine-test
   fixtures (reuse the Strategy A/B fixture helpers the golden tests use):
   (1) top-level node tapped at a known evaluation instant returns the exact
   `CrossSectionValue` the run produced (assert against the **existing** committed golden
   numbers);
   (2) inner component node by `component_path` (Momentum Rank demo shape); and a
   `ComponentRef` instance's exposed output port equals the inner mapped node's value;
   (3) sole-output-port defaulting; multi-output ambiguity → typed error;
   (4) non-evaluation session → typed error carrying the recorded note;
   (5) unknown run / node / path / port → typed errors naming the subject — including the
   "unknown node vs. didn't-produce" distinction on an `ok:false` run (completed address
   serves; missing address surfaces diagnostics, not not-found);
   (6) dataset resolution: fingerprint resolves exactly one dataset → serves; resolves no
   dataset → typed refusal; a duplicate-content dataset row (same fingerprints, different
   `dataset_id`) → serves from either row;
   (7) unknown-provenance (legacy) run → typed `unknown_provenance` refusal;
   (8) look-ahead: the rebuilt view at instant *t* exposes nothing with availability > *t*
   (assert via a fixture row available after *t* being invisible to the tap);
   (9) excluded asset absent from values, present in domain;
   (10) byte determinism: two identical resolutions produce equal results.
2. Run `pytest tests/test_valuetap_service.py -v` — expect FAIL (module missing).
3. Implement `service.py` minimally; re-run to GREEN, test by test.
4. `pytest` (full), `ruff check .`, `ruff format --check .`, `mypy` — all clean.
5. Commit per RED→GREEN pair (`feat(m14.1a): …`).

### M14.1a′ — Trace cross-check (backend; deliberately its own slice)

**Files:**
- Modify: `quantize/valuetap/service.py`
- Test: `tests/test_valuetap_crosscheck.py`

**Behavior:** envelope-level drift tripwire (design §6 mitigation 3): compare the
recompute's **fresh** trace events for the tapped node against the **persisted** events at
the same `(evaluation_instant, component_path, node_id)` — ordered `(event_type, payload)`
comparison after canonical JSON normalization. No per-event-type knowledge (a semantic
comparison would be a parallel interpretation layer — stop condition). `engine.*` events are
excluded automatically by node-identity filtering. **Skip silently when the run has no
persisted events for that node**; mismatch → typed "engine drift — re-run to refresh"
refusal.

**Steps:**
1. Failing tests: (1) matching events → value serves; (2) tampered persisted event →
   drift refusal — tamper via a **direct DB UPDATE on `trace_events` in the fixture**, never
   through an API path; (3) run with no persisted events for the node → check skipped, value
   serves; (4) `engine.*` events present at the instant do not participate.
2. RED → implement → GREEN; Python checks clean; commit (`feat(m14.1a'): …`).

### M14.1b — Summarization + DTO through codegen (backend)

**Files:**
- Create: `quantize/valuetap/summarize.py`, `quantize/api/dto/values.py`
- Modify: the codegen export registry (wherever `quantize/codegen` collects API DTOs —
  follow the M9 pattern used by `quantize/api/dto/runs.py`)
- Test: `tests/test_valuetap_summarize.py`; codegen check via existing machinery

**Behavior:** `summarize(RuntimeValue) → (value_summary, asset_values?, series_preview?)`
per the Contracts table's **discriminated-union shapes** (five `kind` members, dtype-aware
digests, `cash` computed server-side for `portfolio_targets`, per-asset `series_preview`);
`NodeValueResponse` Pydantic DTO mirroring the frozen shape. Plain JSON only — no
pandas/numpy across the boundary (invariant 6).

**Steps:**
1. Failing tests: one per `RuntimeValue` type (`ScalarValue`, `AssetSetValue`,
   `CrossSectionValue`, `TimeSeriesValue`, `PortfolioTargetsValue`), each asserting the
   digest fields, the presence/absence of `asset_values`/`series_preview`, and JSON-plainness
   of the result; **dtype-aware cases** — a Boolean cross-section digests as
   `{true_count, false_count}` (never min/max) and Integer/Boolean scalars round-trip their
   dtype; a `portfolio_targets` case asserting `cash == 1 − Σ weights` is served (never left
   to the client); a multi-asset TimeSeries case with > 64 observations per asset asserting
   the cap keeps the **most recent 64 per asset** and that an empty-history asset appears
   with empty `points`; canonical ascending-asset order asserted on every served list.
2. RED → implement → GREEN; Python checks clean.
3. Register the DTO with codegen. Run `./scripts/node24.ps1` then
   `python -m quantize.codegen generate`; commit the regenerated
   `schema/quantize-api.schema.json` + `ts/quantize-api.d.ts` together with the DTO. Verify
   `python -m quantize.codegen check` and `npm run typecheck` are clean.
4. **Open the regenerated `ts/quantize-api.d.ts` and confirm the `value_summary` union
   rendered as a usable discriminated type** (the repo has no tagged-union DTO precedent —
   only bare `Literal` fields — so verify the rendering deliberately, now, not in M14.2a).
5. Commit (`feat(m14.1b): …`).

### M14.1c — Endpoint + error contract (backend)

**Files:**
- Modify: `quantize/api/routes/runs.py` (the M13.6 `trace-tree` route is the shape to copy),
  `quantize/api/errors.py` only if a needed structured-error kind does not exist
- Test: `tests/api/test_values_endpoint.py`

**Behavior:** `GET /v1/runs/{run_id}/values` parses/validates query params
(`component_path` comma-split with each segment re-validated against the identifier pattern
`^[A-Za-z0-9_]+$` → 422 otherwise; `session_date` ISO date), calls M14.1a(+1a′), maps typed
errors to the Contracts section's **exact status table** (404 `artifact_not_found` /
`value_address_not_found` / `no_evaluation_at_session`; 422 ambiguous-port and malformed
params; 409 `unknown_provenance` / `dataset_mismatch` / `calendar_mismatch` /
recompute-not-ok / engine drift — `code` + `message` only, via `ApiError`), serializes via
the M14.1b DTO with `provenance{run_id, dataset_fingerprint, captured: false}`.

**Steps:**
1. Failing endpoint tests mirroring M14.1a's matrix through HTTP (happy paths for A and B,
   nested path, **every failure mode's exact status code + stable `code` string**, a
   malformed `component_path` segment → 422, byte-determinism of two identical GETs, and one
   test asserting the response validates against the committed API schema bundle — the
   repo's contract-test pattern).
2. RED → implement → GREEN; full `pytest`; commit (`feat(m14.1c): …`).
3. Run the full gate: `./scripts/gate.ps1` — report actual output. Slice group M14.1 done.

### M14.2a — Inspector "At session" values (web, top-level nodes)

**Files:**
- Modify: `web/src/components/Inspector.tsx` (`AtSessionSection`), the API client module
  (follow the trace-tree fetch pattern), `web/src/App.tsx` only if the fetch is lifted like
  the two existing lifted fetches
- Test: `web/src/components/Inspector.atsession.test.tsx` (extend)

**Behavior:** with run + cursor + selected node, the section fetches
`/v1/runs/{id}/values` for the node's output port(s) — **default: the node's first *listed*
output port from the Ports section the Inspector already renders** (a UI default, not
numeric logic), with a small selector when the node has several — and renders
`value_summary` and the `asset_values` table or `series_preview` list **verbatim, in served
order**, above/alongside the trace facts it already renders, inside the existing slot (zero
relayout — assert the section's structure is additive). Failure bodies render their served
reason (honest empty state); nothing is computed client-side and nothing is
comparison-derived client-side (no max-highlighting, no sort-by-value — ordering and
emphasis are server-decided).

**Steps:**
1. `./scripts/node24.ps1`. Failing tests: value render per response kind (mock fetch, as the
   existing tests do); first-listed-port default + multi-port selector; served-error
   rendering; a test asserting the component renders numbers only from response fields (no
   arithmetic — e.g. totals and cash appear only when served) and applies no
   comparison-derived emphasis or reordering of served lists.
2. RED (`npm --prefix web run test`) → implement → GREEN; `npm --prefix web run typecheck`.
3. Commit (`feat(m14.2a): …`).

### M14.2b — Component-internals "At session" (web, nested nodes)

**Files:**
- Modify: `web/src/components/Inspector.tsx` (the read-only `componentNode` branch gains an
  `AtSessionSection` addressed by the breadcrumb trail), `web/src/App.tsx` (pass the trail as
  `component_path`)
- Test: `web/src/components/Inspector.componentNode.test.tsx` (extend),
  `web/src/App.componentInspect.test.tsx` (extend)

**Behavior:** selecting a node inside a component view (M13.9 O3) now also shows its
"At session" values, requesting with `component_path` = the breadcrumb trail's instance ids.
Read-only semantics unchanged; definition immutability untouched (invariant 8).

**Steps:** failing tests (nested request address assembled from the trail; render; served
errors) → RED → implement → GREEN → typecheck → commit (`feat(m14.2b): …`) →
`./scripts/gate.ps1`.

### M14.9 — Closeout (docs + verification; the M13.9 precedent)

**Files:** `docs/LEARNING_LOG.md`, `README.md` (inspection path, if touched),
`docs/reviews/2026-07-11-m14-closeout.md` (or dated at execution time)

**Steps:**
1. Live verification against the demo DB (dev servers per CLAUDE.md): first **confirm the
   demo runs carry `recorded` provenance** (they post-date M9, but verify rather than
   assume — an `unknown`-provenance demo run would need a re-run before the walkthrough);
   then tap the Trailing Return node at a known session; tap an inner Momentum Rank node;
   screenshot evidence into `docs/reviews/` per the M13.9 pattern.
2. LEARNING_LOG entry: recompute-vs-capture as a worked tradeoff, the `outputs`-store
   projection, provenance honesty (`captured: false`), files-studied reading path, one
   hand-exercise for the founder (suggest: predict a tapped value from the formula before
   requesting it).
3. Closeout report: real test counts, definition-of-done checklist with evidence,
   flip-trigger status (all unfired), §13 interaction notes, deferred-work register updated
   (M14.3 gate armed).
4. Full gate; report actual numbers. **Wait for founder review** — do not start M15 work.

## Test blueprint (cross-slice)

- Golden values: Strategy A trailing-return/rank/targets and Strategy B filter/targets at
  fixture sessions, tap == run == the **existing** committed goldens (`tests/goldens/`) —
  mint new goldens only where no existing golden records the number.
- Look-ahead safety on the tap path (M14.1a test 8) — this is the design's headline safety
  test; it must exist before the endpoint ships.
- Byte determinism (service and HTTP layers): identical taps → identical bodies.
- Dataset resolution by fingerprint: one match / zero matches / duplicate-content rows.
- ComponentRef exposed-port tap equals the inner mapped node's value.
- Boolean cross-section digest (Strategy B's trend filter): true/false counts, never min/max.
- Contract: response validates against the regenerated schema; stale codegen fails CI.
- Web: rendering-only discipline asserted; no `web/` test may compute an expected number
  from other served numbers, and no comparison-derived emphasis/reordering exists.
- No network in tests; fixture data only.

## Stop conditions

Design §10 verbatim, operationalized: client-side numerics **including comparison-derived
presentation**; a second evaluation path (ancestor-subgraph pruning counts); engine-boundary
values through the tap; persistence/migration creep; **any persisted or cross-request
memoized recompute result** (a results cache is capture-at-run's sneaky entry point — a
per-request recompute *is* the M14 semantics); contract-shape drift or counterfactual
serves; uncapped series; a §13 finding contradicting the premise. Also: the founder vetoes
any of D-1…D-4 — halt the consuming slice.

## Verification

`./scripts/gate.ps1` (pytest, ruff check, format check, mypy, Node-24 activation, codegen
check, npm typecheck, web typecheck, web test) from any cwd, plus the live demo-DB
walkthrough in M14.9. Every "done" claim cites actual command output.

## Closeout

Per the working process: summary, founder-facing explanation of the recompute projection and
the honesty gates, remaining risks (engine-drift window between upgrades and re-runs; the
unfired flip-triggers), and the §13-gated M14.3 decision queued for the founder.
