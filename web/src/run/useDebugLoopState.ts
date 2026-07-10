// The debug-loop state for the SELECTED RUN (M13.7; extracted from App.tsx in M13.7.5).
//
// One hook owns the whole run/cursor/trace cluster the debug loop runs on:
//   - the run-record fetch (once per selected run, with cancellation),
//   - the session cursor over that record's SERVER session dates (cleared on run switch, defaulted
//     via `defaultCursor` when the record arrives, null without a run),
//   - the axis / evaluated-subset projections (thin memos over `run/projections`),
//   - the single tagged trace-tree fetch keyed on (run, cursor), gated through `selectTrace`,
//   - the Inspector's "At session" payload.
//
// These pieces are extracted TOGETHER because they form one safety cluster: each effect's
// correctness depends on the others' scheduling (see the inline notes on the stale-cursor
// run-switch window), and M13.8 builds directly on this state. Colocating them keeps the interplay
// reviewable in one file instead of interleaved through a ~750-line App.
//
// Boundary: run/cursor/trace state ONLY. App-level selection/focus (selectedNodeId, focusRequest,
// trace→canvas clicks) and dock-tab navigation stay in App — they are editor concerns, not run
// concerns. Every derived value here is a lookup/filter over served fields via `run/projections`
// (invariant 5); the cursor NEVER enters the document and never affects semanticKey.
import { useEffect, useMemo, useState } from 'react'
import type { RunRecordResponse, TraceTreeDto } from '@quantize/quantize-api'
import { errorMessage, getRun, getTraceTree } from '../api/client'
import type { AtSessionProps } from '../components/Inspector'
import { isCursorOnAxis, selectTrace } from '../trace/selectTrace'
import type { TaggedTrace } from '../trace/selectTrace'
import { defaultCursor, evaluatedSet, noteFor, sessionAxis } from './projections'

/** Everything the debug loop derives from the selected run — see the module header. */
export interface DebugLoopState {
  /** The fetched record for the selected run, or undefined (no run / loading / failed). */
  runRecord: RunRecordResponse | undefined
  /** True while the record fetch is in flight. */
  runRecordLoading: boolean
  /** A record-fetch error message, or undefined. */
  runRecordError: string | undefined
  /** The shared session cursor, or null without a run/axis. */
  sessionCursor: string | null
  /** Move the cursor (callers pass SERVER dates only — the cursor contract). */
  setSessionCursor: (date: string | null) => void
  /** The cursor axis: the run's server session dates, in order (from `sessionAxis`). */
  sessionDates: string[]
  /** The evaluated subset — marks warm-up / no-eval sessions (from `evaluatedSet`). */
  evaluatedSessions: Set<string>
  /** The served trees for the cursor session, gated to the current selection via `selectTrace`. */
  traceTrees: TraceTreeDto[] | undefined
  /** True while an on-axis selection's trace fetch has not landed. */
  traceLoading: boolean
  /** A trace-fetch error message, or undefined. */
  traceError: string | undefined
  /** The Inspector's "At session" payload; undefined keeps its value-tap slot inert. */
  atSession: AtSessionProps | undefined
}

