// Gating for the App-owned trace-tree fetch (M13.7, P2 fix).
//
// The trace fetch runs in an effect that clears/refetches only AFTER paint, so a render can occur
// with a new (run, cursor) selection while the fetched result still belongs to the PREVIOUS session.
// Exposing that raw result would briefly show the old session's node/engine trace under the new
// cursor date. To make what the panels see a pure function of the current selection, the fetch is
// TAGGED with the (runId, sessionDate) it was fetched for, and surfaced only when that tag matches
// the current selection. Any mismatch — including the one-render stale window — reads as "loading"
// for an on-axis selection, and as nothing at all otherwise (no run, or a cursor off the run's axis
// during a run switch). This is pure so it is directly unit-testable, independent of effect timing.
import type { TraceTreeDto } from '@quantize/quantize-api'

/** A trace-tree fetch result, TAGGED with the (run, session) it was fetched for. */
export interface TaggedTrace {
  runId: string
  sessionDate: string
  /** Present on a successful fetch (may be an empty array — an evaluated-but-traceless session). */
  trees?: TraceTreeDto[]
  /** Present when the fetch failed. */
  error?: string
}

/** The trace view state exposed to the consumers, already gated to the current selection. */
export interface TraceSelection {
  trees: TraceTreeDto[] | undefined
  loading: boolean
  error: string | undefined
}

/**
 * Gate a tagged trace fetch to the current selection.
 *
 * `sessionDates` is the run_id-gated axis of the selected run; a cursor not on it (the transient
 * run-switch window) is not "active", so it never shows a spurious loading state. A fetch is only
 * surfaced when its tag matches the current `runId` + `sessionCursor`; otherwise an active selection
 * reads as loading (its fetch is in flight or about to be issued) and an inactive one as empty.
 */
export function selectTrace(
  fetch: TaggedTrace | undefined,
  runId: string | undefined,
  sessionCursor: string | null,
  sessionDates: readonly string[],
): TraceSelection {
  const active = runId !== undefined && sessionCursor !== null && sessionDates.includes(sessionCursor)
  const matches = fetch !== undefined && fetch.runId === runId && fetch.sessionDate === sessionCursor
  if (matches) {
    return { trees: fetch.trees, loading: false, error: fetch.error }
  }
  return { trees: undefined, loading: active, error: undefined }
}
