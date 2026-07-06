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
import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  ComponentRef,
  ComponentRefNode,
  JsonValue,
  RegisteredNode,
  StrategyDocument,
} from '@quantize/quantize-ir'
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
// uuid would FAIL server validation. So we strip the hyphens and prefix a letter. Exported so the
// extraction reducer (extract.ts) mints ids by the SAME grammar rather than re-encoding it.
export function mintNodeId(): string {
  return 'n' + crypto.randomUUID().replaceAll('-', '')
}

// Mint a component-ref id. IR RefId shares NodeId's `^[A-Za-z0-9_]+$` grammar — no hyphens. Exported
// alongside mintNodeId (single owner of the id grammar).
export function mintRefId(): string {
  return 'r' + crypto.randomUUID().replaceAll('-', '')
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

/** Arguments for {@link addComponentRefNode}. */
export interface AddComponentRefArgs {
  componentId: string
  version: string
  position: Position
}

/**
 * Place a new `ComponentRefNode` (a pinned instance of a versioned component). If the document already
 * pins the same `(component_id, version)` we REUSE that `component_refs` entry (a document pins a
 * given component version once); otherwise we mint a fresh hyphen-free `RefId` and append the pin. The
 * node starts with empty `params` — the definition's authored values are the defaults; instance params
 * are per-instance overrides keyed by exposed name (added later via the Inspector).
 */
export function addComponentRefNode(
  doc: StrategyDocument,
  args: AddComponentRefArgs,
): StrategyDocument {
  const next = structuredClone(doc)
  let ref: ComponentRef | undefined = next.component_refs.find(
    (r) => r.component_id === args.componentId && r.version === args.version,
  )
  if (ref === undefined) {
    ref = { id: mintRefId(), component_id: args.componentId, version: args.version }
    next.component_refs.push(ref)
  }
  const node: ComponentRefNode = {
    id: mintNodeId(),
    type_id: 'component',
    ref: ref.id,
    params: {},
    ui: { position: { x: args.position.x, y: args.position.y } },
  }
  next.nodes.push(node)
  return next
}

/**
 * Remove a node AND every edge incident to it (either endpoint references the node), then prune any
 * `component_refs` pin no remaining node still references. Deleting a `ComponentRefNode` must not
 * leave its pin behind: the server resolves EVERY declared ref, used or not (a now-orphaned pin is
 * LIVE document content that can make validate/run fail — e.g. if that component later goes
 * missing/invalid — and is stale semantic content regardless). We recompute the used set from the
 * REMAINING nodes (`'ref' in n` is the ComponentRefNode discriminant), so a pin SHARED by two
 * instances is kept when only one is removed. Removing a registered (non-component) node changes no
 * pin's used-ness, so its refs survive untouched. Pure — operates on the clone.
 */
export function removeNode(doc: StrategyDocument, nodeId: string): StrategyDocument {
  const next = structuredClone(doc)
  next.nodes = next.nodes.filter((n) => n.id !== nodeId)
  next.edges = next.edges.filter((e) => e.from[0] !== nodeId && e.to[0] !== nodeId)
  const usedRefIds = new Set(
    next.nodes.filter((n) => 'ref' in n).map((n) => (n as ComponentRefNode).ref),
  )
  next.component_refs = next.component_refs.filter((r) => usedRefIds.has(r.id))
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
 * Increment the strategy VERSION by one, preserving every other field verbatim (D7). Save always
 * bumps the version to persist edits: a different document at an existing `(strategy_id, version)`
 * is a 409 by design, so the 409-recovery flow calls this and retries. Pure — `structuredClone`
 * deep-copies the input (no shared references, unknown/future keys carried) and only `strategy.version`
 * changes; the input is never mutated.
 */
export function bumpStrategyVersion(doc: StrategyDocument): StrategyDocument {
  const next = structuredClone(doc)
  next.strategy.version += 1
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
  /**
   * Compare-and-swap: replace the document with `next` ONLY if the live document is still `expected`
   * (the object an async writer captured before its awaits), returning whether it applied. The ONE
   * guard every async document writer shares — a stale write (the doc changed during the await window)
   * is refused without mutating anything. Synchronous writers use plain {@link replace}.
   */
  replaceIf: (expected: StrategyDocument, next: StrategyDocument) => boolean
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
  // A ref that always points at the LIVE document object, updated each render. `replaceIf` compares an
  // async writer's captured `expected` doc against `latest.current`: identity is EXACT because every
  // reducer returns a NEW object, so a mismatch means the doc was replaced/edited during the writer's
  // await window and the stale write must be refused. This is the single compare-and-swap that closes
  // the late-write clobber hole for ALL async writers (extraction commit + StrategyPanel load, …).
  const latest = useRef(doc)
  latest.current = doc
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
  const replaceIfCb = useCallback(
    (expected: StrategyDocument, next: StrategyDocument): boolean => {
      if (latest.current !== expected) {
        return false
      }
      setDoc(next)
      return true
    },
    [],
  )
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
      replaceIf: replaceIfCb,
    }),
    [addNodeCb, removeNodeCb, connectCb, disconnectCb, setParamsCb, setNodeUiCb, replaceCb, replaceIfCb],
  )
  return [doc, actions]
}
