// Pure, presentation-only grouping of a flat trace-event stream into per-instant nested trees
// (M11.7, D10). This MIRRORS the server's `quantize/tracing/tree.py` ordering contract exactly — it
// is the client's read-only reconstruction of the same shape, never a second source of truth and
// never a re-decision: it only regroups events the server already emitted.
//
// Contract (identical to tree.py):
//   • Identity is `(component_path, node_id)`.
//   • Hierarchy follows `component_path` PREFIXES — a component-instance node nests its children; an
//     instance in the path is materialized even if it emitted nothing (its children still nest).
//   • Sibling order = FIRST EMISSION (input order preserved; NEVER sorted). JS `Map` preserves
//     insertion order, which is exactly first-emission order.
//   • Engine-origin events (`event_type` starts with `"engine."`) are collected into their OWN root
//     (`origin: 'engine'`, nodeId = the reserved engine id), placed AFTER all node roots.
//   • Events are partitioned per instant (`timestamp`); the instants are emitted in ASCENDING
//     timestamp order — the exact analogue of tree.py's `sorted(by_instant)`. The `timestamp`s are
//     ISO-8601 UTC strings, so a lexical string sort reproduces chronological order. Only this
//     top-level instant ordering is sorted; sibling node/children order stays FIRST-EMISSION.
import type { TraceEvent } from '@quantize/quantize-api'

// Kept in lockstep with `quantize/tracing/spec.py` (ENGINE_EVENT_PREFIX / ENGINE_NODE_ID). These are
// the machine tokens of the reserved engine namespace — presentation constants, not domain types.
const ENGINE_EVENT_PREFIX = 'engine.'
const ENGINE_NODE_ID = 'engine'

/** One node (or component instance, or the engine) with its events and nested children. */
export interface TraceNode {
  nodeId: string
  componentPath: string[]
  origin: 'node' | 'engine'
  events: TraceEvent[]
  children: TraceNode[]
}

/** All events of one instant, nested by component hierarchy. */
export interface InstantTree {
  instant: string
  roots: TraceNode[]
}

// Mutable build node; `children` is a Map so insertion order == first-emission sibling order.
interface Builder {
  nodeId: string
  componentPath: string[]
  origin: 'node' | 'engine'
  events: TraceEvent[]
  children: Map<string, Builder>
}

function newBuilder(nodeId: string, componentPath: string[], origin: 'node' | 'engine'): Builder {
  return { nodeId, componentPath, origin, events: [], children: new Map() }
}

// Within one `level` (children map) the parent path is invariant, so the node id alone discriminates
// siblings — the exact `(parent_path, id)` key of tree.py, reduced to its varying component.
function freeze(builder: Builder): TraceNode {
  return {
    nodeId: builder.nodeId,
    componentPath: builder.componentPath,
    origin: builder.origin,
    events: builder.events,
    children: Array.from(builder.children.values(), freeze),
  }
}

function isEngineEvent(event: TraceEvent): boolean {
  return event.event_type.startsWith(ENGINE_EVENT_PREFIX)
}

/**
 * Group `events` (already session-filtered by the server) into per-instant trees, preserving input
 * order within each instant (first-emission sibling order) and emitting the instants in ascending
 * timestamp order (tree.py's `sorted(by_instant)`). Pure and deterministic — the client-side twin of
 * `build_trace_trees`.
 */
export function groupTrace(events: TraceEvent[]): InstantTree[] {
  // Partition by instant; instant buckets are iterated in ascending timestamp order below.
  const byInstant = new Map<string, TraceEvent[]>()
  for (const event of events) {
    const bucket = byInstant.get(event.timestamp)
    if (bucket === undefined) {
      byInstant.set(event.timestamp, [event])
    } else {
      bucket.push(event)
    }
  }

  const trees: InstantTree[] = []
  // Sort only the top-level instant keys ascending (lexical == chronological for ISO-8601 UTC),
  // mirroring tree.py's `sorted(by_instant)`. Sibling node/children order is left untouched.
  for (const instant of [...byInstant.keys()].sort()) {
    const bucket = byInstant.get(instant)!
    const nodeRoots = new Map<string, Builder>()
    let engineRoot: Builder | undefined
    for (const event of bucket) {
      if (isEngineEvent(event)) {
        if (engineRoot === undefined) {
          engineRoot = newBuilder(ENGINE_NODE_ID, [], 'engine')
        }
        engineRoot.events.push(event)
        continue
      }
      // Materialize the instance chain: ["a","b"] nests the node under instance "a" -> "b".
      let level = nodeRoots
      let parentPath: string[] = []
      for (const instanceId of event.component_path ?? []) {
        let builder = level.get(instanceId)
        if (builder === undefined) {
          builder = newBuilder(instanceId, parentPath, 'node')
          level.set(instanceId, builder)
        }
        level = builder.children
        parentPath = [...parentPath, instanceId]
      }
      let builder = level.get(event.node_id)
      if (builder === undefined) {
        builder = newBuilder(event.node_id, parentPath, 'node')
        level.set(event.node_id, builder)
      }
      builder.events.push(event)
    }
    const roots = Array.from(nodeRoots.values(), freeze)
    if (engineRoot !== undefined) {
      roots.push(freeze(engineRoot)) // engine sorts AFTER node roots (the within-instant contract)
    }
    trees.push({ instant, roots })
  }
  return trees
}
