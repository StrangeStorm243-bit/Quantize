// The trace explorer (M11.7, D10). Pick an evaluation session → fetch its flat trace events →
// `groupTrace` them into per-instant nested trees (component hierarchy shown as indentation) → render
// each event with a TAILORED renderer keyed on `event_type` / machine tokens, falling back to a
// generic structured renderer for any unknown type. The grouping is PRESENTATION only (mirrors the
// server's tree.py); nothing here parses prose or recomputes a decision — every field is read
// structurally from the payload (D10, invariant 5). The session dates come from the run record's
// evaluations, so the persisted run stays the single source of truth.
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { JsonValue, RunRecordResponse, TraceEvent } from '@quantize/quantize-api'
import { errorMessage, getTrace } from '../api/client'
import { groupTrace } from '../trace/group'
import type { TraceNode } from '../trace/group'

export interface TraceViewProps {
  /** The selected run id, or `undefined` when nothing is selected. */
  runId: string | undefined
  /** The fetched run record (owned by the App, shared with ResultsView), or undefined. */
  record: RunRecordResponse | undefined
  /** True while the App is fetching the record (the session dates come from it). */
  recordLoading: boolean
  /** A record-fetch error message, or undefined. */
  recordError: string | undefined
}

// --- Structural payload accessors (NEVER prose parsing) -------------------------------------------
// Payload values are `JsonValue`; these narrow to the concrete shape a renderer expects, reading
// machine fields directly. A missing/malformed field degrades to a visible placeholder, never a throw.

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function asStrings(value: JsonValue | undefined): string[] {
  return asArray(value).filter((v): v is string => typeof v === 'string')
}

