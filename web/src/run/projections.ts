// Pure projections over a served run record (M13.7.5). The debug loop reads several views of ONE
// fetched `RunRecordResponse` — the session axis, the evaluated subset, a session's note — and every
// one of them must be gated on the record's OWN run_id matching the current selection: during a run
// switch the App briefly still holds the PREVIOUS run's record (its reset effect runs only after
// paint), and an unguarded read would surface the stale run's data under the new run id. Before this
// module the gate predicate was hand-copied at ~7 call sites (App / TraceView / ResultsView) — a
// drift hazard. `matchesRun` is now THE single run-identity gate, and every projection routes
// through it.
//
// Everything here is a lookup/filter over served fields — no date arithmetic, no derivation
// (invariant 5). No React: these are plain functions, unit-tested directly.
import type { PersistedNote, RunRecordResponse } from '@quantize/quantize-api'

/**
 * True when the fetched record is the SELECTED run's — the single run-identity gate. Deliberately a
 * plain `boolean`, NOT a `record is RunRecordResponse` type guard: the false branch does NOT imply the
 * record is absent. For a DEFINED-but-stale record (mismatched run_id) it returns false while `record`
 * still holds the previous run's live data — a predicate would (unsoundly) narrow that record to
 * `undefined` in the else branch, a compiler-blessed trap for future consumers. Callers that also need
 * the gated record should use `gatedRecord`.
 */
export function matchesRun(
  record: RunRecordResponse | undefined,
  runId: string | undefined,
): boolean {
  return record !== undefined && runId !== undefined && record.record.run_id === runId
}

/**
 * The record when it is the SELECTED run's, else undefined — the SOUND-NARROWING companion of
 * `matchesRun`. Where `matchesRun` is deliberately a plain boolean (its false branch does NOT imply
 * the record is absent — a stale mismatched record is still defined), this returns the record ONLY
 * when it matches, so a caller that needs the gated VALUE narrows it soundly (a stale record →
 * undefined) instead of re-deriving the gate. Every record-shaped projection here routes through it,
 * as does the hook's exposed record (`useDebugLoopState`, so consumers can never leak the gate).
 */
export function gatedRecord(
  record: RunRecordResponse | undefined,
  runId: string | undefined,
): RunRecordResponse | undefined {
  return matchesRun(record, runId) ? record : undefined
}

/** The run's session axis (ALL valuation dates, in served order); [] when the record doesn't match. */
export function sessionAxis(
  record: RunRecordResponse | undefined,
  runId: string | undefined,
): string[] {
  const gated = gatedRecord(record, runId)
  if (gated === undefined) {
    return []
  }
  return gated.record.valuations.map(([date]) => date)
}

/** The evaluated subset (evaluations[].session_date); empty when the record doesn't match. */
export function evaluatedSet(
  record: RunRecordResponse | undefined,
  runId: string | undefined,
): Set<string> {
  const gated = gatedRecord(record, runId)
  if (gated === undefined) {
    return new Set<string>()
  }
  return new Set(gated.record.evaluations.map((e) => e.session_date))
}

/** The served note for one session, or undefined; gated on the same run identity. */
export function noteFor(
  record: RunRecordResponse | undefined,
  runId: string | undefined,
  sessionDate: string | null,
): PersistedNote | undefined {
  const gated = gatedRecord(record, runId)
  if (gated === undefined || sessionDate === null) {
    return undefined
  }
  return gated.record.notes.find((n) => n.session_date === sessionDate)
}

/**
 * The DEFAULT cursor for a freshly selected run (D-12 as amended, M13.7.5): the LAST EVALUATED
 * session — the most recent decision is the most interesting one to land on. The original D-12
 * default (the last session of the axis) systematically stranded first-time users on a
 * NO-EVALUATION session for monthly strategies over month-end windows. The last session remains
 * the fallback for a run with no evaluations; an empty record has no cursor (null). Server dates
 * only — this SELECTS a served date, it never computes one.
 *
 * Precondition: the cursor axis is the VALUATIONS, so the chosen default must be ON that axis — an
 * off-axis cursor strands the whole loop (the trace fetch gate never fires; both StrategyBar steppers
 * disable at indexOf === -1). The server maintains evaluations ⊆ valuations, so the last evaluation is
 * normally on-axis; the explicit membership check is defensive hardening of that cross-array
 * precondition, falling back to the last valuation if it is ever violated.
 */
export function defaultCursor(record: RunRecordResponse): string | null {
  const vals = record.record.valuations
  const lastValuation = vals.length > 0 ? vals[vals.length - 1][0] : null
  const evals = record.record.evaluations
  if (evals.length > 0) {
    const lastEvaluated = evals[evals.length - 1].session_date
    if (vals.some(([date]) => date === lastEvaluated)) {
      return lastEvaluated
    }
  }
  return lastValuation
}
