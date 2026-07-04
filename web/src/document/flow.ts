// Read-only mapping: canonical `StrategyDocument` → React Flow node/edge shapes (M11.3, D4).
//
// The document is the source of truth; React Flow is a DERIVED, disposable view. `toFlow` NEVER
// mutates the document — it reads and projects. Semantic mutation only ever happens through the
// pure reducers in `store.ts`. Node display metadata (display_name, typed ports) comes from the
// M10 catalog and is added in M11.4; `toFlow` already accepts an optional `catalog` so that
// enrichment lands WITHOUT a signature change.
import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/react'
import type { JsonValue, StrategyDocument } from '@quantize/quantize-ir'

/** The data an IR node contributes to its React Flow node. Enriched from the catalog in M11.4. */
export type FlowNodeData = {
  typeId: string
}

/** A React Flow node whose `data` carries the mapped IR fields. */
export type StrategyFlowNode = FlowNode<FlowNodeData>

// Read `{x, y}` numbers out of a node's `ui.position` (typed as opaque JsonValue). Returns
// undefined when absent or malformed so the caller can fall back to a deterministic grid.
function readPosition(ui: StrategyDocument['nodes'][number]['ui']): { x: number; y: number } | undefined {
  if (ui === null || ui === undefined) {
    return undefined
  }
  const position = (ui as Record<string, JsonValue>).position
  if (position === null || typeof position !== 'object' || Array.isArray(position)) {
    return undefined
  }
  const { x, y } = position as Record<string, JsonValue>
  if (typeof x !== 'number' || typeof y !== 'number') {
    return undefined
  }
  return { x, y }
}

// Deterministic fallback layout: a 4-wide grid so a doc with no saved positions still renders
// legibly (used only when `ui.position` is absent/malformed).
function gridPosition(index: number): { x: number; y: number } {
  return { x: (index % 4) * 220, y: Math.floor(index / 4) * 140 }
}

/**
 * Project the document into `{ nodes, edges }` for React Flow. READ-ONLY. Each IR node → a RF node
 * (`id`, `position` from `ui.position` or the grid fallback, `data.typeId`). Each IR edge → a RF
 * edge whose id is `from0:from1->to0:to1#<index>`, `source`/`target` node ids, and
 * `sourceHandle`/`targetHandle` = the port names. The `#<index>` suffix keeps the RF key unique
 * even if a loaded doc carries two structurally identical edges (React needs unique keys; the
 * derive path must stay robust to any valid doc, not only canvas-authored ones).
 */
export function toFlow(
  doc: StrategyDocument,
  _catalog?: unknown,
): { nodes: StrategyFlowNode[]; edges: FlowEdge[] } {
  const nodes: StrategyFlowNode[] = doc.nodes.map((node, index) => ({
    id: node.id,
    position: readPosition(node.ui) ?? gridPosition(index),
    data: { typeId: node.type_id },
  }))

  const edges: FlowEdge[] = doc.edges.map((edge, index) => {
    const [source, sourceHandle] = edge.from
    const [target, targetHandle] = edge.to
    return {
      id: `${source}:${sourceHandle}->${target}:${targetHandle}#${index}`,
      source,
      target,
      sourceHandle,
      targetHandle,
    }
  })

  return { nodes, edges }
}
