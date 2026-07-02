# M7 — Persistence, migrations, durable result/trace storage (2026-07-02)

Plan-of-record per `PLAN_TEMPLATE.md`. Implements MVP_PLAN §M7 under **ADR-0004 (Accepted)**.
**Core invariants:** governed schemas only (never repr/pickle); exact schema version stored with
every durable artifact; no valid-looking partial writes; validate before returning domain
objects; stable structured errors for unknown/corrupt data; explicit, deterministic, tested,
never-silently-lossy migrations; persistence never mutates caller values and never re-implements
strategy/reconciliation/fill/trace semantics; deterministic serialization; **historical run facts
are preserved, not recomputed**; backends never leak into domain contracts.

## Authoritative inputs & one resolved conflict
MVP_PLAN §M7 (SQLite via repository layer; migrations from this commit; UUID/UTC;
Postgres-targeted schema; store validated IR + `ComponentDefinition` docs; run results + traces
keyed by run + session/instant; retrieval without rerunning). ADR-0004 (SQLite behind a thin
repository layer; flat JSON files **explicitly rejected**; canonical JSON documents, not
per-node tables; UUID PKs, UTC, portable column types, migration discipline from the first
persistence commit). ARCHITECTURE §4/§5. M1 serialization boundary (`to_ir_json` — canonical,
aliased, portable, deterministic). M6 trace contracts (in-payload `"v"`, envelope,
`golden_bytes` discipline).
**Resolved:** the sprint brief's illustrative slice named a "filesystem backend"; the Accepted
ADR-0004 and MVP_PLAN both mandate SQLite and rejected flat files. The repo's normative sources
agree with each other → **SQLite (stdlib `sqlite3`, zero new dependencies)**. Its transactions
provide the atomic/crash-safe guarantee natively.

## Persisted artifact boundaries (three kinds + components)
1. **Strategy documents** — the validated IR JSON, verbatim through the M1 canonical
   serializer (`ui.*`/extensions preserved). Key: `(strategy.id UUID, strategy.version int)` —
   already in the IR.
2. **Component definitions** — same treatment. Key: `(component_id UUID, version SemVer)`.
3. **Run records** — the engine's historical FACTS: run_id, strategy identity, exchange/
   timezone, first/last session, valuations, evaluations (targets, reconciliation
   portfolio_value/target_cash/projected_cash, plans incl. dust/hold rows, orders,
   fill_session), fills (with instants + scaled), stale marks, notes, metrics
   (total_return/max_drawdown), final state, ok/diagnostics. Serialized FROM the
   `BacktestResult` at save; **never recomputed at load**. The in-memory `ExchangeCalendar` is
   an engine input, not a run fact — the record stores exchange/timezone + session dates that
   appear in the facts; M8 replay re-supplies market data explicitly.
4. **Trace streams** — the run's `TraceEvent`s, verbatim (envelope fields + M6-versioned
   payloads), stored per run in emission order (`seq`) with the instant as a column. Because
   every instant's ISO date IS its session date (close events on D; open events on the fill
   day), date-keyed retrieval needs no calendar logic in persistence.

## Schema identity & version placement
- **DB structure:** integer `schema_migrations` version (per-database), applied forward-only.
- **Strategy/component payloads:** their own IR `schema_version` (M1-governed) — no second
  version invented; the row records it for query/gating.
- **Run records:** new persistence-governed envelope `{"record_format": 1, ...}` (Pydantic
  model → published shape via the M1 serializer).
- **Trace events:** stored row format `trace_format = 1` per run; each payload already carries
  M6's `"v"`.
Every durable row stores its exact format/schema version explicitly.

## Migrations
- **DB migrations:** ordered `(version, purpose, SQL)` tuples in `persistence/migrations.py`,
  applied in one transaction each at open; `schema_migrations(version, applied_at UTC)` from
  THIS commit (ADR-0004). A database ahead of the code (unknown higher version) → structured
  error, never best-effort.
- **Artifact-format migrations:** per-kind registry `{(kind, from_version): migration_fn}`,
  applied at LOAD (read-time, forward-only chain to current; stored bytes never rewritten
  silently). Deterministic pure functions over the JSON dict; each registered migration ships
  with a test proving output validity and no silent loss (every input fact either mapped or the
  migration documents+tests the explicit drop). v0 ships format 1 everywhere, so the registry
  is exercised by a synthetic test-kind migration proving the seam works.
