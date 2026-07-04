# M9 — API Boundary + Strategy & Component Versioning — Implementation Plan (2026-07-03)

> Plan-of-record for M9, authored by the planning session (no production code written).
> **For the implementer (Opus):** execute the Implementation slices IN ORDER as bounded packets;
> each packet is test-first, independently green, and must not begin before the previous packet's
> definition of done is met. Contract decisions in this document are RESOLVED — do not re-derive
> them; stop conditions list the only open items. Companion contract document:
> `docs/plans/2026-07-03-m9-api-plan.md` (merged, authoritative; this plan operationalizes it).

## Purpose & definition of done

M9 exposes the existing engine/persistence core over a thin, versioned FastAPI JSON boundary:
validate IR, run backtest, run forward replay, fetch results, fetch traces, save/load/list
strategy versions, create/list/load `ComponentDefinition`s, and upload datasets (required input
for API-triggered runs). The API is a translation layer — HTTP → governed DTO → existing domain
service → governed result → HTTP — with **zero business logic** in the boundary.

**Done means:**
- All endpoints of §Contracts implemented on `quantize/api/`, synchronous, per-request DB handle.
- Every new request/response envelope is a codegen-governed contract: committed
  `schema/quantize-api.schema.json` + `ts/quantize-api.d.ts`, staleness-gated in CI, with
  contract tests mirroring the IR ones. No hand-maintained TS. FastAPI's `openapi.json` is a
  runtime derivative, never committed authority.
- The validate endpoint is run-faithful (five-layer preflight parity, proven by test) and
  loc-preserving (dual diagnostic shapes).
- Runs persist with recorded provenance; fetch-results returns the format-2 envelope verbatim
  plus `replay_verifiable`.
- The full error taxonomy of §Contracts maps per-(endpoint, code); no raw sqlite3/pydantic
  internals and no server filesystem paths in any response.
- Both gates green (`./scripts/gate.ps1`, `bash scripts/gate.sh`); `codegen check` covers both
  bundles; existing 717 tests untouched-and-green; new API tests per the Test blueprint.
- CLAUDE.md "Run backend / API" TBD filled; LEARNING_LOG entry written.

## Authoritative inputs

`docs/MVP_PLAN.md:226-236` (§M9 verbatim scope; §M10:240-250 and §M11:254-265 boundaries);
`docs/plans/2026-07-03-m9-api-plan.md` (ratified contract decisions a–j, see below);
`CLAUDE.md` + `AGENTS.md` invariants (esp. 4/5/6/9); ADR-0001 (stack), ADR-0004 (database);
`docs/plans/2026-07-03-pre-m9-remediation-plan.md` (standing stop conditions);
`docs/reviews/PRE_M9_CODEX_REVIEW.md` (the one open product decision).

Ratified by the merged m9-api-plan — DO NOT REOPEN: (a) five-layer validate composition via one
extracted function returning NATIVE diagnostic shapes; (b) 400/422/200-ok:false validation HTTP
semantics; (c) per-request Database lifecycle; (d) stable-code→HTTP mapping with
`unsupported_database_version`→500; (e) server-minted run_id, reused on forward resume;
(f) provenance exposure without over-claim (`replay_verifiable`); (g) four-identity terminology,
byte-dedupe; (h) API DTOs ride codegen with contract tests; (i) synchronous v0, no mutable
request-global state; (j) non-goals (no Postgres/auth/users/object storage/workers/async/deploy).

## Scope

- `quantize/api/` — FastAPI app factory, settings, routes, DTOs (fastapi-free DTO modules),
  error mapping. New subpackage; owns NOTHING numerical.
- `quantize/evaluator/preflight.py` — the extracted five-layer document preflight (domain
  refactor; the single shared validation implementation).
- `quantize/persistence/` — one additive `DatabaseMigration(version=2)` (datasets table) + a
  `DatasetRepository`; no changes to existing tables or artifact formats.
- `quantize/codegen/` — second governed bundle (API DTOs) alongside the IR bundle.
- `tests/api/` + `tests/test_preflight_extraction.py` — per the Test blueprint.
- Docs: CLAUDE.md run command, LEARNING_LOG, this plan's closeout.

## Exclusions (with owning milestone)

