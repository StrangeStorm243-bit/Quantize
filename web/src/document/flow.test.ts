import { describe, expect, it } from 'vitest'
import type { NodeCatalogResponse } from '@quantize/quantize-api'
import type { ComponentDefinition, Graph, StrategyDocument } from '@quantize/quantize-ir'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import {
  componentCacheKey,
  findComponentRef,
  resolveComponentDef,
  resolveTrailFromPath,
  resolveUniverseTickers,
  toFlow,
} from './flow'

const catalog = catalogJson as unknown as NodeCatalogResponse

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

  it('degrades to a bare component node WITHOUT a components map (still flagged a component)', () => {
    const { nodes } = toFlow(makeComponentDoc())
    const mom = nodes.find((n) => n.id === 'mom')
    // A ComponentRefNode is a component even before its definition loads: the variant flag + version
    // chip come from the pinned REF (always present), not the fetched definition.
    expect(mom?.data).toEqual({ typeId: 'component', isComponent: true, version: DEF.version })
  })

  it('degrades to a bare component node on a cache MISS (map present but key absent)', () => {
    const { nodes } = toFlow(makeComponentDoc(), undefined, new Map())
    const mom = nodes.find((n) => n.id === 'mom')
    expect(mom?.data).toEqual({ typeId: 'component', isComponent: true, version: DEF.version })
  })
})

