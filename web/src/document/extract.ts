// Component extraction: the PURE document transformation that turns a selected subgraph into a
// standalone `ComponentDefinition` plus a rewritten `StrategyDocument` that references it (M12.2, E3–E7).
//
// This is a reducer-family member: pure, `structuredClone`-based, VERBATIM-PRESERVING (D4). It never
// mutates its inputs; moved nodes are deep-cloned including any `ui`/`extensions`/unknown keys. The
// ONLY "type" content here is a verbatim DATA COPY of a port's declared type from the catalog (or, for
// a nested component instance, from its cached definition) — there is NO type-COMPATIBILITY logic
// (CLAUDE.md invariant 5); nothing below compares two types.
//
// Structural pre-checks only (E6): the selection must be non-empty and its induced subgraph must be
// weakly connected. Everything semantic (terminal presence, required-input coverage, recursion) is the
// server's job — the caller runs a two-phase commit (E5) against the real validate endpoint.
import type { NodeCatalogResponse } from '@quantize/quantize-api'
import type {
  ComponentDefinition,
  ComponentRef,
  ComponentRefNode,
  Edge,
  ExposedParam,
  ExposedPort,
  JsonValue,
  RegisteredNode,
  StrategyDocument,
} from '@quantize/quantize-ir'
import { nodeTypeById } from '../catalog'
import { PLACEHOLDER_USER_ID, SCHEMA_VERSION } from '../config'

/** A graph node as the IR types it (an ordinary registered node OR a nested component instance). */
type GraphNode = RegisteredNode | ComponentRefNode
/** A port's declared type, exactly the union the IR `ExposedPort.type` field carries. */
type PortType = ExposedPort['type']
/** One requested exposed parameter: expose `nodeId`'s `paramKey` under `exposedName`. */
export interface ExposedParamRequest {
  nodeId: string
  paramKey: string
  exposedName: string
}
/** Options for {@link extractComponent}. */
export interface ExtractOptions {
  name: string
  description?: string
  exposedParams: ExposedParamRequest[]
  /** Override an exposed PORT name, keyed by its auto-generated (collision-suffixed) default name. */
  portNames?: Map<string, string>
}
/** The successful result: the minted definition and the rewritten strategy that references it. */
export interface ExtractSuccess {
  definition: ComponentDefinition
  strategy: StrategyDocument
}
/** Discriminated result — a pre-check/data failure returns `{error}`, never throws to the caller. */
export type ExtractResult = ExtractSuccess | { error: string }

// Internal control-flow signal: a data lookup (unknown type/port/ref) or a bad override. Caught at the
// top of `extractComponent` and converted to `{error}` so the caller has ONE error channel.
class ExtractionError extends Error {}

const IDENTIFIER = /^[A-Za-z0-9_]+$/

// Mint an identifier-like id (IR NodeId/RefId are `^[A-Za-z0-9_]+$` — a hyphenated uuid would FAIL
// server validation), mirroring store.ts `mintNodeId`: strip hyphens, prefix a letter.
function mintId(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll('-', '')
}

// A stable string key for a `[nodeId, port]` endpoint (space-separated). NodeId/PortName both obey the
// grammar `^[A-Za-z0-9_]+$`, which forbids spaces, so the first space unambiguously delimits node from
// port and the mapping is injective.
function endpointKey(ep: readonly [string, string]): string {
  return ep[0] + ' ' + ep[1]
}

// Read a node's `ui.position` as a numeric point, or `undefined` when absent/malformed.
function readPosition(node: GraphNode): { x: number; y: number } | undefined {
  const ui = node.ui
  if (ui === null || ui === undefined) {
    return undefined
  }
  const pos = ui['position']
  if (pos !== null && typeof pos === 'object' && !Array.isArray(pos)) {
    const x = pos['x']
    const y = pos['y']
    if (typeof x === 'number' && typeof y === 'number') {
      return { x, y }
    }
  }
  return undefined
}

// Undirected BFS over the INDUCED subgraph (edges with both endpoints in the selection). A single node
// is trivially connected. Structural only — no type logic.
function isWeaklyConnected(
  selectedNodes: GraphNode[],
  edges: Edge[],
  selected: ReadonlySet<string>,
): boolean {
  if (selectedNodes.length <= 1) {
    return true
  }
  const adjacency = new Map<string, Set<string>>()
  for (const node of selectedNodes) {
    adjacency.set(node.id, new Set())
  }
  for (const edge of edges) {
    const a = edge.from[0]
    const b = edge.to[0]
    if (selected.has(a) && selected.has(b)) {
      adjacency.get(a)?.add(b)
      adjacency.get(b)?.add(a)
    }
  }
  const start = selectedNodes[0].id
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!seen.has(neighbor)) {
        seen.add(neighbor)
        queue.push(neighbor)
      }
    }
  }
  return seen.size === selectedNodes.length
}

