# M8 Final Independent Review - Deterministic Forward Replay

Review date: 2026-07-02

Scope reviewed:
- `docs/MVP_PLAN.md`
- `docs/ARCHITECTURE.md`
- `docs/STRATEGY_LANGUAGE.md`
- `docs/plans/2026-07-02-m8-forward-replay-plan.md`
- `quantize/engine/backtest.py`
- `quantize/engine/forward.py`
- `quantize/persistence/records.py`
- `quantize/persistence/runs.py`
- `tests/test_forward_replay.py`
- `tests/stateful_fixture.py`

Verdict: approved for M8 acceptance after re-review. The prior HIGH finding is closed, and no new
blocking findings were found in this pass.

Codex did not edit production code, commit, push, or begin M9 during this review.

## Findings

No open findings.

The prior finding was rechecked and is closed:

### CLOSED - Non-exhausted forward results can be saved as successful completed runs

`ForwardReplay.result()` is intentionally callable mid-replay and returns `BacktestResult(ok=True)`
whenever the replay has not failed. `SessionEngine.finish()` then reports `first_session` and
`last_session` from the configured full run window, not from the advanced prefix. `RunRepository`
previously accepted that `BacktestResult` unchanged and persisted it as a durable run record.

Concrete repro run during review:

```text
advance strategy_a 10 sessions of the full 2025-01-02..2026-06-30 fixture window
partial = replay.result()
save_run(document, partial, mode="forward")
load_run(run_id)

loaded.ok == True
loaded.first_session == 2025-01-02
loaded.last_session == 2026-06-30
len(loaded.valuations) == 10
loaded.valuations[-1][0] == 2025-01-15
```

This now fails closed at the persistence boundary. `RunRepository.save_run()` rejects any `ok=True`
record whose final valuation date does not match its declared `last_session`, using only the record's
own facts. The same repro now raises `PersistenceError(code="invalid_artifact")`, and no run rows are
stored. Failed runs (`ok=False`) and successful empty-window runs still persist.

Relevant code:
- `quantize/engine/forward.py:147` documents a non-exhausted `result()` as a peek.
- `quantize/engine/backtest.py:200` assembles full configured window bounds in `finish()`.
- `quantize/persistence/runs.py:113` rejects successful records whose facts stop short of the
  declared window.
- `tests/test_forward_replay.py:335` covers the original repro for both default and forward modes.
- `tests/test_forward_replay.py:361` covers the honest partials that must still persist.

## What Looks Sound

- `run_backtest` and `ForwardReplay` share `SessionEngine.step`; I found no duplicated evaluation,
  reconciliation, fill, trace, or node logic.
- The bounded replay contract is reflected in the runtime `last_session` guard.
- Exhausted forward replay equals the backtest field-for-field for Strategy A and B, including
  traces.
- The restart tests cover pending overnight orders, final checkpoints, failed checkpoints, and
  deterministic repeated resumes.
- The test-only stateful accumulator is confined to `tests/` and exercises timing equivalence
  without adding product stateful-node plumbing.
- The persistence mode addition is additive and does not require a migration.

## Verification Run

Commands run:

```text
python -m pytest tests\test_forward_replay.py -q
.\scripts\gate.ps1
```

Result:

```text
tests/test_forward_replay.py: 20 passed
direct repro: invalid_artifact, list_runs() == ()
pytest: 677 passed in 30.70s
ruff check: All checks passed!
ruff format --check: 137 files already formatted
mypy: Success: no issues found in 137 source files
node24 activation: active (v24.18.0)
codegen check: Generated artifacts are up to date.
tsc typecheck: passed
gate: ALL STAGES PASSED
```

## Residual Risk

I did not perform an exhaustive line-by-line equivalence proof of the `run_backtest` extraction
against `main`; I relied on the diff shape plus the full existing gate. Durable checkpoint storage
and open-ended forward tails remain intentionally deferred.

## Final Decision

Approve M8. The partial-forward-result persistence path now fails closed, regression coverage is
present, and the full gate is green.
