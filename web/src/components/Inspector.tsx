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
import type {
  NodeCatalogResponse,
  NodeTypeDto,
  TraceTreeDto,
  TraceTreeNodeDto,
} from '@quantize/quantize-api'
import type { JsonValue, StrategyDocument } from '@quantize/quantize-ir'
import { labelOf, nodeTypeById, useCatalog } from '../catalog'
import { portColor } from '../catalog/colors'
import { useComponentDefs } from '../components-cache'
import { findComponentRef } from '../document/flow'
import { noEvaluationLine } from '../document/schedule'
import type { NodeParams, StrategyDocumentActions } from '../document/store'
import type { AtSessionState } from '../run/useDebugLoopState'
import { NoteLine } from './NoteLine'
import type { ParameterSchema } from './ParamForm'
import { ParamForm } from './ParamForm'
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
}: {
  atSession: AtSessionProps | undefined
  nodeId: string
  componentCategory: string | undefined
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
    let nodePart: ReactElement
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
    } else {
      const found = findRoot(trees, nodeId)
      const hasOwnEvents = found !== undefined && found.events.length > 0
      // KNOWN LIMITATION (deferred to M13.8+): this flattens exactly ONE level, so a nested-component
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
    // suppresses an empty "Engine" heading). ComponentRef instances pass `undefined` → never rendered.
    const engine = componentCategory === 'output' ? engineRoots(trees) : []

    body = (
      <>
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

export interface InspectorProps {
  doc: StrategyDocument
  selectedNodeId: string | null
  actions: StrategyDocumentActions
  /** Navigate the main canvas into a component instance's read-only internals (App owns the trail, M13.8). */
  onEnterComponent?: (target: { componentId: string; version: string }) => void
  /** Live "At session" data (M13.7); undefined until a run + cursor exist — the slot stays inert then. */
  atSession?: AtSessionProps | undefined
}

export function Inspector({
  doc,
  selectedNodeId,
  actions,
  onEnterComponent,
  atSession,
}: InspectorProps): ReactElement {
  const { catalog } = useCatalog()
  const { get } = useComponentDefs()

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
          onClick={() => onEnterComponent({ componentId: ref.component_id, version: ref.version })}
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
          <AtSessionSection atSession={atSession} nodeId={node.id} componentCategory={undefined} />
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
        <AtSessionSection atSession={atSession} nodeId={node.id} componentCategory={undefined} />
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
      <AtSessionSection atSession={atSession} nodeId={node.id} componentCategory={nodeType?.category} />
    </div>
  )
}