- Node-descriptor / parameter-form / `is_compatible` metadata endpoints → **M10** (MVP_PLAN:240).
- Any frontend, React, editor consumption → **M11+**.
- Component authoring/extraction UI → **M12**.
- Auth, users/workspaces, rate limiting, multi-tenancy, CORS policy → deferred (m9-api-plan §10;
  CORS arrives with the M11 editor, scoped — never a blanket `*` now).
- PostgreSQL, object storage, WAL switch, pooling, async SQLite, background workers, async jobs,
  deployment infra → deferred (ADR-0004; m9-api-plan §10).
- Interactive forward stepping / durable checkpoints over HTTP → deferred (m9-api-plan §5);
  forward is bounded run-to-exhaustion per request.
- Replay-verification endpoint → OPTIONAL packet M9.9, ships only on founder go (m9-api-plan §7
  marks it optional).
- Committed/gated OpenAPI document → not governed in M9 (the API schema bundle is the governed
  artifact; `app.openapi()` stays a runtime derivative).

## Contracts & invariants

### Endpoints (all under the `/v1` path prefix)

| Method+Path | Request | Success | Client errors |
|---|---|---|---|
| `GET /v1/meta` | — | 200 `MetaResponse{api_version:"v1", schema_version:"0.1.0", record_format:2, trace_format:1}` | — |
| `POST /v1/strategies` | raw `StrategyDocument` JSON body | 201 `StrategySaved{strategy_id, version}` | 400 parse; 422 unsupported schema_version/invalid; 409 divergent bytes under (id,version) |
| `GET /v1/strategies` | — | 200 `StrategyList` (summaries) | — |
| `GET /v1/strategies/{id}/versions` | — | 200 `VersionList{versions:[int]}` | 404 |
| `GET /v1/strategies/{id}/versions/{version}` | — | 200 the stored `StrategyDocument` verbatim | 404 |
| `POST /v1/strategies/validate` | raw `StrategyDocument` JSON body | 200 `ValidateResponse` (ok true/false) | 400 parse; 422 unsupported schema_version |
| `POST /v1/components` | raw `ComponentDefinition` JSON body | 201 `ComponentSaved{component_id, version}` | 400/422/409 as strategies |
| `GET /v1/components` | — | 200 `ComponentList` | — |
| `GET /v1/components/{id}/versions/{version}` | — | 200 stored `ComponentDefinition` | 404 (version is a SemVer string path param) |
| `POST /v1/datasets` | `DatasetUpload` | 201 (new) / 200 (idempotent re-upload) `DatasetStored{dataset_id, dataset_fingerprint, calendar_fingerprint, sessions, assets}` | 400/413/422 |
| `GET /v1/datasets/{dataset_id}` | — | 200 `DatasetStored` (metadata only, NOT payload) | 404 |
| `POST /v1/runs/backtest` | `BacktestRunRequest` | 201 `RunCreated{run_id}` | 404 strategy/dataset; 422 body |
| `POST /v1/runs/forward` | `ForwardRunRequest` (`last_session` REQUIRED) | 201 `RunCreated{run_id}` | 404; 422 missing last_session |
| `GET /v1/runs` (`?strategy_id=`) | — | 200 `RunList` (RunSummary rows) | — |
| `GET /v1/runs/{run_id}` | — | 200 `RunRecordResponse{record: PersistedRunRecord, replay_verifiable: bool}` (nested — audit M3) | 404 |
| `GET /v1/runs/{run_id}/trace` (`?session_date=`) | — | 200 `TraceResponse{events:[TraceEvent]}` (stored seq order) | 404 |

Notes: a run request that produces `ok=False` still persists (honest partial facts) and returns
201 with the run_id — the client reads `ok` from fetch-results; run execution is synchronous
within the request (ratified). `collect_trace` is NOT exposed — v0 always collects (the trace is
part of the durable artifact). Engine `EVALUATION_FAILED`/`RECONCILIATION_FAILED` etc. are run
FACTS (persisted diagnostics), not HTTP errors.

**Stored-bytes emission (audit M3):** GETs that promise the stored artifact "verbatim"
(`GET /v1/strategies/{id}/versions/{v}`, `GET /v1/components/...`) return the stored canonical
TEXT directly via a raw `Response(content=<stored bytes>, media_type="application/json")` —
NEVER re-serialized through FastAPI's model encoder (which does not reproduce `to_ir_json`'s
compact/aliased canonical form). For `GET /v1/runs/{run_id}` the byte-equality claim applies to
the `record` VALUE inside the nested envelope: the handler embeds the stored record text (or an
equality test asserts `to_ir_json(record)` equals the stored bytes) while `replay_verifiable`
lives beside it, never inside it.

