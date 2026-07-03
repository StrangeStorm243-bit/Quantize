# Pre-M9 Remediation Final Independent Review

Review date: 2026-07-03

Scope reviewed:
- `docs/plans/2026-07-03-pre-m9-remediation-plan.md`
- `docs/plans/2026-07-03-m9-api-plan.md`
- `docs/STRATEGY_LANGUAGE.md`
- `quantize/engine/backtest.py`
- `quantize/evaluator/evaluate.py`
- `quantize/market/data.py`
- `quantize/nodes/transform.py`
- `quantize/persistence/database.py`
- `quantize/persistence/provenance.py`
- `quantize/persistence/records.py`
- `quantize/persistence/runs.py`
- `quantize/schema/serialization.py`
- `tests/test_evaluation_memo.py`
- `tests/test_market_cursor.py`
- `tests/test_run_provenance.py`
- targeted persistence, registry, serialization, forward replay, and golden tests

Verdict: approved for pre-M9 acceptance after re-review. The prior provenance finding is closed, and
no new blocking findings were found in this pass.

Codex did not edit production code, commit, push, or begin M9 during this review.

## Findings

No open findings.

The prior finding was rechecked and is closed:

### CLOSED - New run saves can still persist unknown or invalid input provenance

`RunRepository.save_run()` requires an `input_provenance` argument, but it accepts any
`RunInputProvenance` object and persists it into a new format-2 run. That includes
`unknown_input_provenance()` and also `status="recorded"` values whose hashes are not SHA-256
hex strings. This was the prior failing behavior.

Concrete repros run during review:

```text
repo.save_run(document, result, input_provenance=unknown_input_provenance())
loaded = repo.load_run(run_id)
loaded.input_provenance.status == "unknown"
loaded.input_provenance.dataset_hash is None
loaded.input_provenance.calendar_hash is None

RunInputProvenance(status="recorded", dataset_hash="x", calendar_hash="y")
# accepted
```

This now fails closed:
- Unknown provenance at `save_run()` raises `PersistenceError(code="invalid_artifact")` before any
  strategy/run row is written.
- Malformed recorded hashes are rejected by `RunInputProvenance` validation.
- The format-1 -> 2 load migration remains the only path that produces durable unknown provenance.

Relevant code:
- `quantize/persistence/runs.py:109` rejects non-recorded provenance on new saves.
- `quantize/persistence/provenance.py:101` validates recorded hashes as 64-character lowercase
  SHA-256 hex strings.
- `quantize/persistence/migrations.py:172` is the intended legacy-only source of `unknown`.
- `tests/test_run_provenance.py:156` covers malformed hash rejection.
- `tests/test_run_provenance.py:243` covers unknown-at-save rejection with no rows written.

## What Looks Sound

- Warm-up is now specified as prior visible sessions, with MA and latest declarations aligned to the
  engine gate and Strategy B's golden movement explained by the one-week-earlier first evaluation.
- `EvaluationMemo` is run-scoped, monotonic, and covered by memo-on/off bit-exact record and trace
  comparisons, including delayed-availability reattempt behavior.
- `MarketDataCursor` answers the engine's point reads through tested `as_of` equivalence, including
  delayed/out-of-order availability and backward fallback.
- SQLite lock, corruption, integrity, and transaction recovery paths are now structured at the
  database wrapper boundary; repositories no longer import `sqlite3`.
- Format-1 run records load through a 1->2 migration that records explicit unknown provenance.
- Negative-zero canonicalization is at the serialization boundary and does not mutate domain objects.
- SemVer version ordering remains display-only; exact resolution is unchanged.
- `gate.sh` is a bounded POSIX sibling with the same stage order as `gate.ps1`.

## Verification Run

Commands run:

```text
python -m pytest tests\test_engine_backtest.py tests\test_evaluation_memo.py tests\test_market_cursor.py tests\test_run_provenance.py tests\test_persistence_migrations.py tests\test_serialization.py tests\test_registry.py tests\test_codegen_contract.py -q
python -m pytest tests\test_run_provenance.py tests\test_persistence_runs.py tests\test_forward_replay.py -q
python -m pytest tests\test_forward_replay.py -q
.\scripts\gate.ps1
bash scripts/gate.sh
```

Results:

```text
targeted high-risk pytest set: passed
provenance/persistence/forward regression set: passed
tests/test_forward_replay.py: 20 passed
direct repros:
  unknown-at-save -> invalid_artifact, list_runs() == ()
  malformed recorded hashes -> ValidationError
PowerShell gate:
  pytest: 717 passed in 15.97s
  ruff check: All checks passed!
  ruff format --check: 141 files already formatted
  mypy: Success: no issues found in 141 source files
  node24 activation: active (v24.18.0)
  codegen check: Generated artifacts are up to date.
  tsc typecheck: passed
  gate: ALL STAGES PASSED
POSIX gate: not run in this shell; `bash` is not installed/available.
```

## Residual Risk

I did not re-run the reported benchmark harnesses or independently reproduce the large-run timing
ratios. The exactness tests and the full functional gate were run locally; performance numbers remain
reviewed from the sprint report rather than re-measured here.

## Final Decision

Approve the pre-M9 remediation sprint. The prior provenance save-boundary gap is closed, regression
coverage is present, and the PowerShell gate is green. The only remaining non-technical item is the
named founder product decision about ui-only edits under an unchanged strategy version.
