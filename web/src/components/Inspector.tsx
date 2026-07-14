// The node inspector (M11.5, M12.4, M13.5, M13.7): identity + schema-driven parameter form for the
// selected node, plus its meaning. The primitive-node branch renders four sections: Parameters (the
// doc-labeled ParamForm), Explanation (role sentence → formula → semantics/warm-up), Ports (typed,
// labeled), and the "At session" section — the Node Value Tap slot (design W4), now LIVE (M13.7): the
// selected node's SERVED trace events at the shared session cursor, addressed by (node_id,
// component_path); at the output boundary it appends the engine reconciliation rows. All of it is pure
// projection of served catalog metadata + served trace facts; no numerical, compatibility, or decision
// logic lives here (CLAUDE.md invariant 5) — the section only looks up and filters served state.
//
// Selection is APP-level state (not React Flow's transient selection — the canvas re-seeds its RF
// nodes from the document, which would drop RF selection). The Inspector reads the selected node from
// the canonical document and edits its params through the store's `setParams` reducer.
//
// A ComponentRefNode (`'ref' in node`, M12.4/E10) resolves its pinned definition from the immutable
// component cache and edits its EXPOSED params — keyed by exposed name, layered server-side as
// overrides — through the SAME `ParamForm`, over a SYNTHESIZED object schema built from each exposed
// param's verbatim `schema` fragment. "Enter component" navigates the MAIN canvas into the definition's
// read-only internal view (M13.8 in-canvas breadcrumb, superseding the E11 modal drawer).
import type { ReactElement } from 'react'
import { useState } from 'react'
import type {
  AssetValueDto,
  NodeCatalogResponse,
  NodeTypeDto,
  NodeValueResponse,
  ParamDocDto,
  TraceTreeDto,
  TraceTreeNodeDto,
} from '@quantize/quantize-api'
import type { ComponentDefinition, JsonValue, StrategyDocument } from '@quantize/quantize-ir'
import { getNodeValue } from '../api/client'
import { abbrev, fmtValue } from '../format'
import { useFetch } from '../useFetch'
import { labelOf, nodeTypeById, useCatalog } from '../catalog'
import { portColor } from '../catalog/colors'
import { useComponentDefs } from '../components-cache'
import { findComponentRef } from '../document/flow'
import type { ComponentTrailEntry } from '../document/flow'
import { noEvaluationLine } from '../document/schedule'
import type { NodeParams, StrategyDocumentActions } from '../document/store'
import type { AtSessionState } from '../run/useDebugLoopState'
import { NoteLine } from './NoteLine'
import type { ParameterSchema } from './ParamForm'
import { ParamForm } from './ParamForm'
import { SvgLineChart } from './SvgLineChart'
import { TraceEventBody } from './TraceView'

// W3: the node's meaning, role sentence first (D-13). `doc.latex` is RESERVED and never rendered.
function ExplanationSection({ nodeType }: { nodeType: NodeTypeDto }): ReactElement {
  const doc = nodeType.doc
  return (
    <section className="inspector__section" aria-label="explanation">
      <h3 className="inspector__section-title">Explanation</h3>
      <p className="inspector__summary">{doc?.summary ?? nodeType.description}</p>
      {doc?.formula != null ? (
        <div className="inspector__docrow">
          <span className="inspector__doclabel">Formula</span>
          <code className="inspector__formula">{doc.formula}</code>
        </div>
      ) : null}
      {doc?.semantics != null ? (
        <div className="inspector__docrow">
          <span className="inspector__doclabel">Semantics &amp; warm-up</span>
          <p className="inspector__semantics">{doc.semantics}</p>
        </div>
      ) : null}
    </section>
  )
}