### DTO inventory (all codegen-governed; frozen, `extra="forbid"`, serialization-mode aliases)

Fastapi-free modules `quantize/api/dto/*.py`. Roots for `build_api_bundle()`:
`MetaResponse`, `ApiError`, `StrategySaved`, `StrategyList`, `VersionList`, `ComponentSaved`,
`ComponentList`, `ValidateResponse` (carrying `StructuralDiagnosticDto{code,message,loc,subject}`,
`SemanticDiagnosticDto` (same shape), `RuntimeDiagnosticDto{code,message,node_path,subject}`,
optional `warmup_sessions`), `DatasetUpload` (see below), `DatasetStored`, `BacktestRunRequest`,
`ForwardRunRequest`, `RunCreated`, `RunList`, `RunRecordResponse`, `TraceResponse`.
`StrategyDocument`/`ComponentDefinition`/`PersistedRunRecord`/`TraceEvent`/`RunInputProvenance`
are REUSED (already governed models) — request bodies for strategy/component/validate are the IR
documents themselves; `RunRecordResponse` embeds `PersistedRunRecord`.

`DatasetUpload` (the new cross-language contract; mirrors the market dataclasses):
```jsonc
{ "calendar": { "exchange": "QSE", "timezone": "UTC-05:00",
    "sessions": [ {"session_date": "2026-01-05", "open_at": "...", "close_at": "..."} ] },
  "observations": { "AAA": [ {"session_date": "2026-01-05", "open_price": 10.0,
      "close_price": 10.5, "open_available_at": "...", "close_available_at": "..."} ] } }
```
Conversion `DatasetUpload -> MarketDataSet` constructs the frozen dataclasses and lets their
`__post_init__` contracts validate (calendar membership, ascending dates, positive-finite
prices, availability ≥ session instants); constructor `ValueError`s map to 422 with the message.

Run-request DTOs (PINNED here so M9.3 freezes them without invention — audit finding B1; dates
are ISO `YYYY-MM-DD` strings → `date` at the boundary):
```jsonc
// BacktestRunRequest
{ "strategy_id": "…", "strategy_version": 1, "dataset_id": "<64-hex>",
  "initial_cash": 1000000.0, "initial_positions": {"AAA": 10.0},   // optional, default {}
  "first_session": "2025-07-31",                                    // optional, default null
  "last_session": "2025-08-29" }                                    // optional for backtest
// ForwardRunRequest — identical fields, but last_session is REQUIRED (bounded replay)
```
List-row DTOs (audit m6) mirror the existing frozen summaries field-for-field:
`RunListRow` ≡ `RunSummary` (runs.py:66), `StrategyListRow` ≡ `StrategySummary`
(documents.py:46), `ComponentListRow` ≡ `ComponentSummary` (documents.py:61) — wrapped as
`RunList{runs:[…]}`, `StrategyList{strategies:[…]}`, `ComponentList{components:[…]}`.
`loc` in diagnostic DTOs is `tuple[str|int, ...]` → TS `(string|number)[]` — the API contract
test asserts the mixed array intentionally (audit n3).

### Identity & idempotency (resolved)

- `dataset_id = content_hash(canonical_json_bytes(upload_payload_dict))` — the FULL upload
  (calendar + observations), because `dataset_fingerprint` alone excludes the calendar (two
  uploads with identical observations but different calendars must not collide). The response
  also carries both provenance fingerprints. Re-upload of identical bytes → 200 idempotent.
- Run submission is NOT idempotent: the server mints a fresh uuid4 per POST; a retried POST
  re-executes and creates a new run. This is the DOCUMENTED v0 semantic (deterministic engine ⇒
  duplicate runs are byte-identical except run_id; M7 content-idempotency protects re-saves of
  an identified run, not duplicate submissions). No client idempotency key in M9.
- `initial_cash` (required, > 0 finite) + optional `initial_positions` map on run requests; NOT
  persisted (recoverable from `valuations[0]` only for flat starts — documented caveat; the
  optional verify endpoint therefore TAKES initial state as input).

### Error taxonomy (per-(endpoint-class, code) — Track-4-refined; supersedes any flat map)

