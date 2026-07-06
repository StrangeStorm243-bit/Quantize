import { describe, expect, it } from 'vitest'
import type { ComponentDefinition, StrategyDocument } from '@quantize/quantize-ir'
import { componentCacheKey, findComponentRef, resolveComponentDef, toFlow } from './flow'

// A minimal component definition used to exercise the ComponentRefNode enrichment path.
const DEF: ComponentDefinition = {
  schema_version: '0.1.0',
  component_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  version: '1.0.0',
  name: 'Momentum Selector',
  description: null,
  component_refs: [],
  implementation: { kind: 'graph', graph: { nodes: [], edges: [] } },
  exposed_inputs: [
    { name: 'series', type: { kind: 'TimeSeries', dtype: 'Number' }, maps_to: ['ret', 'series'] },
    { name: 'universe', type: { kind: 'AssetSet' }, maps_to: ['sel', 'universe'] },
  ],
  exposed_outputs: [{ name: 'assets', type: { kind: 'AssetSet' }, maps_to: ['sel', 'assets'] }],
  exposed_params: [],
  provenance: {
    owner: '22222222-2222-2222-2222-222222222222',
    creator: '22222222-2222-2222-2222-222222222222',
    contributors: [],
    visibility: 'private',
    duplicable: false,
    created_at: '2026-06-23T00:00:00Z',
    forked_from: null,
  },
}

// A document carrying a pinned component ref + a ComponentRefNode instance of it.
function makeComponentDoc(): StrategyDocument {
  const base = makeDoc()
  return {
    ...base,
    nodes: [...base.nodes, { id: 'mom', type_id: 'component', ref: 'r1', params: {} }],
    component_refs: [{ id: 'r1', component_id: DEF.component_id, version: DEF.version }],
  }
}

function makeDoc(): StrategyDocument {
  return {
    schema_version: '0.1.0',
    strategy: {
      id: '11111111-1111-1111-1111-111111111111',
      version: 1,
      name: 'Flow fixture',
      provenance: {
        owner: '22222222-2222-2222-2222-222222222222',
        creator: '22222222-2222-2222-2222-222222222222',
        contributors: [],
        visibility: 'private',
        duplicable: false,
        created_at: '2026-06-23T00:00:00Z',
      },
    },
    execution_policy: {
      policy: 'close_signal_next_session_open',
      valuation: 'session_close',
      transaction_costs: { model: 'bps', bps: 0 },
    },
    schedule: { kind: 'daily' },
    nodes: [
      {
        id: 'ret',
        type_id: 'transform.trailing_return',
        type_version: '1.0.0',
        params: {},
        ui: { position: { x: 10, y: 20 } },
      },
      // No ui → must get a deterministic grid position.
      { id: 'rk', type_id: 'transform.rank', type_version: '1.0.0', params: {} },
    ],
    edges: [{ from: ['ret', 'values'], to: ['rk', 'values'] }],
    component_refs: [],
  }
}

describe('toFlow', () => {
  it('maps every IR node and edge', () => {
    const { nodes, edges } = toFlow(makeDoc())
    expect(nodes).toHaveLength(2)
    expect(edges).toHaveLength(1)
  })

  it('reads position from ui.position and carries typeId in data', () => {
    const { nodes } = toFlow(makeDoc())
    expect(nodes[0].id).toBe('ret')
    expect(nodes[0].position).toEqual({ x: 10, y: 20 })
    expect(nodes[0].data.typeId).toBe('transform.trailing_return')
  })

  it('default-positions nodes lacking ui.position on a deterministic grid', () => {
    const { nodes } = toFlow(makeDoc())
    // Index 1, grid { x: (i%4)*220, y: floor(i/4)*140 } → { x: 220, y: 0 }.
    expect(nodes[1].position).toEqual({ x: 220, y: 0 })
  })

  it('derives edge id, source/target and handles from from/to', () => {
    const { edges } = toFlow(makeDoc())
    const e = edges[0]
    expect(e.id).toBe('ret:values->rk:values#0')
    expect(e.source).toBe('ret')
    expect(e.target).toBe('rk')
    expect(e.sourceHandle).toBe('values')
    expect(e.targetHandle).toBe('values')
  })

  it('gives structurally-identical edges distinct RF ids (unique React keys)', () => {
    const doc = makeDoc()
    // A loaded doc could carry two identical {from,to} edges; the derived ids must still differ.
    const twin = doc.edges[0]
    const withDup = { ...doc, edges: [twin, { from: twin.from, to: twin.to }] }
    const { edges } = toFlow(withDup)
    expect(edges[0].id).not.toBe(edges[1].id)
    expect(new Set(edges.map((e) => e.id)).size).toBe(2)
  })

  it('is read-only — never mutates the doc', () => {
    const doc = makeDoc()
    const before = JSON.parse(JSON.stringify(doc))
    toFlow(doc)
    expect(JSON.parse(JSON.stringify(doc))).toEqual(before)
  })
})