// A single cell rendered verbatim (display formatting, not derivation): primitives stringified,
// null/undefined as an em dash, nested structures shown as compact JSON so nothing is hidden.
function cell(value: JsonValue | undefined): string {
  if (value === null || value === undefined) {
    return '—'
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

// --- Tailored per-event renderers ----------------------------------------------------------------

function SelectSelected({ payload }: { payload: TraceEvent['payload'] }): ReactElement {
  const selected = asStrings(payload.selected)
  const unselected = asStrings(payload.unselected)
  return (
    <div className="trace-event__body">
      <span className="trace-event__kv">
        selected {cell(payload.n)}: {selected.length > 0 ? selected.join(', ') : '—'}
      </span>
      {unselected.length > 0 ? (
        <span className="trace-event__kv trace-event__kv--muted">unselected: {unselected.join(', ')}</span>
      ) : null}
    </div>
  )
}

function TransformExcluded({ payload }: { payload: TraceEvent['payload'] }): ReactElement {
  return (
    <div className="trace-event__body">
      <span className="trace-event__kv">
        excluded <strong>{cell(payload.asset)}</strong> — <code className="trace-event__token">{cell(payload.reason)}</code>
      </span>
    </div>
  )
}

function RankAssigned({ payload }: { payload: TraceEvent['payload'] }): ReactElement {
  const ranking = asArray(payload.ranking)
  return (
    <div className="trace-event__body">
      <span className="trace-event__kv trace-event__kv--muted">
        ranking ({cell(payload.descending) === 'true' ? 'descending' : 'ascending'})
      </span>
      <ul className="trace-event__rows">
        {ranking.map((row, i) => {
          const [asset, rank] = asArray(row)
          return (
            <li key={i} className="trace-event__row">
              <span className="trace-event__cell">{cell(asset)}</span>
              <span className="trace-event__cell">{cell(rank)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function OrdersProposed({ payload }: { payload: TraceEvent['payload'] }): ReactElement {
  const orders = asArray(payload.orders)
  const omitted = asArray(payload.omitted)
  return (
    <div className="trace-event__body">
      <span className="trace-event__kv trace-event__kv--muted">
        PV {cell(payload.portfolio_value)} · target cash {cell(payload.target_cash)} · projected {cell(payload.projected_cash)}
      </span>
      {orders.length > 0 ? (
        <ul className="trace-event__rows">
          {orders.map((row, i) => {
            const [side, asset, qty] = asArray(row)
            return (
              <li key={i} className="trace-event__row">
                <span className="trace-event__token">{cell(side)}</span>
                <span className="trace-event__cell">{cell(asset)}</span>
                <span className="trace-event__cell">{cell(qty)}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <span className="trace-event__kv trace-event__kv--muted">no orders</span>
      )}
      {omitted.length > 0 ? (
        <>
          <span className="trace-event__kv trace-event__kv--muted">omitted</span>
          <ul className="trace-event__rows">
            {omitted.map((row, i) => {
              const [asset, reason, qty] = asArray(row)
              return (
                <li key={i} className="trace-event__row">
                  <span className="trace-event__cell">{cell(asset)}</span>
                  <code className="trace-event__token">{cell(reason)}</code>
                  <span className="trace-event__cell">{cell(qty)}</span>
                </li>
              )
            })}
          </ul>
        </>
      ) : null}
    </div>
  )
}

function OrdersFilled({ payload }: { payload: TraceEvent['payload'] }): ReactElement {
  const fills = asArray(payload.fills)
  return (
    <div className="trace-event__body">
      <ul className="trace-event__rows">
        {fills.map((row, i) => {
          const [side, asset, qty, price, , , scaled] = asArray(row)
          return (
            <li key={i} className="trace-event__row">
              <span className="trace-event__token">{cell(side)}</span>
              <span className="trace-event__cell">{cell(asset)}</span>
              <span className="trace-event__cell">{cell(qty)}</span>
              <span className="trace-event__cell">@ {cell(price)}</span>
              {cell(scaled) === 'true' ? <code className="trace-event__token">scaled</code> : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function EngineNote({ payload }: { payload: TraceEvent['payload'] }): ReactElement {
  return (
    <div className="trace-event__body">
      <span className="trace-event__kv">
        <code className="trace-event__token">{cell(payload.code)}</code> {cell(payload.message)}
      </span>
    </div>
  )
}

// The fallback for any event_type without a tailored renderer: list the payload fields structurally
// (key → value), so a new event type degrades gracefully instead of vanishing (D10). The `v` schema
// version is dropped as noise.
function GenericPayload({ payload }: { payload: TraceEvent['payload'] }): ReactElement {
  const entries = Object.entries(payload).filter(([key]) => key !== 'v')
  return (
    <ul className="trace-event__rows">
      {entries.map(([key, value]) => (
        <li key={key} className="trace-event__row">
          <span className="trace-event__cell trace-event__cell--key">{key}</span>
          <span className="trace-event__cell">{cell(value)}</span>
        </li>
      ))}
    </ul>
  )
}

// Dispatch on the machine `event_type` token — the tailored renderer or the generic fallback.
function EventBody({ event }: { event: TraceEvent }): ReactElement {
  switch (event.event_type) {
    case 'select.selected':
      return <SelectSelected payload={event.payload} />
    case 'transform.excluded':
      return <TransformExcluded payload={event.payload} />
    case 'rank.assigned':
      return <RankAssigned payload={event.payload} />
    case 'engine.orders_proposed':
      return <OrdersProposed payload={event.payload} />
    case 'engine.orders_filled':
      return <OrdersFilled payload={event.payload} />
    case 'engine.note':
      return <EngineNote payload={event.payload} />
    default:
      return <GenericPayload payload={event.payload} />
  }
}

// One node's events plus its nested children, indented by `depth` to show the component hierarchy.
function TraceNodeView({ node, depth }: { node: TraceNode; depth: number }): ReactElement {
  return (
    <li className={`trace-node ${node.origin === 'engine' ? 'trace-node--engine' : ''}`}>
      <div className="trace-node__head" style={{ paddingLeft: `${depth * 1.25}rem` }}>
        <span className="trace-node__id">{node.nodeId}</span>
        <span className="trace-node__origin">{node.origin}</span>
      </div>
      {node.events.map((event, i) => (
        <div key={i} className="trace-event" style={{ paddingLeft: `${depth * 1.25}rem` }}>
          <span className="trace-event__type">{event.event_type}</span>
          <EventBody event={event} />
        </div>
      ))}
      {node.children.length > 0 ? (
        <ul className="trace-node__children">
          {node.children.map((child) => (
            <TraceNodeView key={`${child.componentPath.join('/')}/${child.nodeId}`} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function TraceView({ runId, record, recordLoading, recordError }: TraceViewProps): ReactElement {
  const [selected, setSelected] = useState<string>('')
  const [events, setEvents] = useState<TraceEvent[] | undefined>(undefined)
  const [traceError, setTraceError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  // The distinct evaluation session dates are the picker options. They come from the App-owned record
  // — the persisted run is the single source of truth for which sessions exist. Gate on the record's
  // own `run_id` matching `runId`: during a run switch the App briefly still holds the previous run's
  // record, so an unguarded derivation would offer the stale run's dates.
  const sessions = useMemo(() => {
    if (record === undefined || runId === undefined || record.record.run_id !== runId) {
      return []
    }
    const seen = new Set<string>()
    const dates: string[] = []
    for (const evaluation of record.record.evaluations) {
      if (!seen.has(evaluation.session_date)) {
        seen.add(evaluation.session_date)
        dates.push(evaluation.session_date)
      }
    }
    return dates
  }, [record, runId])

  // When the run changes, synchronously reset the session selection so the trace-fetch effect can't
  // fire ONCE with the PREVIOUS run's `selected` date before the new run's dates resolve — a wasted
  // `getTrace(newRunId, staleDate)`. Setting state during render re-renders immediately with
  // `selected === ''` BEFORE any effect runs. (React's supported "adjust state on a prop change".)
  const [loadedRunId, setLoadedRunId] = useState(runId)
  if (runId !== loadedRunId) {
    setLoadedRunId(runId)
    setSelected('')
    setEvents(undefined)
  }

  // Auto-select the first session once the matching record's dates are known so a trace shows. `''`
  // is never a user choice (the picker only offers real dates), so this only fires on the initial load.
  if (selected === '' && sessions.length > 0) {
    setSelected(sessions[0])
  }

  // Fetch the selected session's trace. The server already filters to that session; we only group.
  useEffect(() => {
    if (runId === undefined || selected === '') {
      setEvents(undefined)
      return
    }
    let cancelled = false
    setLoading(true)
    setTraceError(undefined)
    getTrace(runId, selected)
      .then((res) => {
        if (!cancelled) {
          setEvents(res.events)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setEvents(undefined)
          setTraceError(errorMessage(e))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [runId, selected])

  // Memoize the pure grouping so it only recomputes when `events` changes (not on every render).
  // Declared before the early return to keep hook order unconditional (Rules of Hooks).
  const trees = useMemo(() => (events === undefined ? [] : groupTrace(events)), [events])

  if (runId === undefined) {
    return <div className="trace trace--empty">Select a run to view its trace.</div>
  }

  // A record-fetch failure (App) or a trace-fetch failure (here) — both surface in the same slot.
  const error = recordError ?? traceError

  return (
    <div className="trace">
      <div className="trace__head">
        <label className="pform__label" htmlFor="trace-session">
          Session
        </label>
        <select
          id="trace-session"
          aria-label="trace session"
          className="pform__input"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {sessions.length === 0 ? <option value="">No sessions</option> : null}
          {sessions.map((date) => (
            <option key={date} value={date}>
              {date}
            </option>
          ))}
        </select>
      </div>

      {error !== undefined ? (
        <div className="trace__error" role="alert">
          {error}
        </div>
      ) : recordLoading || loading ? (
        <div className="trace trace--empty">Loading trace…</div>
      ) : events !== undefined && events.length === 0 ? (
        <div className="trace trace--empty">No trace for this session.</div>
      ) : (
        trees.map((tree) => (
          <section key={tree.instant} className="trace__instant">
            <h4 className="trace__instant-title">{tree.instant}</h4>
            <ul className="trace__roots">
              {tree.roots.map((root) => (
                <TraceNodeView
                  key={`${root.componentPath.join('/')}/${root.nodeId}/${root.origin}`}
                  node={root}
                  depth={0}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}
