# Pre-M9 Remediation, Performance, and API-Readiness Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. No commits, pushes, PRs, or M9 implementation in this sprint.

**Goal:** Close every verified pre-M9 audit finding that is safe to close now, prove the two
measured performance cliffs fixed (or deliberately versioned), and pin the M9 contract — without
changing any ratified financial semantics beyond the founder-authorized warm-up correction.

**Architecture:** One primary writer; fresh read-only reviewers for the plan and for the final
diff. Every numerical path change requires exact-output proof under unchanged node versions.
Persistence changes ride the existing M7 artifact-migration registry (RECORD_FORMAT 1 → 2).

**Baseline:** branch `fix/pre-m9-remediation` forked from `dffcb3a` (content-identical to merged
M8 on `origin/main`); working tree carries the five verified audit-fix files (+82/−3); gate green
at 680 tests; backup patch at `~\quantize-pre-m9-audit-fixes-2026-07-03.patch`.

---

## Finding classification (complete inventory of surviving audit findings)

### FIX BEFORE M9

| # | Finding | Files / symbols |
|---|---------|-----------------|
| B1 | Warm-up off-by-one: `moving_average` declares `window`, `latest` declares `1`, under a gate (`visible > warmup_total`) whose convention (proven by `trailing_return`) is "prior sessions required". Founder-authorized semantic correction. | `quantize/nodes/transform.py:190,236`; `docs/STRATEGY_LANGUAGE.md:264-267`; `tests/test_nodes_descriptors.py:122-124`; `tests/test_reference_backtests.py:220,257`; goldens `strategy_b_backtest.json`, `trace_strategy_b_first_evaluation.json`. **Plan-review correction:** `test_component_evaluation.py:206-207` stays at 5/5 — its component wraps synthetic `test.const` (warm-up = window UNCHANGED), not MA; componentized-MA parity gets a NEW fixture wrapping the real `transform.moving_average` (expect 4 for window 5). |
| D1 | SQLite boundary incomplete: `IntegrityError` caught in repositories (`documents.py`, `runs.py`) despite `database.py` ownership claim; no `busy_timeout`; raw `OperationalError` on lock contention. | `quantize/persistence/database.py`, `documents.py:147,284`, `runs.py:188` |
| E1 | Run records carry no dataset/calendar identity → runs explainable but not verifiably replayable. Founder-authorized additive migrated schema change. | `quantize/persistence/records.py` (RECORD_FORMAT 2), new `quantize/persistence/provenance.py`, `runs.py:save_run`, `migrations.py` registry, golden `persisted_run_envelope.json` |
| G1 | `available_versions` sorts lexically ("1.10.0" < "1.9.0"). | `quantize/registry/registry.py:97-99` |
| G3 | JSON-Schema node union is bare `oneOf` — sound today (disjoint by construction) but unguarded. Add exclusivity tripwire test only; no IR redesign. | `schema/quantize.schema.json`, new test |

### FIX NOW IF EXACTLY OUTPUT-EQUIVALENT (performance)

