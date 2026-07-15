// The debug-loop state for the SELECTED RUN (M13.7; extracted from App.tsx in M13.7.5).
//
// One hook owns the whole run/cursor/trace cluster the debug loop runs on:
//   - the run-record fetch (once per selected run, with cancellation),
//   - the session cursor over that record's SERVER session dates (cleared on run switch, defaulted
//     via `defaultCursor` when the record arrives, null without a run),
//   - the axis / evaluated-subset projections (thin memos over `run/projections`),
//   - the single tagged trace-tree fetch keyed on (run, cursor), gated through `selectTrace`,
//   - the run's producing-strategy-version cadence fetch (tagged by run, gated to the selection),
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
import type { PersistedNote, RunRecordResponse, TraceTreeDto } from '@quantize/quantize-api'
import { errorMessage, getRun, getTraceTree, loadStrategyVersion } from '../api/client'
import { isCursorOnAxis, selectTrace } from '../trace/selectTrace'
import type { TaggedTrace } from '../trace/selectTrace'
import { defaultCursor, evaluatedSet, gatedRecord, noteFor, sessionAxis } from './projections'

/**
 * The Inspector's "At session" payload (M13.7). The RUN layer owns this shape because the run layer
 * PRODUCES it; the Inspector re-aliases it for its prop (it must not own a type the run layer builds).
 * Undefined until a run + on-axis cursor exist — the Inspector's value-tap slot stays inert then.
 */
export interface AtSessionState {
  /** The SELECTED run — the value-tap request address needs it; gated like every other field here. */
  runId: string
  cursor: string
  trees: TraceTreeDto[] | undefined
  loading: boolean
  error: string | undefined
  /** Whether the cursor session has an evaluation; false → honest no-eval state. */
  evaluated: boolean
  /** The run record note for this session, when one exists (the served no-eval reason). */
  note: PersistedNote | undefined
  /** The RUN's schedule kind (the producing strategy version's cadence, run-sourced — NOT the live
   *  editor doc), or undefined when unknown. Names the cadence in the Inspector's no-eval line. */
  scheduleKind: string | undefined
}

