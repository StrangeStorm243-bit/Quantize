// The node inspector (M11.5, M12.4, M13.5): identity + schema-driven parameter form for the selected
// node, plus its meaning. The primitive-node branch renders four sections (M13.5): Parameters (the
// doc-labeled ParamForm), Explanation (role sentence → formula → semantics/warm-up), Ports (typed,
// labeled), and an inert "At session" shell — a stable slot a later slice fills with the node's
// last-run trace values at the session cursor. All of it is pure projection of served catalog
// metadata; no numerical or compatibility logic lives here (CLAUDE.md invariant 5).
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
import type { NodeCatalogResponse, NodeTypeDto } from '@quantize/quantize-api'
import type { JsonValue, StrategyDocument } from '@quantize/quantize-ir'
import { labelOf, nodeTypeById, useCatalog } from '../catalog'
import { portColor } from '../catalog/colors'
import { useComponentDefs } from '../components-cache'
import { findComponentRef } from '../document/flow'
import type { NodeParams, StrategyDocumentActions } from '../document/store'
import type { ParameterSchema } from './ParamForm'
import { ParamForm } from './ParamForm'

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

// The Node Value Tap rendering slot (design W4): a stable section that a later slice fills with the
// selected node's served trace events at the session cursor — values arrive here with NO relayout.
function AtSessionShell(): ReactElement {
  return (
    <section className="inspector__section inspector__section--at-session" aria-label="at session">
      <h3 className="inspector__section-title">At session</h3>
      <p className="inspector__empty-note">
        Run a strategy and select a session to inspect this node's last-run behavior.
      </p>
    </section>
  )
}

export interface InspectorProps {
  doc: StrategyDocument
  selectedNodeId: string | null
  actions: StrategyDocumentActions
  /** Open the read-only internal-graph drawer for a component instance (App owns the drawer state). */
  onInspectComponent?: (target: { componentId: string; version: string }) => void
}

export function Inspector({
  doc,
  selectedNodeId,
  actions,
  onInspectComponent,
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
      <AtSessionShell />
    </div>
  )
}
