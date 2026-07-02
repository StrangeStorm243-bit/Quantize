# M7 Final Independent Review - Persistence, Migrations, Durable Run/Trace Storage

Review date: 2026-07-02

Scope reviewed:
- `docs/PRODUCT.md`
- `docs/STRATEGY_LANGUAGE.md`
- `docs/ARCHITECTURE.md`
- `docs/MVP_PLAN.md`
- `docs/ADRS/0001-technology-stack.md` through `docs/ADRS/0005-order-reconciliation.md`
- `docs/plans/2026-07-02-m7-persistence-plan.md`
- `quantize/persistence/`
- `quantize/schema/serialization.py`
- `tests/test_persistence_documents.py`
- `tests/test_persistence_migrations.py`
- `tests/test_persistence_runs.py`
- `tests/test_serialization.py`

Verdict: approved for M7 acceptance. No remaining blocking findings found in this pass.

Codex did not edit production code, commit, push, or begin M8 during this review.

## Findings

No findings.

The two round-3 findings were rechecked:
- `load_trace()` now verifies the stored trace stream against `runs.trace_content_hash` and
  `runs.trace_count` before returning events, and does that before applying `session_date`
  filtering.
- Save-time serialization failures now surface as `PersistenceError(code="invalid_artifact")` via
  `artifact_bytes(...)` for strategy documents, component definitions, run records, and trace
  events.

Ad hoc repros from the previous review now fail closed:
- Deleting the final trace row raises `corrupt_artifact` with a count mismatch.
- Valid-JSON event-byte tampering raises `corrupt_artifact` via the stream hash check.
- Mutated strategy/component artifacts containing `NaN` raise `invalid_artifact`.
- A `TraceEvent` constructed with a `NaN` payload raises `invalid_artifact` on `save_run()` and
  persists no run rows.

## What Looks Sound

- Persistence remains contained in `quantize/persistence/`.
- SQLite is behind a thin repository layer with explicit `BEGIN IMMEDIATE` transactions.
- Strategy and component documents are stored as canonical validated IR JSON, with `ui.*` preserved.
- Run records persist engine facts rather than recomputing them.
- Trace streams are stored in seq order and now have load-time whole-stream integrity checks.
- Unsupported IR schema versions fail loudly on save/load.
- Row/payload version divergence is treated as corruption.
- Non-standard `NaN`/`Infinity` JSON tokens are rejected on load.
- Save-time non-portable artifacts use stable persistence errors.
- The persisted run-record envelope golden remains byte-stable; trace identity is row metadata.

## Verification Run

Command run:

```text
.\scripts\gate.ps1
```

Result:

```text
pytest: 657 passed in 16.91s
ruff check: All checks passed!
ruff format --check: 134 files already formatted
mypy: Success: no issues found in 134 source files
node24 activation: active (v24.18.0)
codegen check: Generated artifacts are up to date.
tsc typecheck: passed
gate: ALL STAGES PASSED
```

Additional targeted probes were run for the prior trace-integrity and save-time invalid-artifact
findings.

## Residual Risk

I did not perform adversarial concurrency testing beyond the repository's existing conflict-path
coverage. That is acceptable for the single-user local SQLite M7 scope; production DB operations and
multi-user behavior remain explicitly deferred.

## Final Decision

Approve M7. The prior Codex findings are closed, regression coverage is present, and the full gate is
green.