| Condition | HTTP |
|---|---|
| Unparseable JSON body | 400 (custom handler — FastAPI's default 422 is overridden for parse failures) |
| Pydantic shape failure on a governed body | 400 |
| Unsupported `schema_version` (pre-parse string gate) | 422 with the structural diagnostic |
| `invalid_artifact` on a CLIENT save (bad document content) | 422 |
| `invalid_artifact` raised by server-internal invariants (`save_run` unknown-provenance guard, non-exhausted peek) | 500 — clients cannot cause these |
| `unsupported_artifact_version` on LOAD (stored artifact newer than code) | 500 |

**Split mechanism (audit M1 — one code cannot be status-keyed globally):** client-save route
handlers catch `PersistenceError` locally and map `code == invalid_artifact` → 422 there; the
GLOBAL exception handler maps every code flat per this table with `invalid_artifact` defaulting
to **500** (reachable there only via server-internal invariants). Pinned in M9.2's `errors.py`
design and exercised in M9.4's tests.

**AMENDMENT to `2026-07-03-m9-api-plan.md` §3 (audit M2 — explicit, not silent):** that document
groups `unsupported_artifact_version` with client-submitted 422s. Verified against the code:
`UNSUPPORTED_ARTIFACT_VERSION` is raised ONLY by `migrate_to_current` on a STORED artifact newer
than the running code (a load/operator condition, parallel to `unsupported_database_version`);
a client cannot submit it. This plan therefore amends the mapping to **500**, with this rationale
recorded for founder visibility. (`invalid_artifact` remains 422 for genuine client saves per
the split above.)
| `artifact_not_found` | 404 |
| `artifact_conflict` (incl. ui-only edit under same version) | 409 |
| `database_locked` | 503 + `Retry-After` |
| `corrupt_artifact` / `corrupt_database` / `unsupported_database_version` | 500 |
| RecursionError from depth-bomb payloads | cannot occur: bodies validate via `model_validate_json(raw_bytes)` (rust path), never a pre-parsed dict; plus body-size cap → 413 |

`ApiError{code, message}` only — **`PersistenceError.context` is NEVER serialized** (the
`corrupt_database` context carries the server's filesystem path). Diagnostic DTOs (domain
values) are distinct from ApiError (infrastructure) and are fine to expose.

### Settings & lifecycle (resolved)

- Frozen `ApiSettings` dataclass: `db_path` (env `QUANTIZE_DB_PATH`, default `quantize.db`),
  `busy_timeout_ms` (default 1000 for the API — shorter than the library's 5000; 503 is
  retryable), `max_body_bytes` (default 10 MiB; applies to all POSTs incl. dataset upload → 413).
- Yield-FREE FastAPI dependency `get_settings()`; **handlers own the DB handle in their own
  body**: `with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:` —
  guaranteed single-thread under sync-def endpoints (sqlite3 same-thread default), deterministic
  close, no yield-dependency teardown-thread uncertainty. Tests override `get_settings` with a
  tmp_path-backed instance.
- All endpoints are sync `def` (threadpool); NEVER `async def` wrapping blocking engine calls.
- App startup (lifespan): one migrating `Database` open so the first request never pays first-open.
- Run command (fills CLAUDE.md TBD): `uvicorn quantize.api.app:create_app --factory --host 127.0.0.1 --port 8000`
  — localhost binding is the documented default (no auth exists by design).
- `build_core_catalog()` per request (cheap, stateless) or per-app — per-REQUEST for zero shared
  state (measured trivial).

### Codegen (resolved — second bundle; Track 7 mechanism)

`schema/quantize-api.schema.json` + `ts/quantize-api.d.ts` from `_API_ROOT_MODELS` via
`build_api_bundle()` reusing `_clean_defs`/`build_ts_input`/`canonical_json`/
`generate_typescript` unchanged; `pipeline.py` `generate`/`check`/`_build_expected` generalized
to iterate (bundle_fn, schema_path, ts_path) triples; NO top-level oneOf for the API bundle;
`.gitattributes` gains LF pins for both new artifacts. DTO modules import NOTHING from fastapi,
so the CI codegen job stays lock-only. Do NOT extend the IR `_ROOT_MODELS` (it would corrupt the
IR union and its contract tests).

### Preflight extraction (resolved — Track 3 spec)

New `quantize/evaluator/preflight.py`:
```python
@dataclass(frozen=True)
class PreflightResult:
    structural: tuple[StructuralError, ...]        # sorted (validator-native)
    semantic: tuple[SemanticDiagnostic, ...]       # sorted; () if structural failed
    runtime: tuple[RuntimeDiagnostic, ...]         # resolution+wiring+terminal, sorted
    resolution: ResolvedStrategy                   # reused downstream (.instances/.ok)
    structural_ok: bool; semantic_ok: bool; resolution_ok: bool
    @property
    def ok(self) -> bool: ...

def run_document_preflight(document, *, registry: NodeRegistryView,
                           components: ComponentCatalog | None = None) -> PreflightResult
```
Move `_toplevel_component_wiring` + `_terminal_nodes` into the new module (public there);
`evaluate_strategy` calls `run_document_preflight`, performs its OWN down-conversion to
`RuntimeDiagnostic` at its call site (current strings `"structural: "`/`"semantic: "` preserved
byte-identically), keeps the DATA-dependent `NO_VISIBLE_SESSION` check inline (evaluate.py
:466-473), and reuses `result.resolution`. The extractable document-layer block is
evaluate.py:425-464 (audit n1). Existing evaluator/diagnostic tests must stay green untouched. The gate
sequence, gating conditions (semantic gated on structural_ok; wiring/terminal gated on
semantic_ok and resolution_ok), and per-layer sort functions are copied exactly.

Validate endpoint staging: (1) body bytes > cap → 413; (2) `json.loads` fail → 400;
(3) PRE-PARSE gate: `raw.get("schema_version")` unsupported → 422 (a future-version document may
not parse under the 0.1.0 model — the string gate makes 422-vs-400 robust);
(4) `StrategyDocument.model_validate_json(raw_bytes)` failure → 400 (raw-bytes path also
neutralizes the depth-bomb RecursionError); (5) `run_document_preflight` → 200 with dual-shape
diagnostics; ok:true additionally carries `warmup_sessions = resolve_warmup(document, catalog,
result.resolution).total` (no market data needed — verified).

### Dataset store (resolved)

`DatabaseMigration(version=2, purpose="dataset store: content-addressed uploaded market data",
statements=(<the CREATE TABLE below>,))` — the dataclass takes `(version, purpose,
statements: tuple[str, ...])`, migrations.py:26 (audit m10): `CREATE TABLE datasets (dataset_id
TEXT NOT NULL PRIMARY KEY, dataset_fingerprint TEXT NOT NULL, calendar_fingerprint TEXT NOT
NULL, payload TEXT NOT NULL, saved_at TEXT NOT NULL)` (Postgres-portable types per ADR-0004). `DatasetRepository(database)`:
`save(upload: DatasetUpload) -> DatasetStored` (content-addressed, idempotent by dataset_id;
divergence impossible by construction), `load(dataset_id) -> MarketDataSet` (payload →
DatasetUpload → domain conversion; corrupt rows → `corrupt_artifact`), `describe(dataset_id) ->
DatasetStored`. Payload stored as canonical JSON TEXT in SQLite (object storage deferred).

## Unresolved decisions (founder — present before or at packet start; each has a default)

1. **ui-only edit under unchanged version → 409** (packet M9.4 stop condition). The merged plan
   ratifies 409; the Codex review names it an open product decision. DEFAULT: keep 409 (client
   bumps version). A future in-place ui-update path remains possible without breaking this.
2. **Dataset upload included in M9** (packet M9.6). Required for run endpoints to exist at all;
   supported by MVP_PLAN's "fixture/uploaded data" and the merged plan §7. DEFAULT: in.
3. **Replay-verify endpoint** (packet M9.9). Marked optional by the merged plan. DEFAULT: defer
   unless the founder opts in at M9.9 time.
4. **`/v1` path prefix** as the API version scheme. No repo prior art. DEFAULT: `/v1` prefix.
5. **Unbounded per-run compute accepted for v0** (single-user, size-capped documents/datasets;
   huge warm-up params fail benign). DEFAULT: accept + document; no node-count caps.

## Implementation slices (execution packets for Opus — strictly in order)

Every packet: TDD (tests written and watched failing first), `ruff check/format`, `mypy`, full
`pytest`, and BOTH gates green before "done". No packet touches engine numerics, reconciliation,
node semantics, persisted formats (except the named migration), or goldens. Branch:
`feat/m9-api-boundary`, one small commit per packet (or finer), per CLAUDE.md git discipline
(audit n2); merge to main via PR after founder/Codex review at milestone end.

### M9.0 — Provisioning
Files: `pyproject.toml` (add `fastapi` + `uvicorn` to `[project].dependencies`; `httpx` to dev),
`requirements.lock.txt` (regenerate on Python 3.14 per CLAUDE.md), `CLAUDE.md` (run command).
Tests: none new (gate green proves the lock installs; `python -c "import fastapi"`).
DoD: both gates green; lock diff reviewed (fastapi/uvicorn/httpx + transitive only).
Stop: any transitive dependency conflicting with pinned pydantic 2.13.4.

### M9.1 — Preflight extraction (pure domain refactor; no API)
Files: create `quantize/evaluator/preflight.py`; modify `quantize/evaluator/evaluate.py` (call
the shared function; own down-conversion at call site; keep NO_VISIBLE_SESSION inline); create
`tests/test_preflight_extraction.py`.
Tests-first: (1) parity — for every doc in the invalid-fixture corpus + reference fixtures, the
extracted function's down-converted output == `evaluate_strategy(...).diagnostics` byte-identical;
(2) loc-preservation — native output carries the `loc` tuples the evaluator path drops;
(3) all existing evaluator/validation tests green UNCHANGED (regression bar: test_evaluator.py,
test_semantic_validation.py, test_structural_validation.py, test_reference_strategies_eval.py).
DoD: 717 baseline tests green + new parity tests; no behavior change anywhere.
Stop: ANY existing test needs modification (that means the extraction changed behavior).

### M9.2 — API skeleton: settings, error mapping, app factory, meta endpoint
Files: create `quantize/api/{__init__.py, settings.py, errors.py, app.py}`,
`tests/api/{__init__.py, conftest.py, test_error_mapping.py, test_meta.py}`.
Content: `ApiSettings` + `get_settings`; `ApiError` DTO + exception handlers implementing the
per-(endpoint-class, code) taxonomy INCLUDING context scrubbing and the 400-parse override and
413 body cap; `create_app()` factory registering `/v1`; `GET /v1/meta`. conftest: module-scoped
`TestClient`, `get_settings` override to tmp_path DB (documents in its docstring that TestClient
is in-process — no network).
Tests-first (mechanism per audit M4 — /v1/meta is GET-only, so these CANNOT be e2e against
production routes yet): (a) the error-mapping functions are unit-tested DIRECTLY (construct each
`PersistenceError` code → assert the mapped status/body, incl. context scrubbing); (b) the
conftest's TEST APP registers a documented test-only POST echo route (present ONLY in the test
fixture app, never in `create_app()`) to exercise 400-parse, 413-cap, and the 503/500 handler
paths end-to-end through TestClient; (c) meta values. The same assertions re-run against REAL
routes in M9.4/M9.5. Body-cap mechanism (audit m7): reject on the `Content-Length` header
pre-parse AND guard the streamed body read (a missing/lying header must not bypass the cap) —
implement as a small middleware in `app.py`.
DoD: gates green; `create_app()` exposes no route beyond /v1/meta (the echo route is
test-fixture-only).