// M13.4 legibility enrichment: served category, a param-summary line for the card face, the resolved
// data-source universe, the component variant flag, and typed-edge coloring. All are DOC/CATALOG
// projections (no App state) — the App overlays only run-derived validity onto the node data later.
describe('toFlow M13.4 enrichment', () => {
  it('carries the served category for a registered node (when a catalog is given)', () => {
    const { nodes } = toFlow(makeDoc(), catalog)
    const ret = nodes.find((n) => n.id === 'ret')
    const rk = nodes.find((n) => n.id === 'rk')
    expect(ret?.data.category).toBe('transform')
    // transform.rank is authored `selection`, NOT its `transform.*` namespace (D-14).
    expect(rk?.data.category).toBe('selection')
  })

  it('leaves category undefined for an unknown/future type (neutral fallback happens in the view)', () => {
    const doc = makeDoc()
    const withUnknown: StrategyDocument = {
      ...doc,
      nodes: [...doc.nodes, { id: 'x', type_id: 'future.node', type_version: '9.9.9', params: {} }],
    }
    const { nodes } = toFlow(withUnknown, catalog)
    expect(nodes.find((n) => n.id === 'x')?.data.category).toBeUndefined()
  })

  it('formats a scalar param into a summary line', () => {
    const doc = makeDoc()
    const withParam: StrategyDocument = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === 'ret' ? { ...n, params: { lookback_sessions: 63 } } : n,
      ),
    }
    const { nodes } = toFlow(withParam, catalog)
    expect(nodes.find((n) => n.id === 'ret')?.data.paramSummary).toBe('lookback_sessions = 63')
  })

  it('summarizes a boolean param and truncates a long array param', () => {
    let doc = makeDoc()
    doc = {
      ...doc,
      nodes: [
        ...doc.nodes,
        {
          id: 'u',
          type_id: 'universe.fixed_list',
          type_version: '1.0.0',
          params: { tickers: ['EFA', 'GLD', 'IWM', 'QQQ', 'SPY', 'TLT'] },
        },
        { id: 'rk2', type_id: 'transform.rank', type_version: '1.0.0', params: { descending: true } },
      ],
    }
    const { nodes } = toFlow(doc, catalog)
    expect(nodes.find((n) => n.id === 'u')?.data.paramSummary).toBe('tickers = [EFA, GLD, IWM, +3]')
    expect(nodes.find((n) => n.id === 'rk2')?.data.paramSummary).toBe('descending = true')
  })

  it('omits the param summary when a node has no params', () => {
    const { nodes } = toFlow(makeDoc(), catalog) // makeDoc nodes carry params: {}
    expect(nodes.find((n) => n.id === 'ret')?.data.paramSummary).toBeUndefined()
  })

  it('resolves a data node universe from the connected universe node params', () => {
    // u(universe.fixed_list, tickers) → px(data.price).assets  — the demo wiring.
    const doc: StrategyDocument = {
      ...makeDoc(),
      nodes: [
        {
          id: 'u',
          type_id: 'universe.fixed_list',
          type_version: '1.0.0',
          params: { tickers: ['SPY', 'QQQ'] },
        },
        { id: 'px', type_id: 'data.price', type_version: '1.0.0', params: {} },
      ],
      edges: [{ from: ['u', 'assets'], to: ['px', 'assets'] }],
    }
    const { nodes } = toFlow(doc, catalog)
    const px = nodes.find((n) => n.id === 'px')
    expect(px?.data.category).toBe('data')
    expect(px?.data.universeTickers).toEqual(['SPY', 'QQQ'])
  })

  it('does NOT resolve a data universe from a non-universe source carrying a tickers param (PX-5)', () => {
    // transform.rank (category `selection`) carries a `tickers` param and feeds the data node. Duck-
    // typing on the param name would wrongly resolve it; category-gating rejects it → null (unbound).
    const doc: StrategyDocument = {
      ...makeDoc(),
      nodes: [
        {
          id: 'rk',
          type_id: 'transform.rank',
          type_version: '1.0.0',
          params: { tickers: ['SPY', 'QQQ'] },
        },
        { id: 'px', type_id: 'data.price', type_version: '1.0.0', params: {} },
      ],
      edges: [{ from: ['rk', 'values'], to: ['px', 'assets'] }],
    }
    const { nodes } = toFlow(doc, catalog)
    expect(nodes.find((n) => n.id === 'px')?.data.universeTickers).toBeNull()
  })

  it('marks a data node universe null when nothing feeds its asset input', () => {
    const doc: StrategyDocument = {
      ...makeDoc(),
      nodes: [{ id: 'px', type_id: 'data.price', type_version: '1.0.0', params: {} }],
      edges: [],
    }
    const { nodes } = toFlow(doc, catalog)
    const px = nodes.find((n) => n.id === 'px')
    expect(px?.data.universeTickers).toBeNull()
  })

  it('colors an edge by the port type it carries (className + stroke), given a catalog', () => {
    // ret(out values: CrossSection[Number]) → rk(in values): the edge carries CrossSection[Number].
    const { edges } = toFlow(makeDoc(), catalog)
    const e = edges[0]
    expect(e.className).toContain('sedge--cross-section-number')
    expect((e.style as { stroke?: string } | undefined)?.stroke).toBe('var(--port-cross-section-number)')
  })

  it('leaves edges uncolored without a catalog (M11.3 posture preserved)', () => {
    const { edges } = toFlow(makeDoc())
    expect(edges[0].className).toBeUndefined()
    expect(edges[0].style).toBeUndefined()
  })
})