// The single shared ref→definition resolution used by render (toFlow), connect (decideConnection) and
// inspect (the Inspector). These lock in the two-step contract so the three sites can never diverge.
describe('findComponentRef / resolveComponentDef', () => {
  const REFS = makeComponentDoc().component_refs

  it('findComponentRef returns the pinned ref by its node-local id', () => {
    expect(findComponentRef(REFS, 'r1')).toEqual({
      id: 'r1',
      component_id: DEF.component_id,
      version: DEF.version,
    })
  })

  it('findComponentRef returns undefined for an unknown ref id or absent refs', () => {
    expect(findComponentRef(REFS, 'nope')).toBeUndefined()
    expect(findComponentRef(undefined, 'r1')).toBeUndefined()
  })

  it('resolveComponentDef resolves ref → cache key → definition', () => {
    const components = new Map([[componentCacheKey(DEF.component_id, DEF.version), DEF]])
    expect(resolveComponentDef(REFS, 'r1', components)).toBe(DEF)
  })

  it('resolveComponentDef returns undefined on an unknown ref', () => {
    const components = new Map([[componentCacheKey(DEF.component_id, DEF.version), DEF]])
    expect(resolveComponentDef(REFS, 'nope', components)).toBeUndefined()
  })

  it('resolveComponentDef returns undefined on a cache miss (map present, key absent)', () => {
    expect(resolveComponentDef(REFS, 'r1', new Map())).toBeUndefined()
    expect(resolveComponentDef(REFS, 'r1', undefined)).toBeUndefined()
  })

  it('is the SAME resolution the render path (toFlow) uses for the same node', () => {
    // Whatever definition toFlow enriches a ComponentRefNode from must be exactly what the shared
    // helper returns — one resolution path for render and (via the helper) connect + inspect.
    const components = new Map([[componentCacheKey(DEF.component_id, DEF.version), DEF]])
    const def = resolveComponentDef(REFS, 'r1', components)
    const { nodes } = toFlow(makeComponentDoc(), undefined, components)
    const mom = nodes.find((n) => n.id === 'mom')
    expect(mom?.data.displayName).toBe(def?.name)
  })
})

describe('toFlow component enrichment', () => {
  it('resolves a ComponentRefNode via the components map → name + exposed ports', () => {
    const components = new Map([[componentCacheKey(DEF.component_id, DEF.version), DEF]])
    const { nodes } = toFlow(makeComponentDoc(), undefined, components)
    const mom = nodes.find((n) => n.id === 'mom')
    expect(mom).toBeDefined()
    expect(mom?.data.displayName).toBe('Momentum Selector')
    // Every exposed input is required (the top-level preflight requires all of them connected).
    expect(mom?.data.inputs).toEqual([
      { name: 'series', port_type: { kind: 'TimeSeries', dtype: 'Number' }, required: true },
      { name: 'universe', port_type: { kind: 'AssetSet' }, required: true },
    ])
    expect(mom?.data.outputs).toEqual([{ name: 'assets', port_type: { kind: 'AssetSet' } }])
  })

  it('degrades to a bare {typeId:"component"} node WITHOUT a components map', () => {
    const { nodes } = toFlow(makeComponentDoc())
    const mom = nodes.find((n) => n.id === 'mom')
    expect(mom?.data).toEqual({ typeId: 'component' })
  })

  it('degrades to a bare node on a cache MISS (map present but key absent)', () => {
    const { nodes } = toFlow(makeComponentDoc(), undefined, new Map())
    const mom = nodes.find((n) => n.id === 'mom')
    expect(mom?.data).toEqual({ typeId: 'component' })
  })
})
