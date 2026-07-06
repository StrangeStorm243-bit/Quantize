// The node inspector (M11.5, M12.4): identity + schema-driven parameter form for the selected node.
//
// Selection is APP-level state (not React Flow's transient selection — the canvas re-seeds its RF
// nodes from the document, which would drop RF selection). The Inspector reads the selected node from
// the canonical document and edits its params through the store's `setParams` reducer — no numerical
// or compatibility logic lives here (CLAUDE.md invariant 5).
//
// A ComponentRefNode (`'ref' in node`, M12.4/E10) resolves its pinned definition from the immutable
// component cache and edits its EXPOSED params — keyed by exposed name, layered server-side as
// overrides — through the SAME `ParamForm`, over a SYNTHESIZED object schema built from each exposed
// param's verbatim `schema` fragment. "Inspect internals" opens a read-only detail drawer (E11).
import type { ReactElement } from 'react'
import type { JsonValue, StrategyDocument } from '@quantize/quantize-ir'
import { nodeTypeById, useCatalog } from '../catalog'
import { useComponentDefs } from '../components-cache'
import type { NodeParams, StrategyDocumentActions } from '../document/store'
import type { ParameterSchema } from './ParamForm'
import { ParamForm } from './ParamForm'

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
    const ref = doc.component_refs.find((r) => r.id === node.ref)
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
        {nodeType !== undefined ? <p className="inspector__desc">{nodeType.description}</p> : null}
      </header>
      {nodeType === undefined ? (
        <p className="inspector__unknown">
          Unknown node type — parameters cannot be rendered without a catalog entry.
        </p>
      ) : (
        <ParamForm
          // Remount per node so per-property local UI state (draft chip, oneOf mode) resets cleanly.
          key={node.id}
          schema={nodeType.parameter_schema}
          params={params}
          onParamsChange={(next) => actions.setParams(node.id, next)}
        />
      )}
    </div>
  )
}
