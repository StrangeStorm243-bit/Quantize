# M9 Independent Codex Review - API Boundary + Versioning

Review date: 2026-07-03

Branch reviewed: `feat/m9-api-boundary` at `e50f79f`

Note: the GitHub connector returned 404 for PR #12, so this review used the local branch after
`git fetch origin main feat/m9-api-boundary`. The local branch matches `origin/feat/m9-api-boundary`.

Scope reviewed:
- `quantize/api/app.py`
- `quantize/api/errors.py`
- `quantize/api/parsing.py`
- `quantize/api/service.py`
- `quantize/api/dto/*`
- `quantize/api/routes/*`
- `quantize/evaluator/preflight.py`
- `quantize/evaluator/evaluate.py`
- `quantize/persistence/datasets.py`
- `quantize/persistence/migrations.py`
- `quantize/codegen/schema.py`
- `quantize/codegen/pipeline.py`
- `schema/quantize-api.schema.json`
- `ts/quantize-api.d.ts`
- `tests/api/*`
- `tests/test_persistence_datasets.py`
- `tests/test_preflight_extraction.py`
- `tests/test_codegen_determinism.py`
- `tests/test_codegen_gate.py`

Verdict: changes requested. The full PowerShell gate is green, but I found one blocker in the new
dataset persistence surface and one high API-contract validation gap.

Codex did not edit production code, commit, push, or merge during this review. This review document
is the only file added by Codex.

## Findings

### BLOCKER - Dataset loads do not verify the content-addressed identity

`DatasetRepository.save()` computes `dataset_id` from the canonical payload bytes, but the load path
never proves that the bytes still match the key. `load()` calls `_payload()` and reconstructs a
`MarketDataSet`; `_decode()` only checks JSON portability and object shape. `describe()` has the
same trust gap: it reconstructs the payload only for counts, then returns the row's stored
fingerprints without comparing them to the actual payload.

Relevant code:
- `quantize/persistence/datasets.py:134` computes the canonical payload bytes.
- `quantize/persistence/datasets.py:135` computes the content-addressed `dataset_id`.
- `quantize/persistence/datasets.py:158` loads by id without re-hashing the stored payload.
- `quantize/persistence/datasets.py:174` returns row fingerprints after decoding the payload, but
  does not compare them to recomputed fingerprints.
- `quantize/persistence/datasets.py:194` decodes JSON but does not validate identity.

Concrete repro run during review:

```text
save dataset A with close_price = 10.5 -> dataset_id = X
UPDATE datasets SET payload = canonical_payload(dataset B close_price = 99.0) WHERE dataset_id = X
repo.load(X).observations["AAA"][0].close_price == 99.0
repo.describe(X) still returns the original row fingerprints
```

Expected behavior: a valid JSON/domain-valid payload tamper under an existing `dataset_id` should
raise `PersistenceError(code="corrupt_artifact")`, not load as a different dataset under the old
content address.

Impact: the M9.6 content-addressed store can silently return different market data for a stable
dataset id. The run endpoints depend on `DatasetRepository.load()`, so a corrupted valid row can be
executed under the requested id instead of failing at the persistence boundary. The metadata route
can also report stale fingerprints for a changed payload.

Suggested fix: on load/describe, verify `content_hash(payload_text.encode("utf-8")) == dataset_id`.
After reconstructing the `MarketDataSet`, recompute `dataset_fingerprint()` and
`calendar_fingerprint()` and compare them to the row columns. Any mismatch should be
`corrupt_artifact`. Add regression tests for valid-payload tamper, stale row fingerprints, and a
forged row where payload and fingerprint columns agree with each other but not with `dataset_id`.

### HIGH - API DTO validation accepts values rejected by the governed API schema

The API schema and generated TS advertise strict JSON shapes, but the server-side request DTOs use
pydantic's default coercive parsing. `_Dto` only sets `frozen=True` and `extra="forbid"`, while
request fields use plain `float`, `int`, `date`, and `datetime`. As a result, booleans and numeric
strings are accepted for numeric fields, and numeric epoch values are accepted for date/datetime
fields, even though `schema/quantize-api.schema.json` requires JSON numbers and date strings.