// PX-3: a node card's hover tooltip is the served description — from the catalog for a registered node,
// from the resolved definition for a component (absent when the definition carries none).
describe('toFlow PX-3 description enrichment', () => {
  it('enriches a registered node with the catalog description', () => {
    const { nodes } = toFlow(makeDoc(), catalog)
    const retType = catalog.node_types.find((n) => n.type_id === 'transform.trailing_return')
    expect(retType?.description).toBeTruthy() // guard: the fixture carries a real description
    expect(nodes.find((n) => n.id === 'ret')?.data.description).toBe(retType?.description)
  })

  it('leaves description absent for an unknown/future type', () => {
    const doc = makeDoc()
    const withUnknown: StrategyDocument = {
      ...doc,
      nodes: [...doc.nodes, { id: 'x', type_id: 'future.node', type_version: '9.9.9', params: {} }],
    }
    const { nodes } = toFlow(withUnknown, catalog)
    expect(nodes.find((n) => n.id === 'x')?.data.description).toBeUndefined()
  })

  it('leaves description absent without a catalog', () => {
    const { nodes } = toFlow(makeDoc())
    expect(nodes.find((n) => n.id === 'ret')?.data.description).toBeUndefined()
  })

  it('carries a component definition description when present', () => {
    const withDesc: ComponentDefinition = { ...DEF, description: 'Ranks a series, picks the top slice.' }
    const components = new Map([[componentCacheKey(DEF.component_id, DEF.version), withDesc]])
    const { nodes } = toFlow(makeComponentDoc(), undefined, components)
    expect(nodes.find((n) => n.id === 'mom')?.data.description).toBe('Ranks a series, picks the top slice.')
  })

  it('leaves description absent for a component whose definition has none (null)', () => {
    // DEF.description is null → no tooltip for the component card.
    const components = new Map([[componentCacheKey(DEF.component_id, DEF.version), DEF]])
    const { nodes } = toFlow(makeComponentDoc(), undefined, components)
    expect(nodes.find((n) => n.id === 'mom')?.data.description).toBeUndefined()
  })
})

// PX-5: the universe a data node shows must come from a genuine `universe`-category source, not any
// upstream node that happens to carry a `tickers` param. The gate is an injected predicate over the
// SOURCE node's served category (a served-catalog string comparison — no client type logic).
describe('resolveUniverseTickers (PX-5: category-gated source)', () => {
  const isUniverse = (typeId: string): boolean => typeId === 'universe.fixed_list'

  it('resolves tickers from a universe-category source feeding the data node', () => {
    const doc = {
      nodes: [
        { id: 'u', type_id: 'universe.fixed_list', params: { tickers: ['SPY', 'QQQ'] } },
        { id: 'px', type_id: 'data.price', params: {} },
      ],
      edges: [{ from: ['u', 'assets'], to: ['px', 'assets'] }],
    } as unknown as Pick<StrategyDocument, 'nodes' | 'edges'>
    expect(resolveUniverseTickers(doc, 'px', isUniverse)).toEqual(['SPY', 'QQQ'])
  })

  it('returns null for a non-universe source even when it carries a tickers param', () => {
    const doc = {
      nodes: [
        { id: 'rk', type_id: 'transform.rank', params: { tickers: ['SPY', 'QQQ'] } },
        { id: 'px', type_id: 'data.price', params: {} },
      ],
      edges: [{ from: ['rk', 'out'], to: ['px', 'assets'] }],
    } as unknown as Pick<StrategyDocument, 'nodes' | 'edges'>
    expect(resolveUniverseTickers(doc, 'px', isUniverse)).toBeNull()
  })

  it('returns null for a ComponentRef source (no catalog category)', () => {
    const doc = {
      nodes: [
        { id: 'c', type_id: 'component', ref: 'r1', params: { tickers: ['SPY'] } },
        { id: 'px', type_id: 'data.price', params: {} },
      ],
      edges: [{ from: ['c', 'assets'], to: ['px', 'assets'] }],
    } as unknown as Pick<StrategyDocument, 'nodes' | 'edges'>
    expect(resolveUniverseTickers(doc, 'px', isUniverse)).toBeNull()
  })
})

