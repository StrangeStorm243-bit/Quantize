import { describe, expect, it } from 'vitest'
import type { RegisteredNode, StrategyDocument } from '@quantize/quantize-ir'
import { PLACEHOLDER_USER_ID, SCHEMA_VERSION } from '../config'
import {
  addNode,
  connect,
  disconnect,
  newStrategyDocument,
  removeNode,
  setNodeUi,
  setParams,
} from './store'

// A typed fixture built in-code (NOT imported from tests/fixtures — cross-root import fragility).
// It deliberately carries every hard-to-preserve field so the verbatim-preservation law is proven:
// top-level `extensions`, per-node `ui` (incl. a non-position key `collapsed`) and `extensions`,
// nested-JSON params, a non-empty `component_refs`, and full provenance. Typing it against the
// GENERATED StrategyDocument means any schema change surfaces at compile time.
function makeFixture(): StrategyDocument {
  return {
    schema_version: '0.1.0',
    strategy: {
      id: '11111111-1111-1111-1111-111111111111',
      version: 3,
      name: 'Fixture',
      description: 'a doc with hard-to-preserve fields',
      provenance: {
        owner: '22222222-2222-2222-2222-222222222222',
        creator: '22222222-2222-2222-2222-222222222222',
        contributors: ['33333333-3333-3333-3333-333333333333'],
        forked_from: { id: '44444444-4444-4444-4444-444444444444', version: 2 },
        visibility: 'private',
        duplicable: false,
        created_at: '2026-06-23T00:00:00Z',
      },
    },
    execution_policy: {
      policy: 'close_signal_next_session_open',
      valuation: 'session_close',
      transaction_costs: { model: 'bps', bps: 5 },
    },
    schedule: { kind: 'monthly' },
    nodes: [
      {
        id: 'ret',
        type_id: 'transform.trailing_return',
        type_version: '1.0.0',
        params: { lookback_sessions: 126, nested: { deep: [1, 2, { k: 'v' }] } },
        ui: { position: { x: 10, y: 20 }, collapsed: true },
        extensions: { y: 1 },
      },
      {
        id: 'rk',
        type_id: 'transform.rank',
        type_version: '1.0.0',
        params: { descending: true },
        ui: { position: { x: 200, y: 20 } },
      },
    ],
    edges: [{ from: ['ret', 'values'], to: ['rk', 'values'] }],
    component_refs: [
      { id: 'c0', component_id: '55555555-5555-5555-5555-555555555555', version: '1.2.3' },
    ],
    extensions: { x_custom: { note: 'keep me' } },
  }
}

// Deep JSON snapshot for byte-equivalence + unmutated-input assertions.
function snap(doc: StrategyDocument): unknown {
  return JSON.parse(JSON.stringify(doc))
}

describe('newStrategyDocument', () => {
  it('produces a structurally valid fresh doc (version 1, uuid id, placeholder provenance, empty graph)', () => {
    const doc: StrategyDocument = newStrategyDocument('My Strategy')
    expect(doc.schema_version).toBe(SCHEMA_VERSION)
    expect(doc.strategy.version).toBe(1)
    expect(doc.strategy.name).toBe('My Strategy')
    // strategy.id is a hyphenated uuid (EntityId), NOT a node id.
    expect(doc.strategy.id).toMatch(/^[0-9a-fA-F-]{36}$/)
    expect(doc.strategy.provenance.owner).toBe(PLACEHOLDER_USER_ID)
    expect(doc.strategy.provenance.creator).toBe(PLACEHOLDER_USER_ID)
    expect(doc.strategy.provenance.contributors).toEqual([])
    expect(doc.strategy.provenance.visibility).toBe('private')
    expect(doc.strategy.provenance.duplicable).toBe(false)
    expect(typeof doc.strategy.provenance.created_at).toBe('string')
    expect(doc.execution_policy.policy).toBe('close_signal_next_session_open')
    expect(doc.execution_policy.valuation).toBe('session_close')
    expect(doc.execution_policy.transaction_costs).toEqual({ model: 'bps', bps: 0 })
    expect(doc.schedule).toEqual({ kind: 'daily' })
    expect(doc.nodes).toEqual([])
    expect(doc.edges).toEqual([])
    expect(doc.component_refs).toEqual([])
  })

  it('mints a distinct id each call', () => {
    expect(newStrategyDocument('a').strategy.id).not.toBe(newStrategyDocument('b').strategy.id)
  })
})