// Port meanings: name + served type label, colored by the shared port token (presentation only).
function PortsSection({ nodeType, catalog }: { nodeType: NodeTypeDto; catalog: NodeCatalogResponse }): ReactElement {
  return (
    <section className="inspector__section" aria-label="ports">
      <h3 className="inspector__section-title">Ports</h3>
      <ul className="inspector__ports">
        {nodeType.inputs.map((p) => (
          <li key={`in:${p.name}`} className="inspector__port">
            <span className="inspector__port-dir">in</span>
            <span className="inspector__port-name">{p.name}</span>
            <span className="inspector__port-type" style={{ color: portColor(p.port_type) }}>
              {labelOf(catalog, p.port_type)}
            </span>
            {p.required ? <span className="inspector__port-required">required</span> : null}
          </li>
        ))}
        {nodeType.outputs.map((p) => (
          <li key={`out:${p.name}`} className="inspector__port">
            <span className="inspector__port-dir">out</span>
            <span className="inspector__port-name">{p.name}</span>
            <span className="inspector__port-type" style={{ color: portColor(p.port_type) }}>
              {labelOf(catalog, p.port_type)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Live data for the "At session" section (M13.7) — undefined until a run + cursor exist. The SHAPE is
 * owned by the run layer that builds it (`AtSessionState`, run/useDebugLoopState); this is the prop
 * alias the Inspector consumes it under, so the run layer's payload type stays run-layer-owned.
 */
export type AtSessionProps = AtSessionState

// --- Node Value Tap addressing (design W4) --------------------------------------------------------
// The section renders SERVED facts addressed by (node_id, component_path); the cursor supplies the
// session_date. These are pure lookups/filters over the served trees — NOTHING is computed here
// (invariant 5). This addressing is the same shape a future `/v1/runs/{id}/values` request would use.

// Locate the SELECTED node among the served roots. Top-level nodes and ComponentRef INSTANCES are
// roots with an empty component_path; a match on (node_id, empty path) is the node's tap address.
function findRoot(trees: TraceTreeDto[], nodeId: string): TraceTreeNodeDto | undefined {
  for (const tree of trees) {
    // Restrict to node-origin roots: the engine is addressed by origin, never by node_id (invariant 2),
    // so a strategy node literally named `engine` never resolves to the engine-origin reconciliation root.
    const root = tree.roots.find(
      (r) => r.node_id === nodeId && r.component_path.length === 0 && r.origin === 'node',
    )
    if (root !== undefined) return root
  }
  return undefined
}

// All engine-origin roots across the served trees. The engine is NOT a graph node (invariant 2), so it
// is addressed by origin — never by a node_id — and surfaces only at the output boundary below.
function engineRoots(trees: TraceTreeDto[]): TraceTreeNodeDto[] {
  return trees.flatMap((tree) => tree.roots.filter((r) => r.origin === 'engine'))
}

// One served event rendered through the SHARED TraceView renderer (no duplicated per-event markup).
// The caller supplies the React `key` at each `.map` site.
function EventRow({ event }: { event: TraceTreeNodeDto['events'][number] }): ReactElement {
  return (
    <div className="trace-event">
      <span className="trace-event__type">{event.event_type}</span>
      <TraceEventBody event={event} />
    </div>
  )
}

// --- Node Value Tap: the served value at the session cursor (M14.2a) ------------------------------
// The value a node's output port PRODUCED at the session, from GET /v1/runs/{id}/values (recompute on
// demand). EVERY field is rendered in served order — nothing is summed, ranked, sorted, or highlighted
// here (invariant 5). Served numbers pass through `fmtValue` (PX-C): per-number DISPLAY formatting of
// one already-served value, with the verbatim value preserved in a `title` — presentation, never a
// computed aggregate. One request per (address, selected port); changing the selector fires a new
// request for that port only — no prefetch, no cache.

// The shared asset→value table (cross_section / portfolio_targets), served order, verbatim. Rendered
// only when the response carries a non-empty `asset_values`; the caller passes it straight through.
function AssetValuesTable({ rows }: { rows: readonly AssetValueDto[] }): ReactElement | null {
  if (rows.length === 0) return null
  return (
    <table className="inspector__value-table">
      <tbody>
        {rows.map((row, i) => (
          <tr key={`${row.asset}:${i}`}>
            <td>{row.asset}</td>
            {/* Display-formatted served cell; the verbatim value stays reachable in `title` (PX-C). */}
            <td title={String(row.value)}>{fmtValue(row.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// The value_summary → rows projection. TS narrows the discriminated union on `.kind`; each branch reads
// only served fields (String() for numbers/booleans) and renders stat rows only when the server sent them.
function ValueSummary({ data }: { data: NodeValueResponse }): ReactElement {
  const summary = data.value_summary
  const assetRows = data.asset_values ?? []
  switch (summary.kind) {
    case 'scalar':
      // Display-formatted value; the row's `title` keeps the verbatim served number reachable (PX-C).
      return (
        <div className="inspector__value-row" title={String(summary.value)}>
          {`${summary.dtype}: ${fmtValue(summary.value)}`}
        </div>
      )
    case 'asset_set':
      return (
        <>
          <div className="inspector__value-row">{summary.count} members</div>
          <ul className="inspector__value-members">
            {summary.members.map((m, i) => (
              <li key={`${m}:${i}`}>{m}</li>
            ))}
          </ul>
        </>
      )
    case 'cross_section':
      return (
        <>
          <div className="inspector__value-row">
            {summary.present_count} of {summary.domain_count} assets
          </div>
          {summary.dtype === 'Number' ? (
            <>
              {summary.min != null ? (
                <div className="inspector__value-row" title={String(summary.min)}>
                  Min: {fmtValue(summary.min)}
                </div>
              ) : null}
              {summary.max != null ? (
                <div className="inspector__value-row" title={String(summary.max)}>
                  Max: {fmtValue(summary.max)}
                </div>
              ) : null}
            </>
          ) : (
            <>
              {summary.true_count != null ? (
                <div className="inspector__value-row">True: {String(summary.true_count)}</div>
              ) : null}
              {summary.false_count != null ? (
                <div className="inspector__value-row">False: {String(summary.false_count)}</div>
              ) : null}
            </>
          )}
          {summary.missing.length > 0 ? (
            <div className="inspector__value-row">Missing: {summary.missing.join(', ')}</div>
          ) : null}
          <AssetValuesTable rows={assetRows} />
        </>
      )
    case 'time_series':
      return (
        <>
          <div className="inspector__value-row">
            {summary.asset_count} assets · {summary.total_points} points
          </div>
          {summary.window != null ? (
            <div className="inspector__value-row">
              {summary.window.first_date} → {summary.window.last_date}
            </div>
          ) : null}
          {/* Per asset: a SPARKLINE of the served points (reusing SvgLineChart AS-IS — pure display
              scaling of the verbatim points, invariant 5), with the raw date/value rows moved behind a
              collapsed `<details>` disclosure so 64 rows/asset no longer bury the summary (PX-B). An asset
              the server sent with no points is named with a "0 points" summary and gets neither a
              sparkline (its own empty state's wording is wrong here) nor a disclosure. */}
          {(data.series_preview ?? []).map((series) => (
            <div key={series.asset} className="inspector__value-series">
              {series.points.length > 0 ? (
                <>
                  <div className="inspector__value-spark">
                    <SvgLineChart points={series.points} ariaLabel={`${series.asset} series`} />
                  </div>
                  <details className="inspector__value-points">
                    <summary>
                      {series.asset} · {series.points.length} points
                    </summary>
                    {series.points.map(([date, val], i) => (
                      <div key={i} className="inspector__value-row">
                        <span className="inspector__value-label">{date}</span>
                        <span title={String(val)}>{fmtValue(val)}</span>
                      </div>
                    ))}
                  </details>
                </>
              ) : (
                <span className="inspector__value-label">{series.asset} · 0 points</span>
              )}
            </div>
          ))}
        </>
      )
    case 'portfolio_targets':
      return (
        <>
          <AssetValuesTable rows={assetRows} />
          {/* Served aggregates, DISPLAY-formatted — the client renders the numbers the server sent (each
              verbatim in `title`); it never re-sums the weights above (invariant 5 / PX-C). */}
          <div className="inspector__value-row" title={String(summary.weight_sum)}>
            Weight sum: {fmtValue(summary.weight_sum)}
          </div>
          <div className="inspector__value-row" title={String(summary.cash)}>
            Cash: {fmtValue(summary.cash)}
          </div>
        </>
      )
  }
}

// The value block for one node address. `ports` is the node's LISTED output ports (catalog outputs or a
// component's exposed_outputs); empty = unknown → the request omits the port and the response's own
// `output_port` labels the value. A selector appears ONLY when there is a genuine choice (>1 ports).
// Keyed by address at the call site, so `port` resets per node (the ParamForm remount precedent).
function ValueBlock({
  runId,
  sessionDate,
  nodeId,
  componentPath,
  ports,
}: {
  runId: string
  sessionDate: string
  nodeId: string
  componentPath: readonly string[]
  ports: readonly string[]
}): ReactElement {
  const [port, setPort] = useState<string | undefined>(ports[0])
  const { data, loading, error } = useFetch(
    () =>
      getNodeValue(runId, {
        nodeId,
        sessionDate,
        componentPath,
        ...(port !== undefined ? { outputPort: port } : {}),
      }),
    // `componentPath.join(',')` — the array identity is not a stable dependency key.
    [runId, sessionDate, nodeId, componentPath.join(','), port],
  )

  const selector =
    ports.length > 1 ? (
      <select
        className="inspector__port-select"
        aria-label="output port"
        value={port}
        onChange={(e) => setPort(e.target.value)}
      >
        {ports.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    ) : null
  // Port context for the pre-data states (review P3): a SOLE listed port renders as a static label so a
  // pending or refused request still names the port it addressed — load-bearing for nested ComponentRefs,
  // which have no Ports section. Multi-port keeps the selector; zero listed ports have nothing honest to
  // claim (the request omitted the port), so only the response's own `output_port` may label the value.
  const portContext =
    selector ?? (ports.length === 1 ? <div className="inspector__value-port">out {ports[0]}</div> : null)

  if (loading) {
    return (
      <>
        {portContext}
        <p className="inspector__empty-note">Loading value…</p>
      </>
    )
  }
  if (error !== undefined) {
    return (
      <>
        {portContext}
        {/* The served message verbatim (engine_drift, dataset_mismatch, ambiguous_output_port, …) — the
            honest-refusal pattern: render what the server said rather than guessing a value. */}
        <p className="inspector__at-error" role="alert">
          {error}
        </p>
      </>
    )
  }
  if (data === undefined) return <>{portContext}</>

  return (
    <>
      {selector}
      {/* The port from the RESPONSE (served, so a defaulted/omitted port labels itself). */}
      <div className="inspector__value-port">out {data.output_port}</div>
      <ValueSummary data={data} />
      <p className="inspector__value-provenance">
        {data.provenance.captured ? (
          'Captured at run'
        ) : (
          <>
            Recomputed on demand from the run's pinned inputs{' '}
            {/* Abbreviated for the narrow panel (PX-E); the full 64-char hash stays reachable in `title`. */}
            <code title={data.provenance.dataset_fingerprint}>
              {abbrev(data.provenance.dataset_fingerprint)}
            </code>
          </>
        )}
      </p>
    </>
  )
}

// The Node Value Tap rendering slot (design W4): the stable "At session" section, now LIVE (M13.7).
// Without an `atSession` (no run/cursor) it renders the ORIGINAL inert empty state, unchanged, in the
// SAME container so the slot never relayouts when data arrives (the M13.5 contract). With one, it shows
// the cursor date and the selected node's served trace events; at the output boundary it appends the
// engine reconciliation rows. `componentCategory` is the selected node's catalog category (undefined
// for a ComponentRef instance, which has no catalog entry) — the ONLY thing that gates the engine subsection.
function AtSessionSection({
  atSession,
  nodeId,
  componentCategory,
  componentPath,
  valuePorts,
  valuesOnly = false,
}: {
  atSession: AtSessionProps | undefined
  nodeId: string
  componentCategory: string | undefined
  /** Enclosing ComponentRef instance ids, outermost first; empty at top level (design W4). */
  componentPath: readonly string[]
  /** The node's LISTED output-port names (catalog outputs / exposed_outputs); empty = unknown. */
  valuePorts: readonly string[]
  /** M14.2b, decision D-f: inside a read-only component view the section is VALUES-ONLY — the value
   * block is the whole story, with NO node-events part and NO engine subsection. The section container,
   * title, cursor date, empty note, and no-eval phrasing stay SHARED (never duplicated). Defaults false
   * so every top-level call renders the full section unchanged (byte-identical). */
  valuesOnly?: boolean
}): ReactElement {
  if (atSession === undefined) {
    return (
      <section className="inspector__section inspector__section--at-session" aria-label="at session">
        <h3 className="inspector__section-title">At session</h3>
        <p className="inspector__empty-note">
          Run a strategy and select a session to inspect this node's last-run behavior.
        </p>
      </section>
    )
  }

  // The live body. Precedence: loading → error → (the node-events part + the engine part). The node
  // part and the engine part are INDEPENDENT: under the D+1 policy a fill lands at the next session's
  // open, typically a NON-evaluated session — so an output node may show "No evaluation this session"
  // for its own graph part while the engine still reconciled yesterday's orders (fills) below it. That
  // matches TraceView, which shows engine fills whenever the served trees are non-empty regardless of
  // evaluation. Every branch is a structural read of served state (or a filter of the trees); nothing
  // is derived (invariant 5).
  let body: ReactElement
  if (atSession.loading) {
    body = <p className="inspector__empty-note">Loading trace…</p>
  } else if (atSession.error !== undefined) {
    body = (
      <p className="inspector__at-error" role="alert">
        {atSession.error}
      </p>
    )
  } else {
    const trees = atSession.trees ?? []
    // (a) The NODE-EVENTS part. When evaluated: locate the selected node among the served roots and
    // render its events (a ComponentRef instance carries children — flatten ONE level so the instance
    // shows what its internal nodes did). When NOT evaluated: the honest no-eval line + the served note.
    let nodePart: ReactElement | null
    if (!atSession.evaluated) {
      nodePart = (
        <>
          {/* The SAME cadence-aware phrasing TraceView uses, sourced from the RUN's schedule kind — not
              the live editor doc — so a post-run schedule edit can't make this line misdescribe the run. */}
          <p className="inspector__empty-note">{noEvaluationLine(atSession.scheduleKind)}</p>
          {atSession.note !== undefined ? (
            <NoteLine note={atSession.note} className="inspector__at-note" />
          ) : null}
        </>
      )
    } else if (valuesOnly) {
      // Values-only variant (D-f): inside a component view we surface the VALUE alone — the trace facts
      // (node events + engine) are out of scope, so the value block below is the entire body.
      nodePart = null
    } else {
      const found = findRoot(trees, nodeId)
      const hasOwnEvents = found !== undefined && found.events.length > 0
      // KNOWN LIMITATION (deferred to post-M13.8): this flattens exactly ONE level, so a nested-component
      // child that emits nothing itself but whose OWN children (grandchildren) did is dropped here.
      const childrenWithEvents = (found?.children ?? []).filter((c) => c.events.length > 0)
      nodePart =
        !hasOwnEvents && childrenWithEvents.length === 0 ? (
          <p className="inspector__empty-note">This node emitted no events at this session.</p>
        ) : (
          <>
            {found?.events.map((event, i) => <EventRow key={`own:${i}`} event={event} />)}
            {childrenWithEvents.map((child) => (
              <div key={child.node_id} className="inspector__at-child">
                <span className="inspector__at-child-id">{child.node_id}</span>
                {child.events.map((event, i) => (
                  <EventRow key={`${child.node_id}:${i}`} event={event} />
                ))}
              </div>
            ))}
          </>
        )
    }

    // (b) The ENGINE subsection — only at the output boundary (category 'output'), and INDEPENDENT of
    // evaluation: whenever the served trees carry engine reconciliation rows, show them (the guard also
    // suppresses an empty "Engine" heading). ComponentRef instances pass `undefined` → never rendered;
    // the values-only variant never reaches the output boundary (an inner node), so it never shows engine.
    const engine = !valuesOnly && componentCategory === 'output' ? engineRoots(trees) : []

    // The Node Value Tap (M14.2a): the served value, ABOVE the trace facts, EVALUATED sessions only —
    // on a non-evaluated session the server could only 404 (no_evaluation_at_session) and the honest
    // no-eval line already renders, so we do not fetch. Keyed by address AND the listed-port identity:
    // `port` initializes once, so a definition that loads AFTER mount (nested-ref cache miss, valuePorts
    // [] → [names]) must remount the block to re-default to the first listed port. Every segment matches
    // ^[A-Za-z0-9_]+$, so the '/'-joined composite key is unambiguous.
    const valueBlock = atSession.evaluated ? (
      <div className="inspector__at-values">
        <ValueBlock
          key={`${componentPath.join(',')}/${nodeId}/${valuePorts.join(',')}`}
          runId={atSession.runId}
          sessionDate={atSession.cursor}
          nodeId={nodeId}
          componentPath={componentPath}
          ports={valuePorts}
        />
      </div>
    ) : null

    body = (
      <>
        {valueBlock}
        {nodePart}
        {engine.length > 0 ? (
          <div className="inspector__at-engine">
            <h4 className="inspector__at-subhead">Engine</h4>
            {engine.flatMap((root, ri) =>
              // A single session normally yields TWO instants (open-instant fills + close-instant
              // proposals), so `engineRoots` returns two roots BOTH with node_id 'engine'; fold the root
              // index into the key so the two instants' events never collide (duplicate-key warning).
              root.events.map((event, i) => <EventRow key={`engine:${ri}:${i}`} event={event} />),
            )}
          </div>
        ) : null}
      </>
    )
  }

  return (
    <section className="inspector__section inspector__section--at-session" aria-label="at session">
      <h3 className="inspector__section-title">At session</h3>
      <span className="inspector__cursor-date">{atSession.cursor}</span>
      {body}
    </section>
  )
}

// --- Read-only internals of a component-view node (M13.9 O3) --------------------------------------
// A component definition is immutable, but its internals must still be understandable. These render a
// node from the trail tip's definition graph READ-ONLY: its CONFIGURED parameter values (never an
// editable ParamForm, no `actions`), plus — for a primitive node — its Explanation and Ports, and a
// VALUES-ONLY "At session" section (M14.2b, D-f): the value the inner node produced at the cursor,
// tapped by (node id, the enclosing trail) — but no trace facts, staying read-only. Pure projection of
// served catalog metadata + served value + the definition's own configured params (invariant 5).

/** Present a JSON param value for read-only display: objects/arrays as compact JSON, scalars verbatim. */
function formatParamValue(value: JsonValue): string {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
}

// The configured params as a read-only label→value list (labels from the catalog param docs where
// present, else the raw key). No inputs — the definition is immutable, so nothing here edits.
function ReadOnlyParamsSection({
  params,
  docs,
}: {
  params: { [k: string]: JsonValue }
  docs?: { [k: string]: ParamDocDto }
}): ReactElement {
  const entries = Object.entries(params)
  return (
    <section className="inspector__section" aria-label="parameters">
      <h3 className="inspector__section-title">Parameters</h3>
      {entries.length === 0 ? (
        <p className="pform__empty">No parameters.</p>
      ) : (
        <ul className="inspector__ro-params">
          {entries.map(([key, value]) => (
            <li key={key} className="inspector__ro-param">
              <span className="inspector__ro-param-label">{docs?.[key]?.label ?? key}</span>
              <code className="inspector__ro-param-value">{formatParamValue(value)}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** A node selected inside a component view — resolved from the trail tip's definition graph. */
export interface ComponentNodeSelection {
  node: StrategyDocument['nodes'][number]
  /** The tip definition's refs, to resolve a nested ComponentRef inner node to its pinned definition. */
  componentRefs: StrategyDocument['component_refs']
  /** The enclosing ComponentRef INSTANCE ids, outermost first — the trail IS the value-tap
   * `component_path` for a node at this depth (design W4). Empty is impossible here (a component view). */
  componentPath: readonly string[]
}

function ComponentNodeInspector({
  node,
  componentRefs,
  componentPath,
  catalog,
  getDef,
  atSession,
}: {
  node: StrategyDocument['nodes'][number]
  componentRefs: StrategyDocument['component_refs']
  /** The enclosing ComponentRef instance ids (outermost first) — the value-tap component_path here. */
  componentPath: readonly string[]
  catalog: NodeCatalogResponse | undefined
  getDef: (componentId: string, version: string) => ComponentDefinition | undefined
  /** Live "At session" data (M14.2b) — threaded through so an inner node can show its VALUE (values-only). */
  atSession: AtSessionProps | undefined
}): ReactElement {
  const readOnlyNote = <p className="inspector__ro-note">Component internals — read-only.</p>

  // A nested ComponentRef inner node: resolve its pinned definition and show its exposed values read-only.
  if ('ref' in node) {
    const ref = findComponentRef(componentRefs, node.ref)
    const def = ref === undefined ? undefined : getDef(ref.component_id, ref.version)
    return (
      <div className="inspector">
        <header className="inspector__head">
          <div className="inspector__type">{def?.name ?? 'Component'}</div>
          <div className="inspector__typeid">
            {ref !== undefined ? `${ref.component_id}@${ref.version}` : node.ref}
          </div>
        </header>
        {readOnlyNote}
        <ReadOnlyParamsSection params={node.params} />
        <AtSessionSection
          atSession={atSession}
          nodeId={node.id}
          componentCategory={undefined}
          // A nested ref taps as (its instance id, the ENCLOSING trail) — its own id is NOT appended:
          // the evaluator stores a component's exposed outputs under `(*trail, instanceId)`. Ports are the
          // pinned def's exposed_outputs (cache miss → [] → the response's own output_port labels the value).
          componentPath={componentPath}
          valuePorts={def?.exposed_outputs.map((o) => o.name) ?? []}
          valuesOnly
        />
      </div>
    )
  }

  // A primitive inner node: identity + read-only params + Explanation + Ports + the values-only At session.
  const nodeType = catalog === undefined ? undefined : nodeTypeById(catalog, node.type_id)
  return (
    <div className="inspector">
      <header className="inspector__head">
        <div className="inspector__type">{nodeType?.display_name ?? node.type_id}</div>
        <div className="inspector__typeid">{node.type_id}</div>
      </header>
      {readOnlyNote}
      {/* catalog clause narrows the type for PortsSection (non-optional catalog); not redundant. */}
      {nodeType === undefined || catalog === undefined ? (
        <p className="inspector__unknown">
          Unknown node type — parameters cannot be rendered without a catalog entry.
        </p>
      ) : (
        <>
          <ReadOnlyParamsSection
            params={node.params}
            {...(nodeType.doc?.parameters !== undefined ? { docs: nodeType.doc.parameters } : {})}
          />
          <ExplanationSection nodeType={nodeType} />
          <PortsSection nodeType={nodeType} catalog={catalog} />
        </>
      )}
      <AtSessionSection
        atSession={atSession}
        nodeId={node.id}
        componentCategory={undefined}
        componentPath={componentPath}
        // The inner node taps at the trail; ports are its catalog outputs (unknown type → [] → the
        // response's own output_port labels the value).
        valuePorts={nodeType?.outputs.map((o) => o.name) ?? []}
        valuesOnly
      />
    </div>
  )
}

export interface InspectorProps {
  doc: StrategyDocument
  selectedNodeId: string | null
  actions: StrategyDocumentActions
  /** Navigate the main canvas into a component instance's read-only internals (App owns the trail, M13.8). */
  onEnterComponent?: (entry: ComponentTrailEntry) => void
  /** Live "At session" data (M13.7); undefined until a run + cursor exist — the slot stays inert then. */
  atSession?: AtSessionProps | undefined
  /**
   * M13.9 O3: a node selected INSIDE a read-only component view. When set, the Inspector renders that
   * node's identity, CONFIGURED params, meaning, ports, and a values-only "At session" section (M14.2b)
   * READ-ONLY — a component definition is immutable — taking precedence over `selectedNodeId`.
   */
  componentNode?: ComponentNodeSelection | undefined
}

export function Inspector({
  doc,
  selectedNodeId,
  actions,
  onEnterComponent,
  atSession,
  componentNode,
}: InspectorProps): ReactElement {
  const { catalog } = useCatalog()
  const { get } = useComponentDefs()

  // M13.9 O3 / M14.2b: a node selected inside a read-only component view takes precedence — render its
  // internals read-only (immutable definition). No `actions`; its "At session" section is values-only (D-f).
  if (componentNode !== undefined) {
    return (
      <ComponentNodeInspector
        node={componentNode.node}
        componentRefs={componentNode.componentRefs}
        componentPath={componentNode.componentPath}
        catalog={catalog}
        getDef={get}
        atSession={atSession}
      />
    )
  }

  if (selectedNodeId === null) {
    return <div className="inspector inspector--empty">Select a node to edit its parameters.</div>
  }

  const node = doc.nodes.find((n) => n.id === selectedNodeId)
  if (node === undefined) {
    return <div className="inspector inspector--empty">The selected node is no longer in the graph.</div>
  }

  // A ComponentRefNode: resolve its pinned definition from the cache and edit its exposed params.
  if ('ref' in node) {
    // Single-source the ref step through the shared helper (the same `.find` toFlow/decideConnection
    // use); the def then comes from the provider's key lookup, which is `defs.get(componentCacheKey(...))`
    // under the hood — the SAME second step the shared `resolveComponentDef` performs.
    const ref = findComponentRef(doc.component_refs, node.ref)
    const def = ref === undefined ? undefined : get(ref.component_id, ref.version)
    // "Enter component" navigates the main canvas into the definition's read-only internals (M13.8). It
    // renders in BOTH branches (cached def AND cache-miss/unknown-ref) whenever the ref itself resolves —
    // the ref alone pins the `(componentId, version)` the trail needs; the tip view loads the definition.
    const enterButton =
      ref !== undefined && onEnterComponent !== undefined ? (
        <button
          type="button"
          className="pform__btn inspector__inspect"
          onClick={() => onEnterComponent({ componentId: ref.component_id, version: ref.version, instanceId: node.id })}
        >
          Enter component
        </button>
      ) : null

    // Cache miss (definition not fetched yet) or an unknown ref — degrade gracefully, never crash.
    if (ref === undefined || def === undefined) {
      return (
        <div className="inspector">
          <header className="inspector__head">
            <div className="inspector__type">Component</div>
            <div className="inspector__typeid">{node.ref}</div>
          </header>
          <p className="inspector__unknown">
            Component definition is not loaded (or the ref is unknown) — parameters cannot be shown yet.
          </p>
          {enterButton}
          <AtSessionSection
            atSession={atSession}
            nodeId={node.id}
            componentCategory={undefined}
            componentPath={[]}
            valuePorts={[]}
          />
        </div>
      )
    }

    // The synthesized object schema: each exposed param's verbatim `schema` fragment becomes one
    // property. Exposed params are OPTIONAL overrides, so `required` stays empty (never mark required).
    const properties = Object.fromEntries(
      def.exposed_params.map((p): [string, JsonValue] => [p.name, p.schema]),
    )
    const synthesizedSchema: ParameterSchema = { type: 'object', properties, required: [] }
    const params = node.params as NodeParams

    return (
      <div className="inspector">
        <header className="inspector__head">
          <div className="inspector__type">{def.name}</div>
          <div className="inspector__typeid">{`${ref.component_id}@${ref.version}`}</div>
          {def.description !== null && def.description !== undefined ? (
            <p className="inspector__desc">{def.description}</p>
          ) : null}
        </header>
        {def.exposed_params.length === 0 ? (
          <p className="pform__empty">No exposed parameters.</p>
        ) : (
          <ParamForm
            // Remount per node so per-property local UI state resets cleanly.
            key={node.id}
            schema={synthesizedSchema}
            params={params}
            onParamsChange={(next) => actions.setParams(node.id, next)}
          />
        )}
        {enterButton}
        <AtSessionSection
          atSession={atSession}
          nodeId={node.id}
          componentCategory={undefined}
          componentPath={[]}
          // A ComponentRef instance taps as (instance id, empty path); its ports are the def's exposed
          // outputs — the evaluator stores those under the instance path, so no special-casing.
          valuePorts={def.exposed_outputs.map((o) => o.name)}
        />
      </div>
    )
  }

  const nodeType = catalog === undefined ? undefined : nodeTypeById(catalog, node.type_id)
  const params = node.params as NodeParams

  return (
    <div className="inspector">
      <header className="inspector__head">
        <div className="inspector__type">{nodeType?.display_name ?? node.type_id}</div>
        <div className="inspector__typeid">{node.type_id}</div>
      </header>
      {/* catalog clause narrows the type for PortsSection (non-optional catalog); not redundant. */}
      {nodeType === undefined || catalog === undefined ? (
        <p className="inspector__unknown">
          Unknown node type — parameters cannot be rendered without a catalog entry.
        </p>
      ) : (
        <>
          <section className="inspector__section" aria-label="parameters">
            <h3 className="inspector__section-title">Parameters</h3>
            <ParamForm
              // Remount per node so per-property local UI state (draft chip, oneOf mode) resets cleanly.
              key={node.id}
              schema={nodeType.parameter_schema}
              params={params}
              {...(nodeType.doc?.parameters !== undefined ? { docs: nodeType.doc.parameters } : {})}
              onParamsChange={(next) => actions.setParams(node.id, next)}
            />
          </section>
          <ExplanationSection nodeType={nodeType} />
          <PortsSection nodeType={nodeType} catalog={catalog} />
        </>
      )}
      <AtSessionSection
        atSession={atSession}
        nodeId={node.id}
        componentCategory={nodeType?.category}
        componentPath={[]}
        // Unknown node type → no listed ports; the response's own output_port still labels the value.
        valuePorts={nodeType?.outputs.map((o) => o.name) ?? []}
      />
    </div>
  )
}
