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

/** True when the fetched record is the SELECTED run's — the single run-identity gate. */
export function matchesRun(
  record: RunRecordResponse | undefined,
  runId: string | undefined,
): record is RunRecordResponse {
  return record !== undefined && runId !== undefined && record.record.run_id === runId
}

/** The run's session axis (ALL valuation dates, in served order); [] when the record doesn't match. */
export function sessionAxis(
  record: RunRecordResponse | undefined,
  runId: string | undefined,
): string[] {
  if (!matchesRun(record, runId)) {
    return []
  }
  return record.record.valuations.map(([date]) => date)
}

/** The evaluated subset (evaluations[].session_date); empty when the record doesn't match. */
export function evaluatedSet(
  record: RunRecordResponse | undefined,
  runId: string | undefined,
): Set<string> {
  if (!matchesRun(record, runId)) {
    return new Set<string>()
  }
  return new Set(record.record.evaluations.map((e) => e.session_date))
}

/** The served note for one session, or undefined; gated on the same run identity. */
export function noteFor(
  record: RunRecordResponse | undefined,
  runId: string | undefined,
  sessionDate: string | null,
): PersistedNote | undefined {
  if (!matchesRun(record, runId) || sessionDate === null) {
    return undefined
  }
  return record.record.notes.find((n) => n.session_date === sessionDate)
}

/**
 * The DEFAULT cursor for a freshly selected run (D-12 as amended, M13.7.5): the LAST EVALUATED
 * session — the most recent decision is the most interesting one to land on. The original D-12
 * default (the last session of the axis) systematically stranded first-time users on a
 * NO-EVALUATION session for monthly strategies over month-end windows. The last session remains
 * the fallback for a run with no evaluations; an empty record has no cursor (null). Server dates
 * only — this SELECTS a served date, it never computes one.
 */
export function defaultCursor(record: RunRecordResponse): string | null {
  const evals = record.record.evaluations
  if (evals.length > 0) {
    return evals[evals.length - 1].session_date
  }
  const vals = record.record.valuations
  return vals.length > 0 ? vals[vals.length - 1][0] : null
}
