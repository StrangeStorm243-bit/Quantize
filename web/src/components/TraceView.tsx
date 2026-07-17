// The trace explorer (M11.7, D10; M13.6; M13.7). The per-instant trace tree (grouped SERVER-SIDE by
// build_trace_trees, served by `GET /v1/runs/{id}/trace-tree`) is FETCHED BY THE APP, not here: the
// App owns one fetch keyed on the run + the shared session cursor so the Trace panel and the
// always-mounted Inspector consume a single result (the Dock mounts only one panel at a time, so a
// panel-local fetch could not be shared). This view is therefore CURSOR-CONTROLLED — it takes the
// cursor + served trees as props and reports picker changes via `onCursorChange`. The session axis,
// the evaluated subset, and the cursor session's note are ALSO props (M13.7.5): the App computes them
// once through `run/projections` (the single run_id-gated source), so this view no longer duplicates
// those derivations. It renders each event with a TAILORED renderer keyed on `event_type` / machine
// tokens, falling back to a generic structured renderer for any unknown type; nothing here parses
// prose or recomputes a decision, every field is read structurally from the payload (D10, invariant
// 5). The picker lists ALL of the run's sessions, flagging sessions the engine did not evaluate; the
// served engine-origin root is grouped under a distinct "engine stage" section (display grouping only).
import type { ReactElement } from 'react'
import type { JsonValue, PersistedNote, TraceEvent, TraceTreeDto, TraceTreeNodeDto } from '@quantize/quantize-api'
import { noEvaluationLine } from '../document/schedule'
import { fmtValue, verbatimTitle } from '../format'
import { NoteLine } from './NoteLine'