### M9.3 — API DTO modules + second codegen bundle
Files: create `quantize/api/dto/{__init__.py, common.py, validate.py, documents.py, datasets.py,
runs.py}` (fastapi-free; frozen; extra=forbid); modify `quantize/codegen/schema.py`
(`_API_ROOT_MODELS`, `build_api_bundle`, API_SCHEMA_PATH/TS_PATH/ID/TITLE) and
`quantize/codegen/pipeline.py` (iterate both artifact triples); commit generated
`schema/quantize-api.schema.json` + `ts/quantize-api.d.ts`; add two `.gitattributes` LF pins;
create `tests/api/test_api_contract.py`; extend `tests/test_codegen_determinism.py` and
`tests/test_codegen_gate.py` cases to the API artifacts.
FIRST STEP (audit m8): prototype `generate_typescript` on a root-less (defs-only, no top-level
oneOf) bundle before wiring — the IR bundle always had a oneOf root and there is no in-repo
precedent; if json2ts needs a root, emit a synthetic object root referencing every DTO and pin
that shape.
Tests-first: API schema is valid Draft 2020-12; representative payload per DTO validates against
the COMMITTED schema via jsonschema (independent of pydantic); byte-stability + LF-only; stale
API artifact flagged by `codegen check` with its filename; IR bundle byte-UNCHANGED (assert the
committed IR schema/TS are untouched by this packet).
DoD: `python -m quantize.codegen generate` produces both bundles deterministically; gates green.
ALL DTO field sets are pinned in §Contracts (incl. run requests and list rows — audit B1/m6), so
this packet freezes the full API bundle; M9.6/M9.7 may NOT add or reshape DTOs. If
implementation reveals a missing field, that is a STOP (return to this packet deliberately,
regenerate, and record the change) — never an ad-hoc edit inside a later packet (audit M5).
Stop: any change to the committed IR artifacts.