- **Direction:** forward only (old stored → current in-memory). Downgrade/writing old formats
  is out of scope and rejected loudly.
- **Unknown version:** stored version > current or a gap in the chain → `unsupported_artifact_version`
  (structured), mirroring M1's unsupported `schema_version` posture.

## Errors, corruption, validation
`quantize/persistence/errors.py`: `PersistenceError(code, message, context)` with stable codes:
`artifact_not_found`, `artifact_conflict` (same key, different canonical bytes),
`unsupported_artifact_version`, `unsupported_database_version`, `corrupt_artifact` (JSON decode
failure, envelope/shape mismatch, or domain validation failure at load), `invalid_artifact`
(rejected at SAVE: unvalidated/non-portable input). **Load path:** bytes → JSON → format check →
(migrate) → domain validation (`StrategyDocument.model_validate` / record model / TraceEvent
construction) → frozen domain object. Corrupt data NEVER returns a partial object.

## Atomicity & crash safety
Single SQLite connection per repository operation scope; every mutation inside an explicit
transaction (`BEGIN IMMEDIATE` … commit/rollback via context manager). Multi-row saves (run
record + its trace stream) are ONE transaction — a crash yields either nothing or everything,
never a run without its trace tail. SQLite journaling defaults retained; no partial artifact is
observable through the repository API. Tested by fault-injection (exception mid-batch → rollback
→ database unchanged) and raw-SQL corruption probes.

## Storage abstraction & backend
`quantize/persistence/database.py`: a thin `Database` wrapper owning connection lifecycle,
migration application at open, transactions, and pragmas (`foreign_keys=ON`). Repositories
(`strategies.py`, `components.py`, `runs.py`) depend on `Database` and expose ONLY domain
objects and plain values — no sqlite3 types, rows, or SQL leak into contracts (ADR repository
discipline; a future Postgres move touches this package only). Postgres-ready columns: TEXT
UUIDs, TEXT ISO-UTC timestamps, INTEGER versions, TEXT JSON payloads; no SQLite-only features.

## Layout (migration 1)
- `strategies(strategy_id TEXT, version INTEGER, schema_version TEXT, name TEXT,
  content_hash TEXT, document TEXT, saved_at TEXT, PRIMARY KEY(strategy_id, version))`
- `components(component_id TEXT, version TEXT, schema_version TEXT, name TEXT, content_hash
  TEXT, document TEXT, saved_at TEXT, PRIMARY KEY(component_id, version))`
- `runs(run_id TEXT PRIMARY KEY, strategy_id TEXT, strategy_version INTEGER, record_format
  INTEGER, ok INTEGER, first_session TEXT, last_session TEXT, record TEXT, saved_at TEXT)`
- `trace_events(run_id TEXT, seq INTEGER, timestamp TEXT, event TEXT,
  PRIMARY KEY(run_id, seq), FOREIGN KEY(run_id) REFERENCES runs(run_id))`
- `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)`

## IDs, duplicates, immutability
Natural keys from the artifacts themselves (UUID discipline per ADR): strategies
`(strategy.id, version)`, components `(component_id, version)`, runs `run_id`. **Duplicate
save semantics:** identical canonical bytes for an existing key → idempotent no-op (returns the
existing identity); different bytes for an existing key → `artifact_conflict` — persisted
artifacts are immutable, there is no update/overwrite API. `content_hash` = SHA-256 of the
canonical bytes, stored for cheap idempotency checks and integrity assertion at load. Loads
return freshly validated objects each call (frozen dataclasses / new model instances); saves
never mutate inputs (serializer is read-only over them).

## Save/load/list/query contracts
- Strategies: `save(document) -> StrategyKey` · `load(strategy_id, version) -> StrategyDocument`
  · `list_strategies() -> tuple[StrategySummary, ...]` (id, version, name, schema_version,
  saved_at) · `list_versions(strategy_id)`.