describe('verbatim preservation (the core law)', () => {
  it('setNodeUi changes only the target node ui and preserves every other field byte-for-byte', () => {
    const doc = makeFixture()
    const before = snap(doc)
    const result = setNodeUi(doc, 'rk', { position: { x: 999, y: 888 } })

    // Input is untouched.
    expect(snap(doc)).toEqual(before)
    expect(result).not.toBe(doc)

    // Expected == fixture with ONLY rk.ui.position changed; collapsed on ret, extensions,
    // component_refs, provenance, top-level extensions all identical.
    const expected = makeFixture()
    expected.nodes[1].ui = { position: { x: 999, y: 888 } }
    expect(snap(result)).toEqual(snap(expected))
  })

  it('setNodeUi merges into existing ui, preserving non-position keys (collapsed)', () => {
    const doc = makeFixture()
    const result = setNodeUi(doc, 'ret', { position: { x: 1, y: 2 } })
    expect(result.nodes[0].ui).toEqual({ position: { x: 1, y: 2 }, collapsed: true })
  })

  it('setParams replaces only params and preserves ui/extensions and all other fields', () => {
    const doc = makeFixture()
    const before = snap(doc)
    const result = setParams(doc, 'ret', { lookback_sessions: 63 })

    expect(snap(doc)).toEqual(before)
    const expected = makeFixture()
    expected.nodes[0].params = { lookback_sessions: 63 }
    expect(snap(result)).toEqual(snap(expected))
  })

  it('addNode preserves the whole prior document verbatim', () => {
    const doc = makeFixture()
    const before = snap(doc)
    const result = addNode(doc, {
      typeId: 'data.price',
      typeVersion: '1.0.0',
      params: {},
      position: { x: 5, y: 5 },
    })
    expect(snap(doc)).toEqual(before)
    // Prior two nodes untouched; extensions/component_refs/provenance identical.
    const r = snap(result) as StrategyDocument
    expect(r.nodes.slice(0, 2)).toEqual((before as StrategyDocument).nodes)
    expect(r.extensions).toEqual((before as StrategyDocument).extensions)
    expect(r.component_refs).toEqual((before as StrategyDocument).component_refs)
    expect(r.strategy).toEqual((before as StrategyDocument).strategy)
  })

  it('connect preserves the whole prior document verbatim', () => {
    const doc = makeFixture()
    const before = snap(doc)
    const result = connect(doc, { from: ['ret', 'values'], to: ['rk', 'other'] })
    expect(snap(doc)).toEqual(before)
    const r = snap(result) as StrategyDocument
    expect(r.nodes).toEqual((before as StrategyDocument).nodes)
    expect(r.extensions).toEqual((before as StrategyDocument).extensions)
  })

  it('a field a FUTURE codegen might add survives a round-trip through every reducer', () => {
    // The D4 guarantee rests on structuredClone + no field whitelist. Lock it against a future
    // refactor that replaces the deep copy with a reconstruction: push a genuinely-unknown key
    // (not on the current generated type — hence the localized cast) through each reducer and
    // assert it survives. If any reducer ever whitelists fields, these break loudly.
    const base = { ...makeFixture(), __future_field__: { keep: 'me' } } as unknown as StrategyDocument
    const survivors: StrategyDocument[] = [
      setNodeUi(base, 'rk', { position: { x: 1, y: 1 } }),
      setParams(base, 'ret', { lookback_sessions: 10 }),
      addNode(base, { typeId: 'data.price', typeVersion: '1.0.0', params: {}, position: { x: 0, y: 0 } }),
      connect(base, { from: ['ret', 'values'], to: ['rk', 'other'] }),
      removeNode(base, 'ret'),
      disconnect(base, { from: ['ret', 'values'], to: ['rk', 'values'] }),
    ]
    for (const doc of survivors) {
      expect((doc as unknown as Record<string, unknown>).__future_field__).toEqual({ keep: 'me' })
    }
  })
})