/**
 * Extract the selected subgraph of `doc` into a fresh {@link ComponentDefinition}, returning that
 * definition plus a rewritten strategy in which the subgraph is replaced by a single pinned
 * `ComponentRefNode`. Pure and verbatim-preserving; on any structural pre-check or data-lookup failure
 * it returns `{error}` and leaves `doc` untouched.
 *
 * @param catalog    the node catalog — the source of an ordinary inner port's declared TYPE (data copy).
 * @param components cache of nested component definitions, keyed `"<component_id>@<version>"` — the
 *                   source of a nested instance's exposed-port types.
 */
export function extractComponent(
  doc: StrategyDocument,
  selectedNodeIds: ReadonlySet<string>,
  catalog: NodeCatalogResponse,
  components: ReadonlyMap<string, ComponentDefinition>,
  opts: ExtractOptions,
): ExtractResult {
  try {
    // --- Pre-checks (structural only) --------------------------------------------------------------
    if (selectedNodeIds.size === 0) {
      return { error: 'Select at least one node to extract a component.' }
    }
    const byId = new Map<string, GraphNode>(doc.nodes.map((n) => [n.id, n]))
    const selectedNodes = doc.nodes.filter((n) => selectedNodeIds.has(n.id))
    if (selectedNodes.length !== selectedNodeIds.size) {
      return { error: 'Selection references a node that is not in the document.' }
    }
    if (!isWeaklyConnected(selectedNodes, doc.edges, selectedNodeIds)) {
      return { error: 'Selected nodes must form a single connected subgraph.' }
    }

    // Resolve a nested component instance's definition from the cache (by its pinned ref).
    const resolveNestedDef = (refId: string): ComponentDefinition => {
      const entry = doc.component_refs.find((r) => r.id === refId)
      if (entry === undefined) {
        throw new ExtractionError(`Selected component references an unknown ref "${refId}".`)
      }
      const def = components.get(entry.component_id + '@' + entry.version)
      if (def === undefined) {
        throw new ExtractionError(`Component definition for ref "${refId}" is not loaded.`)
      }
      return def
    }

    // The declared TYPE of an inner node's port (verbatim data copy — NEVER a comparison).
    const innerPortType = (node: GraphNode, port: string, direction: 'in' | 'out'): PortType => {
      if ('ref' in node) {
        const def = resolveNestedDef(node.ref)
        const ports = direction === 'in' ? def.exposed_inputs : def.exposed_outputs
        const match = ports.find((p) => p.name === port)
        if (match === undefined) {
          throw new ExtractionError(`Component instance "${node.id}" has no ${direction} port "${port}".`)
        }
        // Data copy — never alias the def-cache's immutable exposed-port type (matches paramSchema).
        return structuredClone(match.type)
      }
      const nodeType = nodeTypeById(catalog, node.type_id)
      if (nodeType === undefined) {
        throw new ExtractionError(`Unknown node type "${node.type_id}" for node "${node.id}".`)
      }
      const ports = direction === 'in' ? nodeType.inputs : nodeType.outputs
      const match = ports.find((p) => p.name === port)
      if (match === undefined) {
        throw new ExtractionError(`Node "${node.id}" has no ${direction} port "${port}".`)
      }
      // Data copy — never alias the app-wide immutable catalog port type (matches paramSchema).
      return structuredClone(match.port_type)
    }

    // --- Exposed-name assignment is TWO-PASS and deterministic w.r.t. the dialog preview -----------
    // PASS 1 (assignDefault) computes DEFAULT names exactly as an override-free run would: default =
    // inner port name; collision → `_2`, `_3`, ... over ONE shared namespace across inputs+outputs. This
    // is PRECISELY what the preview shows (the dialog previews with no `portNames`). PASS 2 (below) then
    // maps each default to `portNames.get(default) ?? default` — so overrides are keyed by the exact
    // names the preview displayed and a rename can NEVER be silently dropped by a shifted suffix. The
    // no-override path is byte-identical to before (defaults ARE the finals), so the E7 oracle is intact.
    const usedDefaults = new Set<string>()
    const assignDefault = (base: string): string => {
      let candidate = base
      let suffix = 2
      while (usedDefaults.has(candidate)) {
        candidate = base + '_' + suffix
        suffix += 1
      }
      usedDefaults.add(candidate)
      return candidate
    }

    // --- Edge classification IN DOCUMENT ORDER (E3) ------------------------------------------------
    // inside→inside: component-internal edge. outside→inside: boundary IN → one exposed input per unique
    // inner (node,port). inside→outside: boundary OUT → one exposed output per unique inner (node,port).
    // Exposed input/output ITERATION ORDER = document edge order (the oracle depends on this). Names here
    // are PASS-1 DEFAULTS; PASS 2 finalizes them (and rebuilds the key→name maps) once all are known.
    const componentEdges: Edge[] = []
    const exposedInputs: ExposedPort[] = []
    const exposedOutputs: ExposedPort[] = []
    const inputNameByKey = new Map<string, string>()
    const outputNameByKey = new Map<string, string>()

    for (const edge of doc.edges) {
      const fromInside = selectedNodeIds.has(edge.from[0])
      const toInside = selectedNodeIds.has(edge.to[0])
      if (fromInside && toInside) {
        componentEdges.push({ from: [edge.from[0], edge.from[1]], to: [edge.to[0], edge.to[1]] })
      } else if (!fromInside && toInside) {
        const key = endpointKey(edge.to)
        if (!inputNameByKey.has(key)) {
          const node = byId.get(edge.to[0]) as GraphNode
          const type = innerPortType(node, edge.to[1], 'in')
          const name = assignDefault(edge.to[1])
          inputNameByKey.set(key, name)
          exposedInputs.push({ name, type, maps_to: [edge.to[0], edge.to[1]] })
        }
      } else if (fromInside && !toInside) {
        const key = endpointKey(edge.from)
        if (!outputNameByKey.has(key)) {
          const node = byId.get(edge.from[0]) as GraphNode
          const type = innerPortType(node, edge.from[1], 'out')
          const name = assignDefault(edge.from[1])
          outputNameByKey.set(key, name)
          exposedOutputs.push({ name, type, maps_to: [edge.from[0], edge.from[1]] })
        }
      }
      // outside→outside: not part of the component; left for the strategy rewrite below.
    }

    // --- PASS 2: apply overrides keyed by the pass-1 DEFAULT (== the preview name) ------------------
    // `final = portNames.get(default) ?? default`; each override must be a valid identifier, and the
    // FINAL set (across inputs+outputs) must be unique — a duplicate (e.g. a rename that collides with a
    // sibling's default) throws the same 'used more than once' error the dialog surfaces. We finalize
    // inputs then outputs (matching their shared-namespace iteration order) and rewrite BOTH the port's
    // own `name` and its key→name map, which the edge rewiring below reads. No override → final = default.
    const finalNames = new Set<string>()
    const finalizePort = (port: ExposedPort, keyByName: Map<string, string>): void => {
      let final = port.name
      const override = opts.portNames?.get(port.name)
      if (override !== undefined) {
        if (!IDENTIFIER.test(override)) {
          throw new ExtractionError(`Exposed port name "${override}" is not a valid identifier.`)
        }
        final = override
      }
      if (finalNames.has(final)) {
        throw new ExtractionError(`Exposed port name "${final}" is used more than once.`)
      }
      finalNames.add(final)
      keyByName.set(endpointKey(port.maps_to), final)
      port.name = final
    }
    for (const port of exposedInputs) {
      finalizePort(port, inputNameByKey)
    }
    for (const port of exposedOutputs) {
      finalizePort(port, outputNameByKey)
    }

    // --- Exposed params (order = opts order) -------------------------------------------------------
    const exposedParams: ExposedParam[] = []
    for (const request of opts.exposedParams) {
      const node = byId.get(request.nodeId)
      if (node === undefined || !selectedNodeIds.has(request.nodeId)) {
        throw new ExtractionError(`Exposed param node "${request.nodeId}" is not in the selection.`)
      }
      const schema = paramSchema(node, request.paramKey, catalog, resolveNestedDef)
      exposedParams.push({
        name: request.exposedName,
        binds_to: [request.nodeId, request.paramKey],
        schema,
      })
    }

    // --- Nested refs (E4): copy each selected instance's pinned ref into the definition -------------
    const definitionRefs: ComponentRef[] = []
    const movedRefIds = new Set<string>()
    for (const node of selectedNodes) {
      if ('ref' in node && !movedRefIds.has(node.ref)) {
        const entry = doc.component_refs.find((r) => r.id === node.ref)
        if (entry === undefined) {
          throw new ExtractionError(`Selected component references an unknown ref "${node.ref}".`)
        }
        definitionRefs.push(structuredClone(entry))
        movedRefIds.add(node.ref)
      }
    }

    // --- Mint ids and build the definition ---------------------------------------------------------
    const componentId = crypto.randomUUID()
    const refId = mintId('r')
    const nodeId = mintId('n')

    const definition: ComponentDefinition = {
      schema_version: SCHEMA_VERSION,
      component_id: componentId,
      version: '1.0.0',
      name: opts.name,
      description: opts.description ?? null,
      component_refs: definitionRefs,
      implementation: {
        kind: 'graph',
        graph: {
          nodes: selectedNodes.map((n) => structuredClone(n)),
          edges: componentEdges,
        },
      },
      exposed_inputs: exposedInputs,
      exposed_outputs: exposedOutputs,
      exposed_params: exposedParams,
      provenance: {
        owner: PLACEHOLDER_USER_ID,
        creator: PLACEHOLDER_USER_ID,
        contributors: [],
        visibility: 'private',
        duplicable: false,
        created_at: new Date().toISOString(),
        forked_from: null,
      },
    }

    // --- The minted instance node (inserted at the FIRST removed node's index) ---------------------
    const positions = selectedNodes
      .map(readPosition)
      .filter((p): p is { x: number; y: number } => p !== undefined)
    const componentNode: ComponentRefNode = {
      id: nodeId,
      type_id: 'component',
      ref: refId,
      params: {},
    }
    if (positions.length > 0) {
      const xs = positions.map((p) => p.x)
      const ys = positions.map((p) => p.y)
      componentNode.ui = {
        position: {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
        },
      }
    }

    // --- Rewrite the strategy (structuredClone → surgery on the clone) -----------------------------
    const strategy = structuredClone(doc)

    const firstRemovedIdx = strategy.nodes.findIndex((n) => selectedNodeIds.has(n.id))
    strategy.nodes = strategy.nodes.filter((n) => !selectedNodeIds.has(n.id))
    strategy.nodes.splice(firstRemovedIdx, 0, componentNode)

    strategy.edges = strategy.edges
      .filter((e) => !(selectedNodeIds.has(e.from[0]) && selectedNodeIds.has(e.to[0])))
      .map((e): Edge => {
        const fromInside = selectedNodeIds.has(e.from[0])
        const toInside = selectedNodeIds.has(e.to[0])
        if (!fromInside && toInside) {
          const name = inputNameByKey.get(endpointKey(e.to)) as string
          return { from: [e.from[0], e.from[1]], to: [nodeId, name] }
        }
        if (fromInside && !toInside) {
          const name = outputNameByKey.get(endpointKey(e.from)) as string
          return { from: [nodeId, name], to: [e.to[0], e.to[1]] }
        }
        return { from: [e.from[0], e.from[1]], to: [e.to[0], e.to[1]] }
      })

    // Drop a moved ref from the strategy ONLY if no remaining OUTSIDE instance still uses it (E4).
    const outsideRefIds = new Set(
      doc.nodes
        .filter((n) => !selectedNodeIds.has(n.id) && 'ref' in n)
        .map((n) => (n as ComponentRefNode).ref),
    )
    strategy.component_refs = strategy.component_refs.filter(
      (r) => !(movedRefIds.has(r.id) && !outsideRefIds.has(r.id)),
    )
    strategy.component_refs.push({ id: refId, component_id: componentId, version: '1.0.0' })

    return { definition, strategy }
  } catch (error) {
    if (error instanceof ExtractionError) {
      return { error: error.message }
    }
    throw error
  }
}

