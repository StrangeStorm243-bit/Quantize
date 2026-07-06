// Read-only mapping: canonical `StrategyDocument` → React Flow node/edge shapes (M11.3, D4).
//
// The document is the source of truth; React Flow is a DERIVED, disposable view. `toFlow` NEVER
// mutates the document — it reads and projects. Semantic mutation only ever happens through the
// pure reducers in `store.ts`. Node display metadata (display_name, typed ports) comes from the
// M10 catalog and is added in M11.4; `toFlow` already accepts an optional `catalog` so that
// enrichment lands WITHOUT a signature change.
import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/react'
import type {
  CatalogInputPortDto,
  CatalogOutputPortDto,
  NodeCatalogResponse,
} from '@quantize/quantize-api'
import type { ComponentDefinition, JsonValue, StrategyDocument } from '@quantize/quantize-ir'

/**
 * The data an IR node contributes to its React Flow node. `typeId` is ALWAYS present. When `toFlow`
 * is given the catalog, it also carries the human `displayName` and the typed `inputs`/`outputs` for
 * that node type (verbatim generated DTOs — no re-declared shape); WITHOUT a catalog only `typeId` is
 * present, exactly as in M11.3. The custom canvas node reads these to render its ports and handles.
 */
export type FlowNodeData = {
  typeId: string
  displayName?: string
  inputs?: CatalogInputPortDto[]
  outputs?: CatalogOutputPortDto[]
}

/**
 * The cache key for a component definition: `component_id@version`. A definition is immutable per
 * version (the store returns 409 on a divergent re-save), so this key is stable forever — it is the
 * single agreed key format shared by the {@link ComponentsProvider} cache and every consumer that
 * resolves a `ComponentRef` (toFlow, decideConnection, the Inspector).
 */
export function componentCacheKey(componentId: string, version: string): string {
  return `${componentId}@${version}`
}

/**
 * The ONE definition→port mapping. A component's `exposed_inputs`/`exposed_outputs` project onto the
 * EXACT catalog port DTO shapes so `FlowNodeData`/`StrategyNode`/the connection gate treat a component
 * instance exactly like a registered node — no new port source, no divergent resolution path. Every
 * exposed input is `required: true` (the run-faithful preflight requires every exposed input connected
 * at the top level), and the port TYPE is copied verbatim (data, never compared here — invariant 5).
 * This is the single resolution path used by toFlow AND decideConnection AND (later) the Inspector.
 */
export function componentPorts(def: ComponentDefinition): {
  inputs: CatalogInputPortDto[]
  outputs: CatalogOutputPortDto[]
} {
  return {
    inputs: def.exposed_inputs.map((p) => ({ name: p.name, port_type: p.type, required: true })),
    outputs: def.exposed_outputs.map((p) => ({ name: p.name, port_type: p.type })),
  }
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
  catalog?: NodeCatalogResponse,
  components?: ReadonlyMap<string, ComponentDefinition>,
): { nodes: StrategyFlowNode[]; edges: FlowEdge[] } {
  // Index node types by id ONCE (when a catalog is provided) so the enrichment is O(nodes).
  const byType =
    catalog === undefined
      ? undefined
      : new Map(catalog.node_types.map((nt) => [nt.type_id, nt]))

  const nodes: StrategyFlowNode[] = doc.nodes.map((node, index) => {
    const data: FlowNodeData = { typeId: node.type_id }
    if ('ref' in node) {
      // A ComponentRefNode: resolve its pinned `(component_id, version)` and enrich from the cached
      // definition. On a cache miss (definition not fetched yet) keep the bare `{typeId: 'component'}`
      // shape — the SAME degradation an unknown/future registered type gets, never a crash.
      const ref = doc.component_refs.find((r) => r.id === node.ref)
      const def =
        ref === undefined ? undefined : components?.get(componentCacheKey(ref.component_id, ref.version))
      if (def !== undefined) {
        const ports = componentPorts(def)
        data.displayName = def.name
        data.inputs = ports.inputs
        data.outputs = ports.outputs
      }
    } else {
      const nodeType = byType?.get(node.type_id)
      if (nodeType !== undefined) {
        // Only add the enriched keys when the type resolves — an unknown/future type keeps the bare
        // `{typeId}` shape (backward-compatible with M11.3 and with the extensible-block seam).
        data.displayName = nodeType.display_name
        data.inputs = nodeType.inputs
        data.outputs = nodeType.outputs
      }
    }
    return {
      id: node.id,
      position: readPosition(node.ui) ?? gridPosition(index),
      data,
    }
  })

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