/** Everything the debug loop derives from the selected run — see the module header. */
export interface DebugLoopState {
  /** The fetched record, GATED to the selection (via `gatedRecord`): the SELECTED run's record or
   *  undefined (no run / loading / stale-mismatch / failed). Consumers never see another run's numbers —
   *  the run-identity gate lives HERE, not re-derived at each panel. */
  runRecord: RunRecordResponse | undefined
  /** True while the record fetch is in flight OR a stale mismatched record is still held (the reset
   *  effect runs only after paint). Folding the mismatch in means a consumer sees a MATCHING record or
   *  loading — never a mismatch — so it can pair `runRecord` with the selection without re-gating. */
  runRecordLoading: boolean
  /** A record-fetch error message, GATED to the selection: the error carries the runId it was fetched
   *  for, so a failed fetch for run A never surfaces under run B during the one-render run-switch window
   *  (the record fold can't cover this — a failed fetch has no record). undefined when the current run's
   *  fetch has not failed. */
  runRecordError: string | undefined
  /** The served note for the cursor session (matchesRun-gated via `noteFor`), or undefined. The SINGLE
   *  derivation the Trace panel (App threads it) and the `atSession` payload share — never re-derived. */
  note: PersistedNote | undefined
  /** The shared session cursor, or null without a run/axis. NOTE: during the one-render run-switch
   *  window it can be non-null AND off the CURRENT run's axis (the previous run's date, before the reset
   *  effect nulls it). A consumer pairing it with its own per-session lookup MUST first gate it through
   *  `isCursorOnAxis(runId, sessionCursor, sessionDates)` — the way `atSession` does — or it will flash
   *  the stale session; do not treat non-null as "on the current axis". */
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
  atSession: AtSessionState | undefined
  /** The SELECTED run's schedule kind — the cadence of the strategy version that PRODUCED the run,
   *  fetched from that version (NOT the live editor document, which the user may have edited since).
   *  undefined while it loads, on a fetch failure, or before a run is selected. App threads it to
   *  TraceView's no-evaluation line so a post-run schedule edit can't make the line lie about the run. */
  runScheduleKind: string | undefined
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
  // The record-fetch error is TAGGED with the run it was fetched FOR, then gated to the current selection
  // on read (`runRecordError` below) — the same write-only tag/gate discipline as the trace and cadence
  // fetches. Tagging (rather than a plain string + an effect-start reset) closes the stale-error window
  // the record fold cannot: a failed fetch for run A leaves the record undefined, so the record gate can't
  // suppress A's message; without the tag it would flash under run B for the one render before the reset
  // effect ran. The effect only WRITES this tag (error on failure, cleared on success); the gate drops a
  // stale one, mirroring how `selectTrace` / the cadence gate handle their tags.
  const [errorTag, setErrorTag] = useState<{ runId: string; message: string } | undefined>(undefined)
  useEffect(() => {
    if (selectedRunId === undefined) {
      setRunRecord(undefined)
      setRunRecordLoading(false)
      setSessionCursor(null) // no run → no cursor axis
      return
    }
    let cancelled = false
    setRunRecord(undefined)
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
          setErrorTag(undefined) // a successful fetch clears any prior error for this run
          // D-12 (as amended, M13.7.5): default the cursor to the run's last EVALUATED session — the
          // most recent decision is the most interesting — falling back to the last session for a run
          // with no evaluations. A pure served-date selection (`defaultCursor`), never a derivation.
          setSessionCursor(defaultCursor(res))
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setRunRecord(undefined)
          setErrorTag({ runId: selectedRunId, message: errorMessage(e) })
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

  // The exposed record + loading are GATED/FOLDED (finding 8) so consumers see the SELECTED run's
  // record or loading, never a mismatch — the run-identity check computed ONCE here (also reused by the
  // schedule-kind fetch below, so the producing strategy identity is read only from a MATCHING record).
  // `gatedRecord` narrows a stale record to undefined; a DEFINED-but-mismatched record (its reset effect
  // runs only after paint, so `runRecord` is set but `gated` is undefined) folds into loading, as one thought.
  const gated = gatedRecord(runRecord, selectedRunId)

  // --- The run's cadence, sourced from the RUN (finding 1) -----------------------------------------
  // The no-evaluation lines name the strategy's cadence ("evaluates monthly"). That cadence MUST come
  // from the strategy version that PRODUCED the run — NOT the live editor document, which the user can
  // edit after running (the selected run survives doc edits): a monthly run whose doc was since edited to
  // daily would otherwise claim "evaluates daily" directly above its own served "monthly cadence" note.
  // Strategy versions are immutable once persisted, so the producing version's schedule is the run's
  // truth. We fetch it once per (strategy_id, strategy_version) of the GATED record and TAG the result
  // with the run it is for; `runScheduleKind` below gates the tag to the current selection, so a stale
  // resolve never surfaces under a different run (mirrors the trace fetch's tag/gate discipline).
  const runStrategyId = gated?.record.strategy_id
  const runStrategyVersion = gated?.record.strategy_version
  const [scheduleFetch, setScheduleFetch] = useState<
    { runId: string; kind: string | undefined } | undefined
  >(undefined)
  useEffect(() => {
    // Need a selected run whose matching record's producing-version identity is in hand.
    if (selectedRunId === undefined || runStrategyId === undefined || runStrategyVersion === undefined) {
      return
    }
    let cancelled = false
    const runId = selectedRunId
    loadStrategyVersion(runStrategyId, runStrategyVersion)
      .then((docv) => {
        if (!cancelled) setScheduleFetch({ runId, kind: docv.schedule.kind })
      })
      .catch(() => {
        // A cadence-fetch failure is deliberately NON-FATAL display degradation: tag the run with an
        // undefined kind so `runScheduleKind` resolves to undefined and the cadence clause simply drops —
        // the no-eval line falls back to its bare form, never blocking or erroring the panel.
        if (!cancelled) setScheduleFetch({ runId, kind: undefined })
      })
    return () => {
      cancelled = true
    }
  }, [selectedRunId, runStrategyId, runStrategyVersion])

  // Gate the tagged cadence to the CURRENT selection: a stale tag (the previous run's, held across a
  // switch before the effect re-fetches) or a loading/failed fetch reads as undefined — the clause drops.
  const runScheduleKind =
    scheduleFetch !== undefined && scheduleFetch.runId === selectedRunId ? scheduleFetch.kind : undefined

  // Gate the tagged record-fetch error to the CURRENT selection (same discipline as the cadence tag): a
  // failed fetch for the previous run, held across a switch before its effect re-runs, must not surface
  // its message under a different run. Mismatch → undefined; the interface stays `string | undefined`.
  const runRecordError =
    errorTag !== undefined && errorTag.runId === selectedRunId ? errorTag.message : undefined

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
    // Gate on the cursor actually belonging to the CURRENT run's axis via the SAME shared `isCursorOnAxis`
    // predicate `selectTrace` and the atSession memo use — not a hand-inlined copy of the axis logic. On a
    // run switch `setSessionCursor(null)` is scheduled, not immediate, so this effect can run once with the
    // previous run's cursor against the new `selectedRunId`; `sessionDates` is the run_id-gated memo, so
    // during that stale window it is the new run's dates (or empty) and this guard is false — the wasted
    // `getTraceTree(newRunId, oldCursor)` is never SENT. The `cancelled` cleanup drops a superseded in-flight
    // fetch (a late resolve would also be gated out by its tag, but cancelling avoids the wasted state write).
    // The `selectedRunId === undefined` clause is redundant with the predicate at runtime (it checks the
    // run too), present only to narrow `selectedRunId` to a string for the tagged fetch below.
    if (selectedRunId === undefined || !isCursorOnAxis(selectedRunId, sessionCursor, sessionDates)) {
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

  // The cursor session's note (M13.7.5 fix, finding 6): ONE derivation shared by the Trace panel (the
  // App threads it as `note`) and the atSession payload below — App must not re-derive it. `noteFor`
  // gates on the record's OWN run_id matching the selection (as `sessionAxis` / `evaluatedSet` do):
  // during a run switch this hook briefly still holds the previous run's record, and an ungated lookup
  // would surface the stale run's note. matchesRun-gating (not the stricter isCursorOnAxis) is enough:
  // TraceView renders no sessions during the stale window, and the atSession memo — which IS
  // isCursorOnAxis-gated — only reads this note when the cursor is on-axis (where the two gates agree).
  const note = useMemo(
    () => noteFor(runRecord, selectedRunId, sessionCursor),
    [runRecord, selectedRunId, sessionCursor],
  )

  // The live "At session" payload for the Inspector (M13.7): the trace tree at the shared cursor, plus
  // whether that session was evaluated and its no-eval note. Undefined until a run + cursor exist,
  // which keeps the Inspector's value-tap slot in its inert empty state. It shares the SAME lifted
  // trace fetch the Trace panel uses (keyed on run + cursor) — no second request. All fields are served
  // reads / filters (invariant 5); addressing stays (node_id, component_path) — the section resolves the
  // node, the cursor supplies session_date.
  const atSession = useMemo((): AtSessionState | undefined => {
    // Gate on the cursor being on the CURRENT run's axis — the SAME shared predicate `selectTrace`
    // uses for the trace panel. Without this, the one-render run-switch window (cursor still the
    // previous run's date, `sessionDates` already the new run's axis or empty) would build an
    // atSession with an off-axis cursor and `evaluated: false`, flashing "No evaluation this session"
    // in the Inspector instead of the inert empty slot. Off-axis → undefined keeps the slot inert.
    // Redundant with the predicate below at runtime (it checks the run too), present only to narrow
    // `selectedRunId` to a string for the `runId` field — as the trace-fetch effect's clause does.
    if (selectedRunId === undefined) return undefined
    if (!isCursorOnAxis(selectedRunId, sessionCursor, sessionDates)) return undefined
    return {
      runId: selectedRunId,
      cursor: sessionCursor,
      trees: traceTrees,
      loading: traceLoading,
      error: traceError,
      evaluated: evaluatedSessions.has(sessionCursor),
      note, // the SAME shared derivation TraceView receives — never re-computed here
      scheduleKind: runScheduleKind, // the RUN's cadence, shared with TraceView's no-eval line
    }
  }, [selectedRunId, sessionCursor, sessionDates, traceTrees, traceLoading, traceError, evaluatedSessions, note, runScheduleKind])

  // `gated` (the run-identity gate) is computed once above and reused here: consumers see the SELECTED
  // run's record or loading, never a mismatch. A DEFINED-but-mismatched record (its reset effect runs
  // only after paint, so `runRecord` is set but `gated` is undefined) folds into loading, as one thought.
  return {
    runRecord: gated,
    runRecordLoading: runRecordLoading || (runRecord !== undefined && gated === undefined),
    runRecordError,
    note,
    sessionCursor,
    setSessionCursor,
    sessionDates,
    evaluatedSessions,
    traceTrees,
    traceLoading,
    traceError,
    atSession,
    runScheduleKind,
  }
}