Relevant code:
- `quantize/api/dto/common.py:16` does not enable strict DTO parsing or finite-number rejection.
- `quantize/api/dto/datasets.py:33` through `quantize/api/dto/datasets.py:37` use plain
  `date`, `float`, and `datetime`.
- `quantize/api/dto/runs.py:26` through `quantize/api/dto/runs.py:31` use plain `int`, `float`,
  and `date`.
- `schema/quantize-api.schema.json:40` declares `initial_cash` as `type: "number"`.
- `schema/quantize-api.schema.json:335` and `schema/quantize-api.schema.json:342` declare dataset
  prices as `type: "number"`.
- `schema/quantize-api.schema.json:345` declares `session_date` as a date string.

Concrete repros run during review:

```text
POST /v1/datasets with "open_price": "10.0" and "close_price": true
-> 201 Created

POST /v1/datasets with session_date/open_at/close_at/open_available_at/close_available_at as
numeric epoch values
-> 201 Created

POST /v1/runs/backtest with "initial_cash": "1000.0" and
"initial_positions": {"AAA": true}
-> 404 artifact_not_found for the unknown strategy, proving the body passed DTO validation
   instead of returning 422 invalid_body
```

Expected behavior: these should fail request DTO validation with the route's 422 `invalid_body`
response because they are not valid instances of the published API schema.

Impact: the server accepts off-contract inputs that generated clients and independent JSON Schema
validators reject. In the dataset route this can persist coerced values, for example `true` becoming
`1.0` or `0` becoming `1970-01-01T00:00:00Z`.

Suggested fix: make API request DTO validation strict and finite, for example via `_Dto`
`ConfigDict(strict=True, allow_inf_nan=False)` if it preserves JSON string parsing for
date/datetime fields, or via explicit strict/finite field aliases. Add endpoint regression tests for
numeric strings, booleans in numeric fields, non-finite JSON numbers, and numeric date/datetime
values.

## What Looks Sound

- The preflight extraction keeps execution and `/v1/strategies/validate` on one shared document
  check path. The parity tests cover structural, semantic, resolution, and terminal cases.
- The API shell consistently routes production POST bodies through raw bytes and pydantic-core's
  JSON path; I did not find production `json.loads` request parsing.
- Error responses use the `ApiError` envelope and scrub `PersistenceError.context`.
- Strategy/component save/load endpoints preserve immutable behavior and canonical document bytes.
- Run submissions are synchronous, server-mint run ids, and compute recorded input provenance at the
  save boundary.
- The API schema/TS bundle is governed by the same codegen gate as the IR bundle, and the IR bundle
  remains unchanged.
- M9.9 replay verify is cleanly absent from the endpoint inventory, matching the deferral decision.

## Verification Run

Commands run:

```text
git fetch origin main feat/m9-api-boundary
python -m pytest tests\api tests\test_persistence_datasets.py tests\test_run_provenance.py tests\test_preflight_extraction.py -q
python -m pytest tests\test_codegen_determinism.py tests\test_codegen_gate.py tests\api\test_api_contract.py -q
.\scripts\gate.ps1
git diff --check main...HEAD
```

Results:

```text
focused API/persistence/preflight set: passed
focused codegen/API contract set: passed
PowerShell gate:
  pytest: 839 passed, 1 warning in 21.61s
  ruff check: All checks passed!
  ruff format --check: 174 files already formatted
  mypy: Success: no issues found in 174 source files
  node24 activation: active (v24.18.0)
  codegen check: Generated artifacts are up to date.
  tsc typecheck: passed
  gate: ALL STAGES PASSED
git diff --check: clean
```

POSIX gate not run locally: `bash` is not installed/available in this environment.

## Final Decision

Do not merge M9 yet. Fix the dataset identity verification gap first, and tighten API DTO parsing so
the server rejects request bodies outside the committed API schema.
