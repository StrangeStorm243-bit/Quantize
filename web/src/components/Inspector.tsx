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
// param's verbatim `schema` fragment. "Inspect internals" opens a read-only detail drawer (E11).
import type { ReactElement } from 'react'
import type {
  NodeCatalogResponse,
  NodeTypeDto,
  PersistedNote,
  TraceTreeDto,
  TraceTreeNodeDto,
} from '@quantize/quantize-api'
import type { JsonValue, StrategyDocument } from '@quantize/quantize-ir'
import { labelOf, nodeTypeById, useCatalog } from '../catalog'
import { portColor } from '../catalog/colors'
import { useComponentDefs } from '../components-cache'
import { findComponentRef } from '../document/flow'
import type { NodeParams, StrategyDocumentActions } from '../document/store'
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

/** Live data for the "At session" section (M13.7) — undefined until a run + cursor exist. */
export interface AtSessionProps {
  cursor: string
  trees: TraceTreeDto[] | undefined
  loading: boolean
  error: string | undefined
  /** Whether the cursor session has an evaluation; false → honest no-eval state. */
  evaluated: boolean
  /** The run record note for this session, when one exists (the served no-eval reason). */
  note: PersistedNote | undefined
}

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

  // The live body, in the precedence loading → error → no-eval → evaluated. Every branch is a
  // structural read of served state (or a filter of the served trees); nothing is derived.
  let body: ReactElement
  if (atSession.loading) {
    body = <p className="inspector__empty-note">Loading trace…</p>
  } else if (atSession.error !== undefined) {
    body = (
      <p className="inspector__at-error" role="alert">
        {atSession.error}
      </p>
    )
  } else if (!atSession.evaluated) {
    // Honest no-evaluation state; surface the run's note for this session verbatim when one exists.
    body = (
      <>
        <p className="inspector__empty-note">No evaluation this session.</p>
        {atSession.note !== undefined ? (
          <p className="inspector__at-note">
            <code className="trace-event__token">{atSession.note.code}</code> {atSession.note.message}
          </p>
        ) : null}
      </>
    )
  } else {
    // Evaluated: locate the selected node among the served roots and render its events. A ComponentRef
    // instance carries children (its internal nodes) — flatten ONE level so the instance shows what its
    // internal nodes did. The engine subsection appears only at the output boundary (category 'output').
    const trees = atSession.trees ?? []
    const found = findRoot(trees, nodeId)
    const children = found?.children ?? []
    const hasOwnEvents = found !== undefined && found.events.length > 0
    // KNOWN LIMITATION (deferred to M13.8+): this flattens exactly ONE level, so a nested-component
    // child that emits nothing itself but whose OWN children (grandchildren) did is dropped here.
    const childrenWithEvents = children.filter((c) => c.events.length > 0)
    const engine = componentCategory === 'output' ? engineRoots(trees) : []

    body = (
      <>
        {!hasOwnEvents && childrenWithEvents.length === 0 ? (
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
        )}
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
  /** Open the read-only internal-graph drawer for a component instance (App owns the drawer state). */
  onInspectComponent?: (target: { componentId: string; version: string }) => void
  /** Live "At session" data (M13.7); undefined until a run + cursor exist — the slot stays inert then. */
  atSession?: AtSessionProps | undefined
}

export function Inspector({
  doc,
  selectedNodeId,
  actions,
  onInspectComponent,
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
    const inspectButton =
      ref !== undefined && onInspectComponent !== undefined ? (
        <button
          type="button"
          className="pform__btn inspector__inspect"
          onClick={() => onInspectComponent({ componentId: ref.component_id, version: ref.version })}
        >
          Inspect internals
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
          {inspectButton}
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
        {inspectButton}
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