export interface TraceViewProps {
  /** The selected run id, or `undefined` when nothing is selected. */
  runId: string | undefined
  /** True while the App is fetching the run record (the picker options depend on it). */
  recordLoading?: boolean
  /** A record-fetch error message, or undefined. Surfaced here so a failed `getRun` is not silent. */
  recordError?: string | undefined
  /** The cursor axis: ALL of the run's server session dates (App-owned via `sessionAxis`). */
  sessions: string[]
  /** The evaluated subset (App-owned via `evaluatedSet`) — marks non-evaluated picker options and
   *  picks the honest empty state. */
  evaluatedSessions: ReadonlySet<string>
  /** The served note for the cursor session (App-owned via `noteFor`), or undefined — the verbatim
   *  no-eval reason shown for a non-evaluated cursor. */
  note: PersistedNote | undefined
  /** The RUN's schedule kind (App threads `runScheduleKind` — the producing strategy version's cadence,
   *  NOT the live editor doc's), or undefined. Names the cadence in the no-evaluation state ("this
   *  strategy evaluates monthly") so a skipped session is not mysterious. An unrecognised/absent kind
   *  simply drops the cadence clause — a pure phrasing (invariant 5). */
  scheduleKind?: string | undefined
  /** The shared session cursor (App-owned), or `null` when there is no run/axis. */
  sessionCursor: string | null
  /** Report a picker change up to the App (it re-keys the shared fetch). */
  onCursorChange: (date: string) => void
  /** The served per-instant trees for the cursor session (App-owned), or undefined before load. */
  trees: TraceTreeDto[] | undefined
  /** True while the App is fetching the trace for the cursor session. */
  treesLoading: boolean
  /** A trace-fetch error message, or undefined. */
  treesError: string | undefined
  /**
   * Click-through to the canvas (M13.7, breadcrumb-complete in M13.8): a NODE-origin trace row reports
   * its emitting node up to the App, which navigates to it. Passed `(node_id, component_path)`; a row
   * inside a component sends the component path so the App can walk the breadcrumb to the emitting node's
   * nesting level. Engine-origin rows are NEVER clickable (the engine is not a graph node, invariant 2).
   * Optional so the view renders standalone (no navigation).
   */
  onNodeClick?: (nodeId: string, componentPath: string[]) => void
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

// A single cell rendered for display (formatting, not derivation): numbers through the ONE shared
// display formatter (D-27 — the same rendering the Inspector/Results/Runs panels use), other
// primitives stringified, null/undefined as an em dash, nested structures shown as compact JSON so
// nothing is hidden. Call sites carrying a served float keep the verbatim number in a `title`.
function cell(value: JsonValue | undefined): string {
  if (value === null || value === undefined) {
    return '—'
  }
  if (typeof value === 'number') {
    return fmtValue(value)
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

// One value cell: the shared display rendering PLUS its verbatim title in a single element — the
// D-27 pairing as a mechanism rather than a per-site convention, so a new renderer cannot pair
// cell() without the title by accident. `prefix` covers composite cells like the fill price's '@'.
// Deliberate exception: a structural integer echoed INSIDE PROSE (SelectSelected's `selected N:`)
// stays plain `cell()` — counts are lossless under fmtValue and wrapping prose fragments in spans
// only fragments the sentence for readers and text matchers.
function NumCell({
  value,
  className = 'trace-event__cell',
  prefix = '',
}: {
  value: JsonValue | undefined
  className?: string
  prefix?: string
}): ReactElement {
  return (
    <span className={className} {...verbatimTitle(value)}>
      {prefix}
      {cell(value)}
    </span>
  )
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
              <NumCell value={rank} />
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
      {/* Money fields display through the shared formatter; EACH figure carries ITS OWN verbatim
          title — one title over three numbers would misattribute whichever the user hovers. */}
      <span className="trace-event__kv trace-event__kv--muted">
        PV <NumCell value={payload.portfolio_value} className="" /> · target cash{' '}
        <NumCell value={payload.target_cash} className="" /> · projected{' '}
        <NumCell value={payload.projected_cash} className="" />
      </span>
      {orders.length > 0 ? (
        <ul className="trace-event__rows">
          {orders.map((row, i) => {
            const [side, asset, qty] = asArray(row)
            return (
              <li key={i} className="trace-event__row">
                <span className="trace-event__token">{cell(side)}</span>
                <span className="trace-event__cell">{cell(asset)}</span>
                <NumCell value={qty} />
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
                  <NumCell value={qty} />
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
              <NumCell value={qty} />
              <NumCell value={price} prefix="@ " />
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
          <NumCell value={value} />
        </li>
      ))}
    </ul>
  )
}

// Dispatch on the machine `event_type` token — the tailored renderer or the generic fallback. This is
// the ONE trace-event renderer: the Inspector's "At session" section (M13.7) imports it rather than
// duplicating the per-event markup, so both surfaces render served facts identically (invariant 5).
export function TraceEventBody({ event }: { event: TraceEvent }): ReactElement {
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

// One served node's events plus its nested children, indented by `depth` to show the component
// hierarchy. The nesting is SERVED from /trace-tree (M13.6) — the fields are the wire DTO's
// snake_case shape; nothing is regrouped here. A NODE-origin head is a button that reports the emitting
// node up via `onNodeClick` (trace→canvas, M13.7); an ENGINE-origin head stays a plain non-interactive
// `<div>` because the engine is not a graph node (invariant 2) and has nothing to select on canvas. The
// callback is threaded down to every descendant unchanged, so each node's OWN origin decides its head.
function TraceNodeView({
  node,
  depth,
  onNodeClick,
}: {
  node: TraceTreeNodeDto
  depth: number
  onNodeClick?: ((nodeId: string, componentPath: string[]) => void) | undefined
}): ReactElement {
  const headStyle = { paddingLeft: `${depth * 1.25}rem` }
  const headContent = (
    <>
      <span className="trace-node__id">{node.node_id}</span>
      <span className="trace-node__origin">{node.origin}</span>
    </>
  )
  return (
    <li className={`trace-node ${node.origin === 'engine' ? 'trace-node--engine' : ''}`}>
      {node.origin === 'engine' ? (
        <div className="trace-node__head" style={headStyle}>
          {headContent}
        </div>
      ) : (
        <button
          type="button"
          className="trace-node__head trace-node__head--clickable"
          style={headStyle}
          aria-label={`Show ${node.node_id} on canvas`}
          onClick={() => onNodeClick?.(node.node_id, node.component_path)}
        >
          {headContent}
        </button>
      )}
      {node.events.map((event, i) => (
        <div key={i} className="trace-event" style={{ paddingLeft: `${depth * 1.25}rem` }}>
          <span className="trace-event__type">{event.event_type}</span>
          <TraceEventBody event={event} />
        </div>
      ))}
      {node.children.length > 0 ? (
        <ul className="trace-node__children">
          {node.children.map((child) => (
            <TraceNodeView
              key={`${child.component_path.join('/')}/${child.node_id}`}
              node={child}
              depth={depth + 1}
              onNodeClick={onNodeClick}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function TraceView({
  runId,
  recordLoading,
  recordError,
  sessions,
  evaluatedSessions,
  note,
  scheduleKind,
  sessionCursor,
  onCursorChange,
  trees,
  treesLoading,
  treesError,
  onNodeClick,
}: TraceViewProps): ReactElement {
  if (runId === undefined) {
    return <div className="trace trace--empty">Select a run to view its trace.</div>
  }

  // The no-evaluation line names the RUN's cadence when the schedule kind is recognised — a monthly
  // strategy only decides on rebalance days, so a skipped session is expected, not an error. An
  // unrecognised/absent kind drops the clause. The SAME shared phrasing the Inspector uses (invariant 5).
  const noEvalLine = noEvaluationLine(scheduleKind)

  // For an empty served result, distinguish an evaluated-but-traceless session from a session the
  // engine never evaluated; for the latter, the App-supplied `note` (the run's note for the cursor
  // session) is surfaced verbatim (never blank). A structural read — no prose parsing (invariant 5).
  const cursorEvaluated = sessionCursor !== null && evaluatedSessions.has(sessionCursor)

  // A record-fetch failure (getRun, App-owned) surfaces here too — otherwise a failed record silently
  // leaves the picker empty ("No sessions") with no explanation. The record error takes precedence
  // over a trace error, and either fetch being in flight shows the loading state.
  const error = recordError ?? treesError
  const loading = (recordLoading ?? false) || treesLoading

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
          value={sessionCursor ?? ''}
          onChange={(e) => onCursorChange(e.target.value)}
        >
          {sessions.length === 0 ? <option value="">No sessions</option> : null}
          {sessions.map((date) => (
            <option key={date} value={date}>
              {`${date}${evaluatedSessions.has(date) ? '' : ' — no evaluation'}`}
            </option>
          ))}
        </select>
      </div>

      {error !== undefined ? (
        <div className="trace__error" role="alert">
          {error}
        </div>
      ) : loading ? (
        <div className="trace trace--empty">Loading trace…</div>
      ) : trees !== undefined && trees.length === 0 ? (
        cursorEvaluated ? (
          <div className="trace trace--empty">No trace for this session.</div>
        ) : (
          <div className="trace trace--empty">
            <p>{noEvalLine}</p>
            {note !== undefined ? <NoteLine note={note} /> : null}
          </div>
        )
      ) : (
        (trees ?? []).map((tree) => {
          // Partition the served roots by origin, PRESERVING order within each partition — a display
          // grouping only (never a re-sort): node-origin roots render first, the engine-origin root(s)
          // under a distinct "engine stage" section.
          const nodeRoots = tree.roots.filter((root) => root.origin !== 'engine')
          const engineRoots = tree.roots.filter((root) => root.origin === 'engine')
          return (
            <section key={tree.instant} className="trace__instant">
              <h4 className="trace__instant-title">{tree.instant}</h4>
              <ul className="trace__roots">
                {nodeRoots.map((root) => (
                  <TraceNodeView
                    key={`${root.component_path.join('/')}/${root.node_id}/${root.origin}`}
                    node={root}
                    depth={0}
                    onNodeClick={onNodeClick}
                  />
                ))}
              </ul>
              {engineRoots.length > 0 ? (
                <section className="trace__engine" aria-label="engine stage">
                  <h4 className="trace__engine-title">Engine — targets → orders → fills</h4>
                  <ul className="trace__roots">
                    {engineRoots.map((root) => (
                      <TraceNodeView
                        key={`${root.component_path.join('/')}/${root.node_id}/${root.origin}`}
                        node={root}
                        depth={0}
                        onNodeClick={onNodeClick}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}
            </section>
          )
        })
      )}
    </div>
  )
}
