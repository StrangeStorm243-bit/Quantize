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
import type {
  ComponentDefinition,
  ComponentRef,
  JsonValue,
  StrategyDocument,
} from '@quantize/quantize-ir'
import { portColorVar } from '../catalog/colors'
import type { PortType } from '../catalog'

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
  /** The served machine-stage category (M13.4) — drives the card color/icon. Absent for an unknown/
   * future type (the view falls back to the neutral token) and for component instances. */
  category?: string
  /** A one-line description for the card's hover tooltip (PX-3): the catalog `description` for a
   * registered node, the resolved definition's `description` for a component. Absent for an unknown/
   * future type, a component whose definition has none (null), or a component cache miss. */
  description?: string
  /** A one-line preview of the node's params for the card face (e.g. `lookback_sessions = 63`). */
  paramSummary?: string
  /** True for a `ComponentRefNode` — the card renders the composition variant + a version chip. */
  isComponent?: boolean
  /** The pinned component version, for the chip (present whether or not the definition has loaded). */
  version?: string
  /** For a `data`-category node: the universe tickers read from the connected `universe.*` node's
   * params (document data), or `null` when nothing feeds its asset input (unbound). Absent for
   * non-data nodes. Consumed by the Data Source card. */
  universeTickers?: string[] | null
  /** Run-derived validity badge, OVERLAID by the Canvas from the latest validation (never by
   * `toFlow`, which is a pure doc/catalog projection). Cleared on any semantic doc mutation (D-7). */
  validity?: NodeValidity
}

/** The validity a node card badges: from the most-recent validation response only (D-7). */
export type NodeValidity = 'valid' | 'error'

// A single scalar param → its display string. The ONLY place param values are stringified for a card.
function formatParamScalar(value: JsonValue): string {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return String(value)
  }
  return JSON.stringify(value)
}

// One param value → display string; a long array is truncated to its first three plus a `+N` count so
// the card face stays a single line (the full list lives in the inspector / Data Source card).
function formatParamValue(value: JsonValue): string {
  if (Array.isArray(value)) {
    const head = value.slice(0, 3).map(formatParamScalar)
    return value.length > 3 ? `[${head.join(', ')}, +${value.length - 3}]` : `[${head.join(', ')}]`
  }
  return formatParamScalar(value)
}

/**
 * Format a node's params into a compact one-line summary for the card face (`key = value`, joined by
 * ` · `), or `undefined` when the node has no params. Pure presentation of document data — no numeric
 * derivation (invariant 5).
 */
export function formatParamSummary(params: { [k: string]: JsonValue } | undefined): string | undefined {
  if (params === undefined) {
    return undefined
  }
  const entries = Object.entries(params)
  if (entries.length === 0) {
    return undefined
  }
  return entries.map(([key, value]) => `${key} = ${formatParamValue(value)}`).join(' · ')
}

/**
 * Resolve a `data`-category node's universe: the tickers from whatever node feeds its asset input.
 * Walks the document's edges (document data only) — for each edge INTO the data node, if the source is
 * a genuine `universe`-category node (per the injected `isUniverseSource` predicate, a served-catalog
 * string comparison) that carries a `tickers` string array param, that is the universe. Returns `null`
 * when nothing resolvable feeds it (an unbound data node, a non-universe source that merely happens to
 * carry a `tickers` param, a `ComponentRefNode` source which has no catalog category, or — in a
 * read-only component view — a universe arriving through an exposed input). NEVER computes (invariant 5).
 *
 * The category gate is passed in (not read here) because this function stays a pure doc projection with
 * no catalog dependency of its own; `toFlow` supplies a predicate over its own catalog index.
 */
