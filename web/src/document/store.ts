// The canonical in-memory strategy document + PURE reducers (M11.3, D4).
//
// This module is the editor's single source of truth. State is ONE `StrategyDocument` (the
// GENERATED IR type — never re-declared, CLAUDE.md invariant 4). Every semantic mutation goes
// through a pure function here that RETURNS A NEW document and NEVER mutates its input or any nested
// object. React Flow's node/edge shapes are a DERIVED, read-only view (see `flow.ts`).
//
// VERBATIM PRESERVATION IS THE LAW (D4): a reducer changes exactly the one field it is about and
// preserves every other field the IR carries — top-level `extensions`, per-node `ui`/`extensions`,
// `component_refs`, provenance, and any unknown/future key. We achieve this structurally with
// `structuredClone` (deep copy, no shared references, unknown keys copied) and by mutating ONLY the
// target on the clone. There is NO field whitelist — whitelisting would silently drop future keys.
//
// No numerical, portfolio, or compatibility logic lives here (invariant 5); connection VALIDITY is
// the canvas's job (D5, M11.4), so `connect` just appends.
import { useCallback, useMemo, useState } from 'react'
import type { JsonValue, RegisteredNode, StrategyDocument } from '@quantize/quantize-ir'
import { PLACEHOLDER_USER_ID, SCHEMA_VERSION } from '../config'

/** A node's `params` object (as the IR types it). */
export type NodeParams = RegisteredNode['params']
/** A node's `ui` object (instance `ui.*`: preserved round-trip, excluded from semantics). */
export type NodeUi = NonNullable<RegisteredNode['ui']>
/** A canvas position, stored at `node.ui.position`. */
export interface Position {
  x: number
  y: number
}
/** An edge endpoint `[nodeId, portName]` (matches the IR Edge tuple). */
export type Endpoint = [string, string]

/** Arguments for {@link addNode}. */
export interface AddNodeArgs {
  typeId: string
  typeVersion: string
  params: NodeParams
  position: Position
}
/** Arguments for {@link connect} / a target for {@link disconnect}. */
export interface EdgeSpec {
  from: Endpoint
  to: Endpoint
}

// Mint a NODE id. IR NodeId is `^[A-Za-z0-9_]+$` (identifier-like, NO hyphens) — a raw hyphenated
// uuid would FAIL server validation. So we strip the hyphens and prefix a letter.
function mintNodeId(): string {
  return 'n' + crypto.randomUUID().replaceAll('-', '')
}

/**
 * A structurally valid fresh strategy document (D7): version 1, a hyphenated-uuid `strategy.id`
 * (EntityId — distinct from node ids), provenance stamped with the pre-auth placeholder user, the
 * single v0 execution policy, a daily schedule, and an empty graph. `bps: 0` is the neutral default
 * (the schema allows `minimum: 0`).
 */
export function newStrategyDocument(name: string): StrategyDocument {
  return {
    schema_version: SCHEMA_VERSION,
    strategy: {
      id: crypto.randomUUID(),
      version: 1,
      name,
      provenance: {
        owner: PLACEHOLDER_USER_ID,
        creator: PLACEHOLDER_USER_ID,
        contributors: [],
        visibility: 'private',
        duplicable: false,
        created_at: new Date().toISOString(),
      },
    },
    execution_policy: {
      policy: 'close_signal_next_session_open',
      valuation: 'session_close',
      transaction_costs: { model: 'bps', bps: 0 },
    },
    schedule: { kind: 'daily' },
    nodes: [],
    edges: [],
    component_refs: [],
  }
}

/** Append a new `RegisteredNode` (minted hyphen-free id, position written to `ui.position`). */
export function addNode(doc: StrategyDocument, args: AddNodeArgs): StrategyDocument {
  const next = structuredClone(doc)
  const node: RegisteredNode = {
    id: mintNodeId(),
    type_id: args.typeId,
    type_version: args.typeVersion,
    params: structuredClone(args.params),
    ui: { position: { x: args.position.x, y: args.position.y } },
  }
  next.nodes.push(node)
  return next
}

/** Remove a node AND every edge incident to it (either endpoint references the node). */
export function removeNode(doc: StrategyDocument, nodeId: string): StrategyDocument {
  const next = structuredClone(doc)
  next.nodes = next.nodes.filter((n) => n.id !== nodeId)
  next.edges = next.edges.filter((e) => e.from[0] !== nodeId && e.to[0] !== nodeId)
  return next
}

/**
 * Append an edge. NO validity/compatibility logic (that gates in the canvas, D5). We append
 * unconditionally — the canvas prevents duplicates; a naive dedupe here could silently swallow an
 * intended action.
 */