export function useDebugLoopState(selectedRunId: string | undefined): DebugLoopState {
  // The session cursor is client state over the SELECTED RUN's server session dates (M13.7). It is
  // valid only while a run is selected, drawn exclusively from that run's own valuations, defaulted on
  // select to the run's last EVALUATED session (D-12 as amended, M13.7.5), cleared on run switch, and
  // absent (null) without a run. It NEVER enters the document and NEVER computes anything — it only
  // indexes served dates.
  const [sessionCursor, setSessionCursor] = useState<string | null>(null)

  // --- The lifted run record (fetched once per selected run) ------------------------------------

  const [runRecord, setRunRecord] = useState<RunRecordResponse | undefined>(undefined)
  const [runRecordLoading, setRunRecordLoading] = useState(false)
  const [runRecordError, setRunRecordError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (selectedRunId === undefined) {
      setRunRecord(undefined)
      setRunRecordError(undefined)
      setRunRecordLoading(false)
      setSessionCursor(null) // no run → no cursor axis
      return
    }
    let cancelled = false
    setRunRecord(undefined)
    setRunRecordError(undefined)
    setRunRecordLoading(true)
    // Clear on run switch — the new run's axis is not known until it loads. NOTE (M13.7 Task 2): the
    // trace-tree effect below DOES depend on `sessionCursor`. Because this `setSessionCursor(null)`
    // is a SCHEDULED update (not a same-pass mutation), the trace effect can still observe the previous
    // run's cursor for one pass after `selectedRunId` changes. Two guards make that harmless: (1) the
    // trace effect fetches only when the cursor belongs to the CURRENT run's axis (`sessionDates`, a
    // run_id-gated memo) — during the stale window that axis is the new run's/empty, so no wasted
    // `getTraceTree(newRunId, oldCursor)` is ever sent; (2) its `cancelled` cleanup guard prevents any
    // late-resolving stale tree from rendering. StrategyBar's readout is likewise masked by `hasRun`.
    setSessionCursor(null)
    getRun(selectedRunId)
      .then((res) => {
        if (!cancelled) {
          setRunRecord(res)
          // D-12 (as amended, M13.7.5): default the cursor to the run's last EVALUATED session — the
          // most recent decision is the most interesting — falling back to the last session for a run
          // with no evaluations. A pure served-date selection (`defaultCursor`), never a derivation.
          setSessionCursor(defaultCursor(res))
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setRunRecord(undefined)
          setRunRecordError(errorMessage(e))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunRecordLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedRunId])

  // The cursor axis (M13.7): the selected run's server session dates, in order. `sessionAxis` gates on
  // the record's OWN run_id matching the selection — during a run switch this hook briefly still holds
  // the previous run's record, and an unguarded derivation would offer the stale run's dates. A thin
  // memo over the shared projection (M13.7.5), so the axis has exactly one computation site.
  const sessionDates = useMemo(
    () => sessionAxis(runRecord, selectedRunId),
    [runRecord, selectedRunId],
  )
  // The evaluated subset — sessions the engine actually evaluated (vs. warm-up / skipped sessions),
  // used to MARK the cursor readout and pick the honest empty state. A pure projection of the record;
  // it computes nothing. `evaluatedSet` gates on the SAME run-identity check as `sessionAxis`
  // (`matchesRun`) so both projections of one record are defended alike — a consumer reading this
  // outside the bar's `hasRun` mask never sees the stale run's set.
  const evaluatedSessions = useMemo(
    () => evaluatedSet(runRecord, selectedRunId),
    [runRecord, selectedRunId],
  )

  // --- The lifted trace tree (M13.7): ONE fetch keyed on the run + the shared session cursor ------
  // Lifting the trace-tree fetch out of TraceView lets a single result feed both the Trace panel and
  // the always-mounted Inspector — the Dock mounts only one panel at a time, so a panel-local fetch
  // could not be shared. Mirrors the runRecord effect's shape (cancelled flag, reset-then-load,
  // then/catch/finally); re-keys whenever the run OR the cursor changes.
  // The fetched trace is TAGGED with the (run, session) it was fetched for; the effect only writes,
  // never clears. What the panels see is derived by `selectTrace` (below), gated to the current
  // selection — so the one-render window between a cursor/run change and this effect re-running never
  // surfaces the previous session's trees under the new cursor (P2).
  const [traceFetch, setTraceFetch] = useState<TaggedTrace | undefined>(undefined)
  useEffect(() => {
    // Gate on the cursor actually belonging to the CURRENT run's axis. On a run switch `setSessionCursor(null)`
    // is scheduled, not immediate, so this effect can run once with the previous run's cursor against the new
    // `selectedRunId`; `sessionDates` is the run_id-gated memo, so during that stale window it is the new
    // run's dates (or empty) and this guard is false — the wasted `getTraceTree(newRunId, oldCursor)` is never
    // SENT. The `cancelled` cleanup drops a superseded in-flight fetch (a late resolve would also be gated out
    // by its tag, but cancelling avoids the wasted state write).
    if (selectedRunId === undefined || sessionCursor === null || !sessionDates.includes(sessionCursor)) {
      return
    }
    let cancelled = false
    // Capture the key this fetch is FOR, so the result is tagged with it (not with whatever the cursor
    // happens to be when the promise resolves).
    const runId = selectedRunId
    const sessionDate = sessionCursor
    getTraceTree(runId, sessionDate)
      .then((res) => {
        if (!cancelled) setTraceFetch({ runId, sessionDate, trees: res.trees })
      })
      .catch((e: unknown) => {
        if (!cancelled) setTraceFetch({ runId, sessionDate, error: errorMessage(e) })
      })
    return () => {
      cancelled = true
    }
  }, [selectedRunId, sessionCursor, sessionDates])

  // Gate the tagged fetch to the CURRENT selection. A mismatch (no run, an off-axis cursor, or the
  // stale render before the effect re-fetches) never exposes the wrong session's trees: an on-axis
  // selection whose fetch has not landed reads as loading, everything else as empty. Both the Trace
  // panel and the Inspector "At session" section consume these gated values.
  const { trees: traceTrees, loading: traceLoading, error: traceError } = selectTrace(
    traceFetch,
    selectedRunId,
    sessionCursor,
    sessionDates,
  )

  // The live "At session" payload for the Inspector (M13.7): the trace tree at the shared cursor, plus
  // whether that session was evaluated and its no-eval note. Undefined until a run + cursor exist,
  // which keeps the Inspector's value-tap slot in its inert empty state. It shares the SAME lifted
  // trace fetch the Trace panel uses (keyed on run + cursor) — no second request. All fields are served
  // reads / filters (invariant 5); addressing stays (node_id, component_path) — the section resolves the
  // node, the cursor supplies session_date.
  const atSession = useMemo(() => {
    // Gate on the cursor being on the CURRENT run's axis — the SAME shared predicate `selectTrace`
    // uses for the trace panel. Without this, the one-render run-switch window (cursor still the
    // previous run's date, `sessionDates` already the new run's axis or empty) would build an
    // atSession with an off-axis cursor and `evaluated: false`, flashing "No evaluation this session"
    // in the Inspector instead of the inert empty slot. Off-axis → undefined keeps the slot inert.
    if (!isCursorOnAxis(selectedRunId, sessionCursor, sessionDates)) return undefined
    return {
      cursor: sessionCursor,
      trees: traceTrees,
      loading: traceLoading,
      error: traceError,
      evaluated: evaluatedSessions.has(sessionCursor),
      // `noteFor` gates on the record's OWN run_id matching the selection (as `sessionAxis` /
      // `evaluatedSet` do): during a run switch this hook briefly still holds the previous run's
      // record, and an ungated lookup would surface the stale run's note for this session.
      note: noteFor(runRecord, selectedRunId, sessionCursor),
    }
  }, [selectedRunId, sessionCursor, sessionDates, traceTrees, traceLoading, traceError, evaluatedSessions, runRecord])

  return {
    runRecord,
    runRecordLoading,
    runRecordError,
    sessionCursor,
    setSessionCursor,
    sessionDates,
    evaluatedSessions,
    traceTrees,
    traceLoading,
    traceError,
    atSession,
  }
}