describe('reducer behavior', () => {
  it('addNode appends a RegisteredNode with a hyphen-free id and ui.position set', () => {
    const doc = newStrategyDocument('s')
    const result = addNode(doc, {
      typeId: 'transform.rank',
      typeVersion: '1.0.0',
      params: { descending: true },
      position: { x: 40, y: 60 },
    })
    expect(result.nodes).toHaveLength(1)
    // addNode always appends a RegisteredNode (not the reserved `component` node).
    const node = result.nodes[0] as RegisteredNode
    expect(node.id).toMatch(/^[A-Za-z0-9_]+$/)
    expect(node.id).not.toContain('-')
    expect(node.type_id).toBe('transform.rank')
    expect(node.type_version).toBe('1.0.0')
    expect(node.params).toEqual({ descending: true })
    expect(node.ui).toEqual({ position: { x: 40, y: 60 } })
  })

  it('addNode mints distinct ids', () => {
    let doc = newStrategyDocument('s')
    doc = addNode(doc, { typeId: 't', typeVersion: '1', params: {}, position: { x: 0, y: 0 } })
    doc = addNode(doc, { typeId: 't', typeVersion: '1', params: {}, position: { x: 0, y: 0 } })
    expect(doc.nodes[0].id).not.toBe(doc.nodes[1].id)
  })

  it('removeNode drops the node and every incident edge', () => {
    const doc = makeFixture()
    // Add a second edge so we can prove only incident edges are dropped.
    const doc2 = connect(doc, { from: ['rk', 'out'], to: ['ret', 'in'] })
    const result = removeNode(doc2, 'rk')
    expect(result.nodes.map((n) => n.id)).toEqual(['ret'])
    // Both edges touched rk → both gone.
    expect(result.edges).toEqual([])
  })

  it('removeNode keeps edges not incident to the removed node', () => {
    const doc = newStrategyDocument('s')
    const a = addNode(doc, { typeId: 't', typeVersion: '1', params: {}, position: { x: 0, y: 0 } })
    const withB = addNode(a, { typeId: 't', typeVersion: '1', params: {}, position: { x: 0, y: 0 } })
    const withC = addNode(withB, { typeId: 't', typeVersion: '1', params: {}, position: { x: 0, y: 0 } })
    const [n1, n2, n3] = withC.nodes.map((n) => n.id)
    let g = connect(withC, { from: [n1, 'o'], to: [n2, 'i'] })
    g = connect(g, { from: [n2, 'o'], to: [n3, 'i'] })
    const result = removeNode(g, n1)
    expect(result.edges).toEqual([{ from: [n2, 'o'], to: [n3, 'i'] }])
  })

  it('connect appends an edge', () => {
    const doc = makeFixture()
    const result = connect(doc, { from: ['ret', 'values'], to: ['rk', 'x'] })
    expect(result.edges).toHaveLength(2)
    expect(result.edges[1]).toEqual({ from: ['ret', 'values'], to: ['rk', 'x'] })
  })

  it('disconnect removes the edge matching the (from,to) tuple', () => {
    const doc = makeFixture()
    const two = connect(doc, { from: ['ret', 'a'], to: ['rk', 'b'] })
    const result = disconnect(two, { from: ['ret', 'values'], to: ['rk', 'values'] })
    expect(result.edges).toEqual([{ from: ['ret', 'a'], to: ['rk', 'b'] }])
  })

  it('setParams replaces the whole params object', () => {
    const doc = makeFixture()
    const result = setParams(doc, 'rk', { descending: false, extra: 1 })
    expect(result.nodes[1].params).toEqual({ descending: false, extra: 1 })
  })
})