// M13.8 breadcrumb resolution: a served trace `component_path` (ComponentRef INSTANCE node ids,
// outermost first) → the pinned identity of each entered component, walking doc → definition →
// definition and swapping the ref scope per level. A pure lookup — nothing is fetched here.
describe('resolveTrailFromPath', () => {
  const CID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const CID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

  // A graph-kind definition with the given nodes + def-level component_refs (nested refs resolve here).
  function makeGraphDef(
    componentId: string,
    version: string,
    nodes: Graph['nodes'],
    componentRefs: ComponentDefinition['component_refs'],
  ): ComponentDefinition {
    return {
      ...DEF,
      component_id: componentId,
      version,
      component_refs: componentRefs,
      implementation: { kind: 'graph', graph: { nodes, edges: [] } },
    }
  }

  // Definition A embeds a nested ComponentRefNode `inner` pointing at definition B via def-level r2.
  const DEF_A = makeGraphDef(
    CID_A,
    '1.0.0',
    [{ id: 'inner', type_id: 'component', ref: 'r2', params: {} }],
    [{ id: 'r2', component_id: CID_B, version: '2.0.0' }],
  )
  const DEF_B = makeGraphDef(CID_B, '2.0.0', [], [])

  // The top-level doc: `mom` is a ComponentRefNode instancing definition A via doc-level r1.
  const doc: Pick<StrategyDocument, 'nodes' | 'component_refs'> = {
    nodes: [
      { id: 'ret', type_id: 'transform.trailing_return', type_version: '1.0.0', params: {} },
      { id: 'mom', type_id: 'component', ref: 'r1', params: {} },
    ],
    component_refs: [{ id: 'r1', component_id: CID_A, version: '1.0.0' }],
  }

  const fullMap = new Map([
    [componentCacheKey(CID_A, '1.0.0'), DEF_A],
    [componentCacheKey(CID_B, '2.0.0'), DEF_B],
  ])

  it('resolves a single-level path to the entered component identity', () => {
    expect(resolveTrailFromPath(doc, ['mom'], fullMap)).toEqual([
      { componentId: CID_A, version: '1.0.0' },
    ])
  })

  it('resolves a nested path, swapping ref scope per level', () => {
    expect(resolveTrailFromPath(doc, ['mom', 'inner'], fullMap)).toEqual([
      { componentId: CID_A, version: '1.0.0' },
      { componentId: CID_B, version: '2.0.0' },
    ])
  })

  it('returns the ref-proven prefix when the tip definition is a cache miss', () => {
    // Definition A absent: the ref alone proves level 1, but its body is unknown so the walk cannot
    // continue into `inner`. The tip is what the view ensures + loads next.
    const onlyB = new Map([[componentCacheKey(CID_B, '2.0.0'), DEF_B]])
    expect(resolveTrailFromPath(doc, ['mom', 'inner'], onlyB)).toEqual([
      { componentId: CID_A, version: '1.0.0' },
    ])
  })

  it('stops at a non-graph implementation kind (body exists but is not a navigable graph)', () => {
    // Definition A cached but with a non-`graph` implementation: the ref proves level 1, yet its body
    // is not a graph to descend into, so the walk stops exactly like the cache-miss sibling. The cast
    // synthesizes a kind the generated GraphImplementation type does not (yet) admit.
    const nonGraphA: ComponentDefinition = {
      ...DEF_A,
      implementation: { kind: 'sandboxed' } as unknown as ComponentDefinition['implementation'],
    }
    const map = new Map([
      [componentCacheKey(CID_A, '1.0.0'), nonGraphA],
      [componentCacheKey(CID_B, '2.0.0'), DEF_B],
    ])
    expect(resolveTrailFromPath(doc, ['mom', 'inner'], map)).toEqual([
      { componentId: CID_A, version: '1.0.0' },
    ])
  })

  it('stops at a plain registered node (not a component)', () => {
    expect(resolveTrailFromPath(doc, ['ret'], fullMap)).toEqual([])
  })

  it('stops at a component node whose ref id is unknown', () => {
    const orphan: Pick<StrategyDocument, 'nodes' | 'component_refs'> = {
      nodes: [{ id: 'mom', type_id: 'component', ref: 'nope', params: {} }],
      component_refs: [],
    }
    expect(resolveTrailFromPath(orphan, ['mom'], fullMap)).toEqual([])
  })

  it('returns [] for an empty path', () => {
    expect(resolveTrailFromPath(doc, [], fullMap)).toEqual([])
  })
})
