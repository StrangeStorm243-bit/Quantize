// The node inspector (M11.5): identity + schema-driven parameter form for the selected node.
//
// Selection is APP-level state (not React Flow's transient selection — the canvas re-seeds its RF
// nodes from the document, which would drop RF selection). The Inspector reads the selected node from
// the canonical document and edits its params through the store's `setParams` reducer — no numerical
// or compatibility logic lives here (CLAUDE.md invariant 5).
import type { ReactElement } from 'react'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { nodeTypeById, useCatalog } from '../catalog'
import type { NodeParams, StrategyDocumentActions } from '../document/store'
import { ParamForm } from './ParamForm'

export interface InspectorProps {
  doc: StrategyDocument
  selectedNodeId: string | null
  actions: StrategyDocumentActions
}

export function Inspector({ doc, selectedNodeId, actions }: InspectorProps): ReactElement {
  const { catalog } = useCatalog()

  if (selectedNodeId === null) {
    return <div className="inspector inspector--empty">Select a node to edit its parameters.</div>
  }

  const node = doc.nodes.find((n) => n.id === selectedNodeId)
  if (node === undefined) {
    return <div className="inspector inspector--empty">The selected node is no longer in the graph.</div>
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