export function connect(doc: StrategyDocument, edge: EdgeSpec): StrategyDocument {
  const next = structuredClone(doc)
  next.edges.push({
    from: [edge.from[0], edge.from[1]],
    to: [edge.to[0], edge.to[1]],
  })
  return next
}

// Structural equality of two `[nodeId, port]` endpoints.
function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

/** Remove the edge matching the given (from, to) tuple; a stable identity that survives reorders. */
export function disconnect(doc: StrategyDocument, edge: EdgeSpec): StrategyDocument {
  const next = structuredClone(doc)
  next.edges = next.edges.filter(
    (e) => !(sameEndpoint(e.from, edge.from) && sameEndpoint(e.to, edge.to)),
  )
  return next
}

/** Replace a node's `params` wholesale; every other field (ui, extensions, ...) is preserved. */
export function setParams(
  doc: StrategyDocument,
  nodeId: string,
  params: NodeParams,
): StrategyDocument {
  const next = structuredClone(doc)
  const node = next.nodes.find((n) => n.id === nodeId)
  if (node !== undefined) {
    node.params = structuredClone(params)
  }
  return next
}

/**
 * Merge into a node's `ui` (used for position updates). A shallow merge preserves other ui keys
 * (e.g. `collapsed`) so a position write never wipes them — `ui.*` is preserved round-trip.
 */
export function setNodeUi(doc: StrategyDocument, nodeId: string, ui: NodeUi): StrategyDocument {
  const next = structuredClone(doc)
  const node = next.nodes.find((n) => n.id === nodeId)
  if (node !== undefined) {
    const merged: Record<string, JsonValue> = { ...(node.ui ?? {}) }
    for (const [key, value] of Object.entries(structuredClone(ui))) {
      merged[key] = value
    }
    node.ui = merged
  }
  return next
}

/** Bound dispatchers returned by {@link useStrategyDocument}. */
export interface StrategyDocumentActions {
  addNode: (args: AddNodeArgs) => void
  removeNode: (nodeId: string) => void
  connect: (edge: EdgeSpec) => void
  disconnect: (edge: EdgeSpec) => void
  setParams: (nodeId: string, params: NodeParams) => void
  setNodeUi: (nodeId: string, ui: NodeUi) => void
  replace: (doc: StrategyDocument) => void
}

/**
 * A thin React hook holding the canonical document in state and exposing bound dispatchers. The
 * PURE reducers above are the tested surface; this is only wiring (functional updates keep the
 * document a value, never a mutated reference). `replace` swaps the whole doc (load / new).
 */
export function useStrategyDocument(
  initial: StrategyDocument,
): [StrategyDocument, StrategyDocumentActions] {
  const [doc, setDoc] = useState<StrategyDocument>(initial)
  // Every updater is a FUNCTIONAL setDoc (`d => reducer(d, …)`), so the empty deps are safe — no
  // callback closes over a changing value. Keep them functional: a future edit that captures a prop
  // directly would silently read a stale value.
  const addNodeCb = useCallback((args: AddNodeArgs) => setDoc((d) => addNode(d, args)), [])
  const removeNodeCb = useCallback((nodeId: string) => setDoc((d) => removeNode(d, nodeId)), [])
  const connectCb = useCallback((edge: EdgeSpec) => setDoc((d) => connect(d, edge)), [])
  const disconnectCb = useCallback((edge: EdgeSpec) => setDoc((d) => disconnect(d, edge)), [])
  const setParamsCb = useCallback(
    (nodeId: string, params: NodeParams) => setDoc((d) => setParams(d, nodeId, params)),
    [],
  )
  const setNodeUiCb = useCallback(
    (nodeId: string, ui: NodeUi) => setDoc((d) => setNodeUi(d, nodeId, ui)),
    [],
  )
  const replaceCb = useCallback((next: StrategyDocument) => setDoc(next), [])
  // Memoize the actions object so its identity is stable across renders (a consumer may put it in
  // an effect/memo dependency list; a fresh literal each render would re-run those needlessly).
  const actions = useMemo<StrategyDocumentActions>(
    () => ({
      addNode: addNodeCb,
      removeNode: removeNodeCb,
      connect: connectCb,
      disconnect: disconnectCb,
      setParams: setParamsCb,
      setNodeUi: setNodeUiCb,
      replace: replaceCb,
    }),
    [addNodeCb, removeNodeCb, connectCb, disconnectCb, setParamsCb, setNodeUiCb, replaceCb],
  )
  return [doc, actions]
}