| # | Finding | Approach |
|---|---------|----------|
| C1 | `_moving_average_evaluate` recomputes the full MA series with independent window sums on every evaluation: measured 5.5 s/eval at 1200×100×w200 (reproduced 4.99 s on this machine); ~3.8 h MA-alone for a 10y/100-asset run. | Run-scoped **positive point cache**: a computed MA point is immutable (visibility is monotone in the cutoff; the dataset is frozen; each point's window sum uses the same closes → identical float ops). Absent points are re-attempted each eval (late-arriving availability can make them computable). NO rolling sum — that changes summation order. Cache threaded via an OPTIONAL memo field on `NodeInvocation` defaulting to None (scope-review acceptance condition: a speed-only channel documented as unable to affect outputs; non-memo paths byte-unaffected); created per run by the engine; never global; keyed by (node path, asset); tracing-on/off equivalence preserved. |
| C2 | `MarketDataSet.as_of` materializes the full all-asset view every session close (mark-to-market) and open (fills): measured 133 ms/call at 2000×100 (reproduced 207 ms here); 446 as_of calls in one fixture strategy_b run. | The engine's per-session needs are O(1) queries (latest visible close; session-D close; session-D open). Add a **runner-local incremental cursor** (`market/data.py`) fed monotonically ascending cutoffs, indexing observations by `available_at` (NOT assuming session-order monotonicity), incrementally exposing arrivals, answering those point queries; falls back to full `as_of` semantics for backward/arbitrary cutoffs. Scope-review hard guard: the cursor must not RE-DERIVE the availability rule independently — its gating is proven exactly equal to `as_of` by non-negotiable property tests (normal/delayed/out-of-order availability, exact boundaries, repeats, backward queries), or shared with it. The evaluator keeps calling `as_of` at evaluation instants only (unchanged contract: "as_of is the only way to read prices at evaluation time"). |
| C3 | Secondary repeated work (full re-validation per evaluation, per-eval re-planning, linear asset scans, `data.price` full re-validation). Measured small at fixture scale (0.10 s / 108 semantic-validation calls). | Measure after C1/C2; implement only bounded changes demonstrated to matter at representative scale. Candidate: one-time validation/plan in `SessionEngine.preflight` passed to `evaluate_strategy` as an optional prepared object built by the SAME validators (no second implementation). API-submitted documents still validate per request (M9 rule). |

### M9 PLAN REQUIREMENT (Workstream I — plan only, no implementation)

- Validation endpoint runs the FULL run-blocking preflight — structural, semantic, component
  resolution, top-level component wiring (incl. ambiguous fan-in, which is checked ONLY there),
  and the terminal rule — via ONE extracted shared function that `evaluate_strategy` also calls
  (no second implementation; plan-review finding). The DTO carries BOTH diagnostic shapes:
  loc-bearing (structural/semantic) and node_path-bearing (resolution/wiring/terminal). Never
  route through the evaluator's flattening (drops `loc`). This extraction is the same seam C3
  uses to avoid per-evaluation re-validation.
- One `Database`/repository lifetime per request; no process-global connection; explicit close;
  structured lock/contention mapping (delivered by D1).
- Server-minted `run_id` (uuid4 server-side); minted ONCE per forward run and REUSED on
  resume (`ForwardCheckpoint.run_id`), never re-minted per request; client ids are references,
  not authority; idempotent submission via content hashes (already deterministic).
- Forward-replay endpoint semantics: v0 = bounded, run-to-exhaustion within one request
  (`last_session` required), returning the same run DTO as backtest; per-session stepping with
  durable checkpoints is an explicitly deferred additive layer.
- fetch-results / fetch-traces DTO shapes defined from the persisted envelope; trace responses
  are the stored event stream (size note recorded; streaming is deferred).
- Save-as-new-version: client supplies version N+1 + `forked_from`; server conflicts on
  `(id, version)` byte divergence (dedupe is on exact bytes, not semantics — G2 records this).
- Dataset identity in the upload flow: content sha256 (`dataset_fingerprint`) names the upload;
  provenance stores hashes, NOT bytes — "verified replayable" means "if matching data is
  re-supplied", never "server can re-run"; the API must not over-claim.
- Provenance exposure: known vs legacy-unknown; "verified replayable" claimed only with recorded
  provenance (delivered by E1).
- Identity terminology: content/artifact identity (exact bytes, exists) vs semantic identity
  (`semantic_projection`, exists, unhashed) vs strategy version vs fork lineage. No additive
  semantic hash in this sprint (no concrete M9 requirement yet) — G2 documents the decision.
- Concurrency: no mutable request-global state (verified true today); synchronous v0 boundary;
  async jobs additive later.

### ACCEPTED DEFERRAL (each with seam / owner / trigger — see §Deferrals)

Stateful-node runtime & cadence & node-state checkpointing; matrices/optimizers; remote nodes;
plugin framework; PostgreSQL; object storage; multi-user; real broker; partial orders; vendor
data adapters; async engine; new port types/node families; `.gitattributes` repo-wide
renormalization; GitHub-Action commit pinning + lock hashes (documented, not forced);
streaming trace persistence (memory ceiling fine at MVP); dffcb3a commit message (history is
immutable; process lesson only); busy-wait connection pooling (explicitly out).

### REJECTED OR ALREADY DISPROVEN

- Rolling-sum MA under the same node version (changes float summation order → violates
  exact-version numerical rule).
- Bisect `as_of` by session index assuming monotonic availability (disproven: the data contract
  permits arbitrary vendor lag; visible set is not a series prefix).
- `binds_to` param-name validation for schema-less nodes (no authoritative name set exists;
  decision documented instead — G4).
- "Fixes" to ratified policies: scaled-buy residue, alphabetical cost-shortfall concentration,
  metrics zero-base 0.0, stale-mark valuation vs fatal reconciliation asymmetry, terminal
  type-id literal, trace_schema declaration-only, ADR-0005 order/fill semantics.
- Byte-identity → semantic-identity conflict switch (would silently change persistence
  semantics; documented as an explicit API/product decision instead).

---

## Workstream details

### A — Verify existing audit fixes (keep only if independently confirmed)

Already reproduced in this session before the fixes were written (TDD red): corrupt/truncated DB
leaked raw `sqlite3.DatabaseError`; failed COMMIT poisoned the handle
(`cannot start a transaction within a transaction`). Confirm post-fix behavior: structured
`corrupt_database` with path context; `OperationalError` (locks) NOT classified as corruption;
same instance usable after failed COMMIT; tripwire detects a removed union member (verified:
simulated drift → False). Docstring states 12 core + terminal (tuple has 13). Definition of
done: all four verified against the working tree; tests green.

### B — Warm-up correction

**Normative rule (one sentence, added to STRATEGY_LANGUAGE.md):** a node's declared warm-up is
the number of visible sessions required STRICTLY BEFORE the evaluation session; the engine
evaluates when `visible_sessions > strategy_warmup_total`.

Hand-computed checks: `latest` needs 0 prior (first eval at visible 1); MA(1) → 0; MA(2) → 1
(first eval at visible 2); MA(200) → 199 (first eval at visible 200 = calendar index 199 =
2025-10-17 for Strategy B — CONFIRMED by the plan reviewer's monkeypatched execution: first eval
moves 2025-10-24 → 2025-10-17, last skip note 2025-10-10, MA uses closes 0..199 only);
`trailing_return(L)` → L unchanged (needs anchor `sessions[-1-L]`); componentized-MA parity via
a NEW fixture wrapping the real MA (window 5 → nested warm-up 4) — the existing
`test_component_evaluation` fixture wraps `test.const` and stays 5/5. Strategy A has NO
moving_average or latest node (reviewer-verified) — numerically UNCHANGED; its goldens and
warm-up note list must stay byte-identical; that is itself an assertion of the change's bounds.
`persisted_run_envelope.json` is strategy_a-windowed → unaffected by B.

Changes: `transform.py` MA warmup `lambda p: require_int(p,"window") - 1`; latest `0`;
STRATEGY_LANGUAGE.md:265-267 + the §2 warm-up definition sentence; `plan.py` WarmupResolution
docstring sharpened ("strictly before"). Tests: descriptor declarations (199/0/126); component
resolution (4); reference `index + 1 == 200` (was `> 200`); new engine boundary tests
(one-before / exactly-enough / one-after) using MA(3) on the harness; latest-only strategy
evaluates at first session; no-lookahead witness re-asserted; backtest↔forward battery
unchanged-and-green. Goldens: regenerate `strategy_b_backtest.json` +
`trace_strategy_b_first_evaluation.json` via `pytest --update-goldens`; produce a golden-diff
report explaining the new first evaluation (2025-10-17), every shifted fill/valuation/trace
event, and why Strategy A goldens did not change. Old persisted artifacts untouched.
Stop condition: ANY unexplained changed number in the golden diff; any Strategy A change.

### C — Performance (see classification above)

Order: reproduce audit benchmarks (scratchpad harness `bench_quantize.py`, DONE — MA 4.99 s,
as_of 207 ms, 446 as_of calls/fixture-run) → C1 memo → prove exact equality → C2 cursor +
property/equivalence tests → re-benchmark → C3 only if measurements justify.
**Numerical-review acceptance conditions (non-negotiable):**
- C1 battery: memo-on vs memo-off compared BIT-EXACTLY (float repr/struct predicate, not bare
  `==`, which treats −0.0 == 0.0), over full `BacktestResult` incl. trace, run BOTH
  `collect_trace=True` and `False`; MUST include a delayed-availability fixture where an MA
  point is absent at one evaluation and computable at a later one (proves the re-attempt path).
- C2 property tests pin: inclusive `<=` availability boundary (equal-instant case);
  out-of-session-order arrivals (latest-close = max session_date over the VISIBLE set, never
  last-arrived; stale marks still returned); zero-observation assets (`()`/None); repeated and
  equal cutoffs idempotent; session-D close/open answered for exactly D, never substituted.
**Benchmark protocol (benchmark-review requirements adopted; anchors independently confirmed:
MA 4.97/4.99 s, as_of 201/207 ms, 446 as_of calls == 446 DataView constructions 1:1):**
- Representative FULL-RUN wall time before/after: 1000 sessions × 100 assets, monthly, w200
  (~133 s before; the cliff-exposing baseline, one-off); repeatable config 750×60 monthly
  (~39 s before), median of ≥5 reps, discard first rep, gc.collect() between, report raw list +
  median (never mean).
- Two-point scaling check (500 and 1000 sessions): per-session-normalized cost must flatten —
  a single-point constant-factor win does not prove the complexity change.
- cProfile attribution on the before-run (re-derive the 70% MA / 22% as_of split; C1-before-C2
  ordering inherits from the profile, not assumption).
- Mechanism assertion after C2: DataView constructions ≈ len(result.evaluations), NOT
  ≈ len(calendar.sessions) (harness monkeypatch counters only; no production instrumentation).
- Only claim a cliff fixed on a ≥5–10× full-run ratio (sub-2× at these magnitudes is jitter);
  trace-on/off differ ~6%, so no optimization may be justified by disabling trace.
Acceptance additionally: complexity statement; hash proofs; remaining-bottleneck statement.
Stop condition: any output/hash difference under unchanged node versions.

### D — SQLite hardening completion

`database.py` (all details experimentally verified by the SQLite plan reviewer):
- Constructor `busy_timeout_ms: int = 5000` keyword; `PRAGMA busy_timeout` executed right after
  connect and BEFORE `_apply_migrations` so migration transactions honor it. Lock tests pass a
  tiny value (~20 ms) and assert error identity plus a generous upper bound, never exact time.
- Lock discriminator: primary error code, not message —
  `(getattr(e, "sqlite_errorcode", 0) or 0) & 0xFF in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)`
  (attributes exist on 3.13/3.14; masked because extended codes like SQLITE_BUSY_SNAPSHOT
  exist); "database is locked" message check only as fallback when the code is absent.
- Map lock contention to structured `PersistenceError("database_locked")` at ALL THREE
  transaction phases — the `BEGIN IMMEDIATE` acquisition (currently OUTSIDE the try; leaks raw
  today; `_in_transaction` stays False on failure), body-path errors (post-rollback), and
  COMMIT (post-rollback via the existing in_transaction-guarded recovery) — and in `query()`.
- Integrity seam: `transaction()` translates `sqlite3.IntegrityError` (after rollback) into a
  persistence-owned `IntegrityViolationError(PersistenceError, code="integrity_violation")`
  carrying the constraint message; `documents.py:147,284` and `runs.py:188` catch THAT and map
  to `ARTIFACT_CONFLICT` exactly as today; both modules drop `import sqlite3`. Translation, not
  a type alias (an alias still couples repos to sqlite3).
- Open-path consistency: with `query()` mapping locks, open-time lock contention surfaces as
  structured `database_locked` through the BaseException close-and-reraise branch (deliberate
  contract choice); the `__init__` OperationalError comment updated — non-lock operational
  faults (e.g. unopenable path) still propagate unchanged; corruption classification unchanged.
- Existing test `test_persistence_migrations.py` failed-COMMIT case RE-TARGETED to
  `PersistenceError("database_locked")` with a tiny busy_timeout (it currently pins the raw
  OperationalError and would otherwise take ~5.5 s under the default timeout).
Tests per prompt battery: corrupt, truncated, valid-empty, rejected COMMIT, post-failure
transaction, integrity violation, second-connection lock (BEGIN-vs-BEGIN writer contention —
the newly covered acquisition path), lock timeout, rollback-after-failure, clean close, no raw
sqlite3 error through public repository methods, no partial artifact after failure.

### E — Run-input provenance

New `quantize/persistence/provenance.py`: `calendar_fingerprint(ExchangeCalendar) -> str`
(sha256 of canonical JSON: exchange, timezone, per-session date/open/close UTC ISO instants);
`dataset_fingerprint(MarketDataSet) -> str` (sha256 of canonical JSON: per-asset observations
incl. open/close prices AND availability instants); `RunInputProvenance` pydantic model —
named to be UNCONFUSABLE with the document's `StrategyProvenance` (creator/owner) —
(status "recorded" | "unknown"; dataset_hash/calendar_hash Optional default None, both present
iff recorded — model validator enforces); `input_provenance_mismatches(recorded, market_data)
-> tuple[str, ...]` reporting `dataset_mismatch` / `calendar_mismatch` / `unknown_provenance`
precisely. `PersistedRunRecord` gains `input_provenance: RunInputProvenance`;
`RECORD_FORMAT = 2`; `record_from_result` gains and threads a required `input_provenance`
parameter (plan-review finding — not just `save_run`); `save_run` gains the REQUIRED keyword
(new runs must record honestly). Call sites to update are ALL tests: ~20 in
`test_persistence_runs.py` and `test_forward_replay.py:137,316,317,352,357,392,393` including
the peek/failed/empty save paths. Register `ArtifactMigration(kind="run_record",
from_version=1)` producing explicit `{"status": "unknown"}` provenance and `record_format: 2`
(no fabricated hashes; `dropped_keys=frozenset()`; realistic `example_input`).
**Plan-review blockers folded in:** `test_production_registry_is_empty_at_format_one`
(`test_persistence_migrations.py:196-199`) MUST be repointed to assert exactly the run_record
1→2 step is registered; ADD a test pinning that re-saving a pre-upgrade format-1 run raises
`ARTIFACT_CONFLICT` (immutability is the intended outcome, documented). Fingerprints computed
once at the save boundary (never per evaluation). Tests per prompt battery, incl. old-format-1
row loads → explicit unknown; identical inputs → identical bytes/hash; one changed observation
/ availability / session boundary / holiday flips the right hash; canonical bytes stable across
repeated builds. Golden `persisted_run_envelope.json` regenerates (format 2) with an explained
diff. Stop condition: any old artifact unloadable; any hash change not explained by the format
bump.

### F — Negative-zero canonicalization

Verified reachable: a scaled-to-zero buy records `cash_delta = -0.0` (`fills.py` `-spend`).
Policy: at the canonical serialization boundary — the `_to_portable` float branch in
`schema/serialization.py` (the single choke point; numerical review confirmed the one live
producer, `PersistedFill.cash_delta = -0.0` from scaled-to-zero buys, flows ONLY through this
path) AND `persistence/serialize.canonical_json_bytes` (plain-dict payloads/fingerprints) —
floats numerically equal to zero serialize as `0.0` — nonzero signs untouched, no domain-object
mutation. Documented spillover (accepted, tested): `_to_portable` also backs IR-document
serialization and `semantic_projection`, so a −0.0 in a document field canonicalizes too and
two documents differing only by −0.0/0.0 become semantically equal — add tests for both.
Loading still accepts historical
`-0.0` bytes (old artifacts keep meaning; their stored hashes are of their stored bytes and are
never rewritten). Confirm current goldens contain no `-0.0` (expected: none) so no golden churn;
prove no financial value changes (−0.0 == 0.0) and backtest↔forward equality. Tests: a record
containing −0.0 serializes canonically, round-trips, hashes stably cross-platform; an
old-stored −0.0 artifact still loads and re-hashes against ITS stored bytes.

### G — Smaller findings

G1 semver: sort `available_versions` by parsed `(major, minor, patch)` (registry version keys are
plain X.Y.Z in v0; parse strictly, fall back to lexical only for nonconforming keys — none
exist). Tests: 1.9.0 < 1.10.0; multi-major; deterministic; exact resolution still mandatory (no
"latest" behavior introduced).
G2 identity terminology: document content vs semantic vs version vs lineage identity in the M9
plan (I); no semantic hash now; byte-conflict behavior preserved and documented as deliberate.
G3 oneOf tripwire: test that every legal node payload (all reference fixtures + crafted edge
cases) matches EXACTLY ONE branch of the committed schema's node union; document that future
variants must preserve exclusivity.
G4 binds_to: documented decision — schema-less registered nodes accept unverified exposed-param
names until implementation-time validation; `parameter_schema` becomes mandatory for future
user-authored node types (recorded in the M9 plan's registry section; no code change; breaking
restriction would need founder review).

### H — Repository/CI

**Scope-review correction (accepted):** do NOT rewrite the canonical `scripts/gate.ps1` — the
rewrite risk to the every-milestone verification tool outweighs the DRY payoff on a 7-line
stage list. Instead add `scripts/gate.sh` as an INDEPENDENT POSIX sibling running the identical
stage set in the identical fail-fast order (pytest, ruff check, ruff format --check, mypy,
Node-24 assertion, codegen check, npm typecheck), with a parity note in both file headers
naming the other script. `ci.yml`: add `concurrency: group: ${{ github.workflow }}-${{ github.ref }}` with
`cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}` (never cancels the authoritative
main-branch run). Document-not-force: `.gitattributes` `* text=auto eol=lf` + renormalization,
action commit-pinning, lock hashes → recorded in §Deferrals with triggers. dffcb3a message:
process lesson only.

### I — M9 implementation contract

New `docs/plans/2026-07-03-m9-api-plan.md` covering the six contract areas in the
classification table above plus request/response DTO sketches, status-code mapping for the
existing stable error codes, and explicit non-goals (no auth, users, Postgres, object storage,
workers, async, deployment).

---

## Deferrals (owner milestone / trigger / seam / why M9 unblocked)

| Deferral | Seam today | Earliest owner | Trigger | Why M9 unblocked |
|---|---|---|---|---|
| Stateful nodes (purity, cadence, state checkpoint) | `NodeImplementation` construction; `ForwardCheckpoint` value object | post-M12 node milestone | first concrete stateful node need | v0 ships none; API shape unaffected |
| Rolling-sum MA (new algorithm) | node versioning (`type_version` 2.0.0) | when C1 memo proves insufficient at real scale | benchmark evidence at >1000 assets | C1 memo removes the cliff without semantic change |
| Streaming trace persistence | trace stored beside record, same tx | M12+ explain/debug milestone | memory ceiling measured in practice | single-write path is correct; ceiling not reached at MVP scale |
| PostgreSQL / object storage | `database.py` ownership boundary; TEXT-portable schema (ADR-0004) | hosted deployment milestone | multi-user requirement | D1 keeps sqlite3 fully encapsulated |
| `.gitattributes` renormalization | partial LF pins for goldens/generated | isolated maintenance PR | before first external contributor | would create a large unrelated diff now |
| Action pinning + lock hashes | exact-pinned versions already | maintenance PR | dependabot introduction | drift risk is documented, not silent |
| Async jobs / workers | synchronous engine API is a pure function | post-M9 | long-running hosted runs | M9 is explicitly synchronous v0 |

## Mandatory stop conditions (inherited from the sprint prompt)

Any ADR change; any financial-semantics change beyond B; any numerical change under an unchanged
node version; unmigrated artifact-meaning change; old artifacts unloadable; persisted IR change;
port-lattice change; M3–M8 failure-policy change; order/fill-semantics change; major dependency;
broad reorganization; large unrelated golden/EOL diff; Postgres/async/M9 code; anything that
breaks backtest↔forward equality or no-lookahead.

## Verification (definition of done for the sprint)

`./scripts/gate.ps1` AND `bash scripts/gate.sh` green; focused batteries per workstream (listed
in each section); goldens regenerated deliberately with an explained diff report; `git status`
clean of unintended files; benchmarks before/after recorded; final adversarial review (8 fresh
read-only reviewers) passed; final report with executive verdict. No commit/push/PR/M9.