export function resolveUniverseTickers(
  doc: Pick<StrategyDocument, 'nodes' | 'edges'>,
  dataNodeId: string,
  isUniverseSource: (nodeTypeId: string) => boolean,
): string[] | null {
  for (const edge of doc.edges) {
    if (edge.to[0] !== dataNodeId) {
      continue
    }
    const source = doc.nodes.find((n) => n.id === edge.from[0])
    if (source === undefined || !isUniverseSource(source.type_id)) {
      continue
    }
    const tickers = (source.params as { [k: string]: JsonValue } | undefined)?.tickers
    if (Array.isArray(tickers) && tickers.every((t) => typeof t === 'string')) {
      return tickers as string[]
    }
  }
  return null
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
 * Find a pinned `ComponentRef` by its node-local `ref` id — the FIRST step of resolving a
 * `ComponentRefNode`. Kept separate from {@link resolveComponentDef} because a consumer (the
 * Inspector) needs the ref ITSELF — to show `component_id@version` and offer "Inspect internals" —
 * even when the definition has not been fetched yet (a cache miss). Returns `undefined` when no ref
 * carries that id.
 */
export function findComponentRef(
  componentRefs: readonly ComponentRef[] | undefined,
  refId: string,
): ComponentRef | undefined {
  return componentRefs?.find((r) => r.id === refId)
}

/**
 * The SINGLE ref→definition resolution shared by render (`toFlow`), connect (`decideConnection`) and
 * inspect (the Inspector). Two steps that must NEVER disagree for the same node: find the pinned ref
 * by its id, then look its immutable definition up in the cache by the shared `component_id@version`
 * key. Returns `undefined` on EITHER miss (unknown ref OR definition not fetched) — the same graceful
 * degradation every consumer already relies on. Centralizing it here means a future resolution change
 * (a cache-miss fallback, version aliasing) lands in ONE place instead of desyncing the three sites.
 */
export function resolveComponentDef(
  componentRefs: readonly ComponentRef[] | undefined,
  refId: string,
  components: ReadonlyMap<string, ComponentDefinition> | undefined,
): ComponentDefinition | undefined {
  const ref = findComponentRef(componentRefs, refId)
  return ref === undefined
    ? undefined
    : components?.get(componentCacheKey(ref.component_id, ref.version))
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

/** One breadcrumb level: the pinned identity of an entered component (labels resolve from the cache). */
export interface ComponentTrailEntry {
  componentId: string
  version: string
}

/**
 * Resolve a served trace `component_path` (ComponentRef INSTANCE node ids, outermost first) into
 * breadcrumb trail entries by walking doc → definition → definition. Returns the LONGEST resolvable
 * prefix — an unknown node/ref stops the walk, and a definition cache miss stops it AFTER the entry
 * the ref alone proves (the view ensures + loads that tip). Pure lookup; nothing is fetched here.
 */
export function resolveTrailFromPath(
  doc: Pick<StrategyDocument, 'nodes' | 'component_refs'>,
  componentPath: readonly string[],
  components: ReadonlyMap<string, ComponentDefinition> | undefined,
): ComponentTrailEntry[] {
  const trail: ComponentTrailEntry[] = []
  let nodes: StrategyDocument['nodes'] = doc.nodes
  let refs: StrategyDocument['component_refs'] | undefined = doc.component_refs
  for (const instanceId of componentPath) {
    const node = nodes.find((n) => n.id === instanceId)
    if (node === undefined || !('ref' in node)) break
    const ref = findComponentRef(refs, node.ref)
    if (ref === undefined) break
    trail.push({ componentId: ref.component_id, version: ref.version })
    // The ref proves this level; without the cached definition its body — and so any deeper level —
    // is unknown, so the walk stops here with the tip the view then ensures + loads.
    const def = components?.get(componentCacheKey(ref.component_id, ref.version))
    if (def === undefined || def.implementation.kind !== 'graph') break
    // A nested ref resolves against the DEFINITION's own scope, so swap both per level.
    nodes = def.implementation.graph.nodes
    refs = def.component_refs
  }
  return trail
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
  // Widened to `nodes`+`edges` (plus the optional `component_refs` this path resolves) so a component
  // `Graph` — which is exactly `{nodes, edges}` — projects through the SAME function as a full
  // `StrategyDocument`. A `StrategyDocument` (component_refs required) satisfies this; a `Graph`
  // (no component_refs) satisfies it too, resolving any nested ref to a bare node (the cache-miss posture).
  doc: Pick<StrategyDocument, 'nodes' | 'edges'> & {
    component_refs?: StrategyDocument['component_refs']
  },
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
    // The param-summary line is document data on EVERY node kind (registered + component).
    const paramSummary = formatParamSummary(node.params)
    if (paramSummary !== undefined) {
      data.paramSummary = paramSummary
    }
    if ('ref' in node) {
      // A ComponentRefNode: resolve its pinned `(component_id, version)` and enrich from the cached
      // definition. The variant flag + version chip come from the pinned REF (always present), so the
      // card reads as a component even on a cache miss (definition not fetched yet) — never a crash.
      data.isComponent = true
      const ref = findComponentRef(doc.component_refs, node.ref)
      if (ref !== undefined) {
        data.version = ref.version
      }
      const def = resolveComponentDef(doc.component_refs, node.ref, components)
      if (def !== undefined) {
        const ports = componentPorts(def)
        data.displayName = def.name
        data.inputs = ports.inputs
        data.outputs = ports.outputs
        // A component's description is optional (`string | null`); carry it only when present.
        if (def.description !== null && def.description !== undefined) {
          data.description = def.description
        }
      }
    } else {
      const nodeType = byType?.get(node.type_id)
      if (nodeType !== undefined) {
        // Only add the enriched keys when the type resolves — an unknown/future type keeps the bare
        // `{typeId}` shape (backward-compatible with M11.3 and with the extensible-block seam).
        data.displayName = nodeType.display_name
        data.inputs = nodeType.inputs
        data.outputs = nodeType.outputs
        data.category = nodeType.category
        data.description = nodeType.description
        // A data-category node is the machine's entry point — resolve its universe (document data) so
        // the Data Source card can show it; `null` records an explicit unbound state, not "absent".
        if (nodeType.category === 'data') {
          data.universeTickers = resolveUniverseTickers(
            doc,
            node.id,
            (typeId) => byType?.get(typeId)?.category === 'universe',
          )
        }
      }
    }
    return {
      id: node.id,
      position: readPosition(node.ui) ?? gridPosition(index),
      data,
    }
  })

  // Resolve the port type a source handle CARRIES, so the edge can be colored by it (M13.4). A
  // registered source resolves via the catalog; a component source via its cached definition — the
  // SAME two port sources render already uses. Returns undefined when unresolved (no catalog, unknown
  // type, definition not loaded, unknown handle) → the edge stays the default color, never a crash.
  const outputPortType = (sourceId: string, handle: string): PortType | undefined => {
    const node = doc.nodes.find((n) => n.id === sourceId)
    if (node === undefined) {
      return undefined
    }
    if ('ref' in node) {
      const def = resolveComponentDef(doc.component_refs, node.ref, components)
      return def === undefined
        ? undefined
        : componentPorts(def).outputs.find((p) => p.name === handle)?.port_type
    }
    return byType?.get(node.type_id)?.outputs.find((p) => p.name === handle)?.port_type
  }

  const edges: FlowEdge[] = doc.edges.map((edge, index) => {
    const [source, sourceHandle] = edge.from
    const [target, targetHandle] = edge.to
    const flowEdge: FlowEdge = {
      id: `${source}:${sourceHandle}->${target}:${targetHandle}#${index}`,
      source,
      target,
      sourceHandle,
      targetHandle,
    }
    // Color by carried port type when it resolves. The class suffix is DERIVED from the token name
    // (`--port-cross-section-number` → `cross-section-number`) so class and color stay in lockstep,
    // and the inline stroke actually paints the wire without a per-type CSS rule.
    const portType = outputPortType(source, sourceHandle)
    if (portType !== undefined) {
      const tokenVar = portColorVar(portType)
      flowEdge.className = `sedge sedge--${tokenVar.replace('--port-', '')}`
      flowEdge.style = { stroke: `var(${tokenVar})` }
    }
    return flowEdge
  })

  return { nodes, edges }
}