### M9.4 — Strategy + component endpoints
Files: create `quantize/api/routes/{__init__.py, strategies.py, components.py}`; wire in app.py;
create `tests/api/test_strategy_component_endpoints.py`.
Handlers: raw-bytes validation (`model_validate_json`) for POST bodies; pre-parse schema_version
gate; `with Database(...)` handler-owned; repositories as in Track-4 matrix.
Tests-first: save→201 + re-save identical→(200 or 201-idempotent — pick 200, assert body equal);
divergent bytes → 409; **ui-only edit under same version → 409** (founder decision #1's default;
test named so flipping the decision is one edit); load→verbatim stored document (byte-compare
via to_ir_json); list/versions; 404s; unsupported schema_version → 422; malformed → 400;
component SemVer path param round-trip.
DoD: gates green. Stop: founder decision #1 if they want non-409 semantics.

### M9.5 — Validate endpoint
Files: create `quantize/api/routes/validate.py`; wire; create `tests/api/test_validate_endpoint.py`.
Tests-first: staged 413/400/422/200 exactly per §Contracts; dual-shape diagnostics carry
(code, loc, subject) / (code, node_path, subject) with per-layer ordering; **3-way parity** over
the invalid corpus: endpoint codes == extracted-preflight codes == run-rejection codes (the
no-second-implementation proof); ok:true carries warmup_sessions (Strategy B fixture → 199);
depth-bomb body (deep nesting ~2000) → clean 400/413, never 500.
DoD: gates green.