// The JSON-Schema fragment for one internal parameter — copied VERBATIM from the catalog (an ordinary
// node) or from a nested instance's exposed-param schema. Never invented.
function paramSchema(
  node: GraphNode,
  paramKey: string,
  catalog: NodeCatalogResponse,
  resolveNestedDef: (refId: string) => ComponentDefinition,
): ExposedParam['schema'] {
  if ('ref' in node) {
    const def = resolveNestedDef(node.ref)
    const match = def.exposed_params.find((p) => p.name === paramKey)
    if (match === undefined) {
      throw new ExtractionError(`Component instance "${node.id}" exposes no param "${paramKey}".`)
    }
    return structuredClone(match.schema)
  }
  const nodeType = nodeTypeById(catalog, node.type_id)
  if (nodeType === undefined || nodeType.parameter_schema === null) {
    throw new ExtractionError(`Node type "${node.type_id}" has no parameter schema.`)
  }
  const properties = nodeType.parameter_schema['properties']
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new ExtractionError(`Node type "${node.type_id}" declares no parameter "${paramKey}".`)
  }
  const fragment: JsonValue | undefined = properties[paramKey]
  if (fragment === undefined || fragment === null || typeof fragment !== 'object' || Array.isArray(fragment)) {
    throw new ExtractionError(`Node type "${node.type_id}" declares no parameter "${paramKey}".`)
  }
  return structuredClone(fragment)
}
