// groupTrace mirrors the server's tree.py ordering contract as PRESENTATION only (D10): component
// nesting by component_path prefix, first-emission sibling order (never sorted), engine root after
// node roots, and per-instant partitioning preserving first-seen instant order.
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '@quantize/quantize-api'
import { groupTrace } from './group'

// A minimal typed literal (not the full golden) covering the shapes the algorithm must honor: a
// component-instance nesting case, an engine-origin event, sibling order, and two instants.
function event(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    run_id: 'run-1',
    timestamp: '2026-05-15T21:00:00+00:00',
    node_id: 'n',
    event_type: 'select.selected',
    payload: { v: 1 },
    ...overrides,
  }
}

describe('groupTrace', () => {
  it('nests a component-path child under its component-instance root', () => {
    // "ret" lives inside component instance "mom"; the top-level node "u" is a plain root.
    const events = [
      event({ node_id: 'u', component_path: [], event_type: 'universe.selected' }),
      event({ node_id: 'ret', component_path: ['mom'], event_type: 'transform.computed' }),
    ]
    const [tree] = groupTrace(events)

    expect(tree.instant).toBe('2026-05-15T21:00:00+00:00')
    // Two roots: the plain node "u" and the materialized component instance "mom".
    expect(tree.roots.map((r) => r.nodeId)).toEqual(['u', 'mom'])
    const mom = tree.roots[1]
    // "mom" is materialized even though it emitted NOTHING; its child is the real emitter "ret".
    expect(mom.events).toHaveLength(0)
    expect(mom.componentPath).toEqual([])
    expect(mom.children.map((c) => c.nodeId)).toEqual(['ret'])
    expect(mom.children[0].componentPath).toEqual(['mom'])
    expect(mom.children[0].events).toHaveLength(1)
  })

  it('places engine-origin events in a separate engine root AFTER the node roots', () => {
    const events = [
      event({ node_id: 'tp', event_type: 'targets.finalized' }),
      event({ node_id: 'engine', event_type: 'engine.orders_proposed' }),
    ]
    const [tree] = groupTrace(events)

    expect(tree.roots.map((r) => r.origin)).toEqual(['node', 'engine'])
    // Engine root is LAST — the within-instant ordering contract, even had it emitted first.
    const engineRoot = tree.roots[tree.roots.length - 1]
    expect(engineRoot.origin).toBe('engine')
    expect(engineRoot.nodeId).toBe('engine')
    expect(engineRoot.events[0].event_type).toBe('engine.orders_proposed')
  })

  it('separates engine events even when a strategy node happens to be named "engine"', () => {
    // A node literally named "engine" but with a NON-engine event_type stays a node root; only the
    // reserved "engine." event-type prefix routes to the engine root.
    const events = [
      event({ node_id: 'engine', component_path: [], event_type: 'rank.assigned' }),
      event({ node_id: 'engine', component_path: [], event_type: 'engine.note' }),
    ]
    const [tree] = groupTrace(events)

    expect(tree.roots).toHaveLength(2)
    expect(tree.roots[0].origin).toBe('node')
    expect(tree.roots[0].events[0].event_type).toBe('rank.assigned')
    expect(tree.roots[1].origin).toBe('engine')
    expect(tree.roots[1].events[0].event_type).toBe('engine.note')
  })

  it('preserves first-emission sibling order (never sorts by node id)', () => {
    // Emitted z, a, m — the tree must keep that order, NOT alphabetize.
    const events = [
      event({ node_id: 'z', event_type: 'targets.finalized' }),
      event({ node_id: 'a', event_type: 'universe.selected' }),
      event({ node_id: 'm', event_type: 'rank.assigned' }),
    ]
    const [tree] = groupTrace(events)
    expect(tree.roots.map((r) => r.nodeId)).toEqual(['z', 'a', 'm'])
  })

  it('partitions multiple instants and emits them in ascending timestamp order', () => {
    const events = [
      event({ timestamp: '2026-05-15T21:00:00+00:00', node_id: 'u' }),
      event({ timestamp: '2026-05-16T21:00:00+00:00', node_id: 'u' }),
      event({ timestamp: '2026-05-15T21:00:00+00:00', node_id: 'tp' }),
    ]
    const trees = groupTrace(events)
    expect(trees.map((t) => t.instant)).toEqual([
      '2026-05-15T21:00:00+00:00',
      '2026-05-16T21:00:00+00:00',
    ])
    // The two same-instant events land under the first tree; the second instant has one.
    expect(trees[0].roots.map((r) => r.nodeId)).toEqual(['u', 'tp'])
    expect(trees[1].roots.map((r) => r.nodeId)).toEqual(['u'])
  })

  it('sorts instants ascending even when they arrive out of chronological order', () => {
    // Instants arrive latest-first; groupTrace must reorder them ascending (tree.py's
    // `sorted(by_instant)`), while sibling order WITHIN each instant stays first-emission.
    const events = [
      event({ timestamp: '2026-05-17T21:00:00+00:00', node_id: 'z' }),
      event({ timestamp: '2026-05-15T21:00:00+00:00', node_id: 'a' }),
      event({ timestamp: '2026-05-16T21:00:00+00:00', node_id: 'm' }),
      event({ timestamp: '2026-05-15T21:00:00+00:00', node_id: 'b' }),
    ]
    const trees = groupTrace(events)
    expect(trees.map((t) => t.instant)).toEqual([
      '2026-05-15T21:00:00+00:00',
      '2026-05-16T21:00:00+00:00',
      '2026-05-17T21:00:00+00:00',
    ])
    // Within the earliest instant, siblings keep emission order (a before b), NOT sorted.
    expect(trees[0].roots.map((r) => r.nodeId)).toEqual(['a', 'b'])
  })

  it('returns no trees for an empty event list', () => {
    expect(groupTrace([])).toEqual([])
  })
})