### M9.6 — Dataset upload + store (founder decision #2 default: in)
Files: modify `quantize/persistence/migrations.py` (append DatabaseMigration version=2 — the
mechanics need no special-casing; `CURRENT_DATABASE_VERSION` auto-derives); create
`quantize/persistence/datasets.py` (`DatasetRepository`); create `quantize/api/routes/datasets.py`;
create `tests/api/test_dataset_upload.py` + repository tests in `tests/test_persistence_datasets.py`.
Tests-first: migration v2 applies fresh AND on an existing v1 DB (reopen path); upload → 201
with all three identities; identical re-upload → 200 same dataset_id; observation change /
availability change / calendar-session change each flip the right identity (reuse the
test_run_provenance sensitivity oracle); DOMAIN validation failures (non-positive price,
availability before session) → 422 with the constructor message; payload round-trip:
load(dataset_id) reconstructs a MarketDataSet whose fingerprints match the stored ones;
oversized upload → 413.
DoD: gates green; existing persistence tests untouched.
Stop: founder decision #2 (if upload is OUT, run endpoints must pin a server-side fixture path —
a different M9.7).

### M9.7 — Run endpoints + fetch results/traces/list
Files: create `quantize/api/routes/runs.py`; NO engine changes — implement the orchestration in
`quantize/api/service.py` (`execute_backtest_run(...)`/`execute_forward_run(...)`): load
strategy (`StrategyRepository.load`), load dataset (`DatasetRepository.load`), build
`PortfolioState.of(cash, positions)` (engine/state.py:48), mint `str(uuid.uuid4())`, run via
`run_backtest(...)` (engine/backtest.py:425) or the forward exhaust loop
(`replay = ForwardReplay(...)` engine/forward.py:77; `while not replay.exhausted:
replay.advance()`; `replay.result()`), compute `recorded_input_provenance(market_data)`, then
`RunRepository.save_run(document, result, input_provenance=..., mode=RUN_MODE_BACKTEST |
RUN_MODE_FORWARD)` (constants persistence/records.py:28-29), return run_id (audit m9 — all
entrypoints named; each is the unique implementation of its concern). Create
`tests/api/test_run_endpoint.py` + `tests/api/test_results_traces_endpoints.py`.
Tests-first: windowed Strategy A backtest (2025-07-31..08-29 — cheap, hand-checkable against
reference tests) → 201; fetch-results == `load_run` serialization byte-for-byte (reuses the
persisted_run_envelope golden shape) + `replay_verifiable: true`; fetch-traces seq order +
session_date filter; list_runs with strategy_id filter; forward run (same window, last_session
required) → record field-identical to backtest modulo run_id/mode (mirrors
test_forward_replay's normalization); missing last_session → 422; strategy/dataset 404s; a run
with `ok:false` (engine-harness failing dataset uploaded via M9.6) still persists and returns
201; client-supplied run_id field is rejected by extra=forbid (422) — never forwarded;
initial_positions accepted; non-finite/negative initial_cash → 422.
DoD: gates green; suite time increase within budget (module-scoped client; windowed runs only).
Stop: standing stop conditions (any golden movement, any engine-touching change).

### M9.8 — Hardening + closeout
Files: docs (CLAUDE.md run-command final wording; `docs/LEARNING_LOG.md` M9 entry per template);
sweep: assert every POST route uses raw-bytes validation + size cap (one parametrized test);
README note if applicable.
Tests-first: the sweep test; a final full-matrix error-mapping test run.
DoD: BOTH gates green; every checklist item in AGENTS.md review criteria passes on the diff;
self-review areas (below) executed.

### M9.9 — OPTIONAL: replay-verification endpoint (founder decision #3; default defer)
Only on explicit founder go. `POST /v1/runs/{run_id}/verify` {dataset_id, initial_cash,
initial_positions?} → `input_provenance_mismatches` pre-check + (on empty) engine re-run
comparison summary. Bounded, additive; separate tests.

## Test blueprint

Layout per Track 8: `tests/api/{conftest, test_meta, test_error_mapping, test_api_contract,
test_validate_endpoint, test_strategy_component_endpoints, test_dataset_upload,
test_run_endpoint, test_results_traces_endpoints}.py`, `tests/test_preflight_extraction.py`,
`tests/test_persistence_datasets.py`. Conventions: module-scoped TestClient; per-test tmp_path
DB via `get_settings` override; NO new golden files (fetch-results reuses the envelope golden
shape; validate pinned by focused code/loc/subject assertions — messages are non-contract);
short busy_timeout in lock tests; windowed runs only; every invariant in §Contracts has ≥1 named
test; estimated +60–90 tests, seconds-level runtime.

## Stop conditions

Founder decisions #1–#5 above at their named packets; any contradiction between this plan and
`docs/plans/2026-07-03-m9-api-plan.md` (the contract doc wins; report, don't improvise); any
need to modify an existing passing test in M9.1; any change to committed IR codegen artifacts;
any golden movement; anything on the standing list (ADRs, financial semantics, persisted IR,
port lattice, failure policy, backtest↔forward equality, no-lookahead). Plus CLAUDE.md's 10-step
working process and one-milestone discipline.

## Verification

Per packet AND at closeout: `./scripts/gate.ps1` and `bash scripts/gate.sh` (both must pass —
pytest, ruff check, format check, mypy, Node-24, `codegen check` (now two bundles), tsc).
Milestone evidence: 3-way validate parity output; fetch-results byte-equality vs load_run;
forward==backtest normalization test; dataset identity sensitivity battery; error-matrix table
test; depth-bomb 400-not-500 proof.

## Self-review areas (read-only passes on the finished diff before external review)

1. Boundary purity — zero numerics/portfolio logic in `quantize/api/`; no pandas/numpy; no
   Python objects in DTOs (AGENTS.md checklist). 2. Contract fidelity — endpoint table vs
implementation vs committed API schema. 3. Error hygiene — no context/path leakage; per-endpoint
matrix honored. 4. Threading — every handler owns its Database in its own body; nothing shared.
5. Test quality — expected values independently derived; parity tests genuinely 3-way.

## Closeout

LEARNING_LOG entry (concepts: thin-boundary translation, per-request resource ownership,
contract-first DTOs with codegen governance, staged validation semantics; reading path:
api/app.py → routes → preflight.py → dto/ → codegen/schema.py; exercise: add a `GET
/v1/strategies/{id}/versions/{version}/semantic-equality?other=` endpoint by hand). Final report:
files changed, invariants→tests map, deferred items (M9.9, CORS, OpenAPI gating), founder
inspection list (preflight.py diff, error mapping, dataset store, both new schema artifacts).