- Components: same shape.
- Runs: `save_run(record_inputs...) -> run_id` (record + trace in one transaction) ·
  `load_run(run_id) -> PersistedRunRecord` · `list_runs(strategy_id | None)` →
  summaries (run_id, strategy identity, ok, window, total_return, saved_at).
- Traces: `load_trace(run_id) -> tuple[TraceEvent, ...]` (emission order) ·
  `load_trace(run_id, session_date=...)` → that date's events (per-instant trees then come free
  via M6 `build_trace_trees`) — "fetch the trace for a selected run + date without rerunning."

## Relationships
`runs.strategy_id/strategy_version` reference the saved strategy (FK not enforced across
strategies in v0 — a run of an unsaved strategy is allowed and recorded as such? **No**:
`save_run` requires the strategy row to exist (FK enforced) — provenance is the point of
persistence; the test suite saves the document first. Trace events belong to exactly one run
(FK, same transaction).

## Portability
Canonical serializer reuses the M1 boundary (`to_ir_dict`/`to_ir_json` — aliased, portable,
rejects NaN/non-finite/unsafe ints) + `canonical_json_bytes` (compact separators, sorted keys
for non-model dicts, `ensure_ascii=False`, `allow_nan=False`, UTF-8). Floats persist via
shortest-round-trip repr — bit-exact on load (`json.loads` reverses exactly), platform-stable
(proven by the golden suite). Text columns are UTF-8; ISO-8601 UTC timestamps; no OS-specific
paths in artifacts. Same bytes on Windows/Linux and Python 3.13/3.14 (CI proves both).

## What M8 consumes (without building replay now)
`load_run` + `load_trace` give M8 the stored backtest facts to compare against a forward replay
(same run facts, no recompute), plus the strategy document by pinned identity. Nothing else.

## Explicitly out of scope
M8 replay; cloud storage; auth; multi-user concurrency (single local process; SQLite's
file lock is incidental, not a contract); production DB ops (backup/vacuum); Postgres itself;
querying inside documents; trace-tree storage (trees rebuild from events); result pagination.

## Slices
1. **M7.1** Plan + adversarial reviews (this document).
2. **M7.2** `quantize/persistence/`: errors, canonical serializer helpers, run-record models
   (facts envelope, `record_format=1`).
3. **M7.3** `database.py` + `migrations.py` (migration 1, forward-only runner, unknown-version
   rejection) + migration-seam tests (synthetic registry migration).
4. **M7.4** Strategy + component repositories (save/load/list, idempotency, conflict,
   corruption, round-trip incl. `ui.*`/extensions preservation).
5. **M7.5** Run + trace repositories (single-transaction save, load, list, date-keyed trace
   retrieval, fact-preservation round-trip from real Strategy A/B runs).
6. **M7.6** Integration/corruption/recovery/portability tests (fault injection, raw-SQL
   corruption, ahead-of-code DB, hash mismatch, cross-version determinism byte tests).
7. **M7.7** Self-review, gate, learning log, report. STOP before commit.

## Test blueprint
Migrations: fresh DB reaches version 1; reopening idempotent; DB at version 99 → structured
error; synthetic artifact migration chain (1→2→3) proves order, determinism, and loud gaps;
lossy-migration guard test (documented drop asserted). Repositories: round-trip equality
(document bytes verbatim incl. `ui.*`; run facts field-by-field vs the live `BacktestResult`);
idempotent duplicate; conflict on divergent bytes; not-found; corrupt JSON / wrong shape /
failed domain validation / hash mismatch → `corrupt_artifact`; unknown record_format →
`unsupported_artifact_version`. Atomicity: injected failure between record and trace writes →
nothing persisted; partial batch rollback. Traces: emission order preserved; date-keyed load
returns exactly that session's instants; `build_trace_trees(load_trace(...))` equals trees
built from the live run. Determinism: same artifact saved into two databases → identical
canonical bytes + hash. No-mutation: inputs compared before/after save. Real-data: Strategy A
and B engine runs persisted and reloaded with all facts equal.

## Adversarial plan-review amendments (three reviewers; all findings adopted)
**Blockers fixed:**
1. **IR `schema_version` gated at load.** `model_validate` checks SemVer syntax only; the load
   path now explicitly gates the stored document `schema_version` against M1's
   `SUPPORTED_SCHEMA_VERSIONS` → `unsupported_artifact_version` (structured), before domain
   validation. Two version axes, both enforced: persistence formats (migration registry) and IR
   schema version (M1 gate).
2. **Run instants preserved.** `evaluation_instant` and `scheduled_fill_instant` (and the
   `returns` series) are persisted explicitly — the calendar is dropped, so they are NOT
   reconstructable; they are run facts.
3. **SQLite transaction config pinned:** connections open with `isolation_level=None`
   (never the 3.12+ `autocommit=` param); `Database` drives explicit
   `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` — the only config where migration DDL + bookkeeping
   INSERT, and the run+trace multi-row save, are each truly one transaction on 3.13 and 3.14.
4. **Backend-leak test:** a named test asserts every repository return value is a domain object
   or plain value (no `sqlite3.Row`/`Cursor`/SQL in any contract).
5. **Trace contiguity:** `load_trace` asserts `seq` is gap-free (0..n-1) →
   `corrupt_artifact` on gaps; a probe deletes a mid-stream row and asserts the error.
**Should-fixes adopted:**
- `runs.mode` column (TEXT, `"backtest"` in v0) — ADR-0004's entity sketch and M8's
  backtest-vs-forward partition need it now, not as an M8 migration.
- `save_run(document, result, ...)` **auto-saves the strategy document idempotently inside the
  same transaction** (no bare FK precondition; provenance preserved without caller friction).
  Strategy identity comes from the document (it is not a `BacktestResult` fact).
- Migration bootstrap: absent `schema_migrations` table ⇒ version 0; each migration's DDL and
  its bookkeeping INSERT commit in ONE transaction.
- **Loss-guard mechanism, not discipline:** every artifact migration declares
  `dropped_keys: frozenset[str]`; a generic registry test asserts, for every registered
  migration over its test input, `output_keys ⊇ input_keys − declared_dropped_keys`.
- The synthetic seam migration registers a test kind in the SAME registry and is driven through
  the SAME load→format-check→migrate→validate dispatch as real kinds.
- **Content hash = SHA-256 of the EXACT stored bytes** (`to_ir_json` model/insertion order for
  documents; the record envelope's canonical dump for runs) — never a re-sorted form;
  `canonical_json_bytes` (sorted keys) exists only for non-model dicts and is never applied to
  model-derived payloads. A byte-level round-trip test with reordered `ui.*`/`extensions` keys
  pins `to_ir_json(model_validate(bytes)) == bytes`.
- `saved_at` is row metadata (wall clock permitted) and is EXCLUDED from hashed bytes and
  artifact identity.
- One connection owned per `Database` instance, shared by repositories; `Database` is a context
  manager with deterministic close (Windows file locks: tests close before tmp_path
  teardown/reopen).
- Fault injection lands on the Nth statement AFTER a real in-transaction write (monkeypatched
  execute), not on pre-write serialization; raw-SQL corruption probes use the `Database`
  connection as test-only access (not a contract leak).
- Committed **persistence goldens** (one run-record envelope from a windowed deterministic run +
  one document envelope) as the independent, cross-platform determinism anchor; reloaded traces
  additionally byte-compare against the M6 committed trace goldens via `trace_tree_summary`.
- No-mutation tests deepcopy-snapshot inputs BEFORE save (mutable trace payload dicts are the
  hole same-object comparison misses).
- FK-orphan tests (trace rows require their run); unknown `trace_format` test symmetric to
  `record_format`; stored version columns directly asserted per kind; error code strings pinned.
- Read-time-migration tradeoff acknowledged: every load pays the chain; stored bytes stay at
  their original format (no lazy rewrite) — accepted for v0 scale.
- Cross-OS/version byte identity is proven by the CI matrix re-checking committed goldens on
  Linux/3.13/3.14; the local Windows suite proves within-platform determinism and bit-exact
  float/timestamp round-trips. Module-scoped A/B engine fixtures bound new-test runtime.

## Stop conditions
Standing ones (durable-contract ambiguity, breaking M1–M6 change, migration-loss question,
atomicity impossibility under SQLite). None anticipated.
