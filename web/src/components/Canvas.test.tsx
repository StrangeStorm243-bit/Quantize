import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from '@xyflow/react'
import type { NodeCatalogResponse } from '@quantize/quantize-api'
import type { ComponentDefinition, StrategyDocument } from '@quantize/quantize-ir'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import { addNode, connect, newStrategyDocument } from '../document/store'
import type { StrategyDocumentActions } from '../document/store'
import { buildCompatibilitySet, CatalogProvider } from '../catalog'
import { ComponentsProvider, componentCacheKey } from '../components-cache'
import { Canvas, decideConnection } from './Canvas'

const catalog = catalogJson as unknown as NodeCatalogResponse
// The memoized allow-set the component threads into `decideConnection`; here we build it once.
const compatSet = buildCompatibilitySet(catalog)

// No network in tests: the CatalogProvider's fetch resolves to the committed golden.
vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return { getNodeCatalog: () => Promise.resolve(json) }
})

// A minimal component definition + a doc that instantiates it, for the component-connection tests.
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
  ],
  exposed_outputs: [{ name: 'assets', type: { kind: 'AssetSet' }, maps_to: ['sel', 'assets'] }],
  exposed_params: [],
  provenance: {
    owner: '00000000-0000-0000-0000-000000000001',
    creator: '00000000-0000-0000-0000-000000000001',
    contributors: [],
    visibility: 'private',
    duplicable: false,
    created_at: '2026-07-06T00:00:00Z',
    forked_from: null,
  },
}

// A price node (out "series": TimeSeries[Number]) feeding a component instance whose exposed input
// "series" is TimeSeries[Number] — an allowed pair via the same allow-set.
function buildComponentDoc(): { doc: StrategyDocument; priceId: string } {
  let doc = newStrategyDocument('t')
  doc = addNode(doc, {
    typeId: 'data.price',
    typeVersion: '1.0.0',
    params: {},
    position: { x: 0, y: 0 },
  })
  const priceId = doc.nodes[0].id
  doc = {
    ...doc,
    component_refs: [{ id: 'r1', component_id: DEF.component_id, version: DEF.version }],
    nodes: [...doc.nodes, { id: 'mom', type_id: 'component', ref: 'r1', params: {} }],
  }
  return { doc, priceId }
}

afterEach(() => {
  vi.clearAllMocks()
})

// A two-node document: trailing_return (out "values": CrossSection[Number]) → rank (in "values":
// CrossSection[Number]) is an ALLOWED pair; data.price (out "series": TimeSeries[Number]) → rank is
// DISALLOWED. Ids are minted by addNode, so we read them back from the built doc.
function buildDoc(): {
  doc: StrategyDocument
  returnId: string
  rankId: string
  priceId: string
} {
  let doc = newStrategyDocument('t')
  doc = addNode(doc, {
    typeId: 'transform.trailing_return',
    typeVersion: '1.0.0',
    params: {},
    position: { x: 0, y: 0 },
  })
  doc = addNode(doc, {
    typeId: 'transform.rank',
    typeVersion: '1.0.0',
    params: {},
    position: { x: 200, y: 0 },
  })
  doc = addNode(doc, {
    typeId: 'data.price',
    typeVersion: '1.0.0',
    params: {},
    position: { x: 0, y: 200 },
  })
  const [ret, rank, price] = doc.nodes
  return { doc, returnId: ret.id, rankId: rank.id, priceId: price.id }
}

describe('decideConnection', () => {
  it('allows a compatible pair and yields the IR edge', () => {
    const { doc, returnId, rankId } = buildDoc()
    const connection: Connection = {
      source: returnId,
      target: rankId,
      sourceHandle: 'values',
      targetHandle: 'values',
    }
    const decision = decideConnection(catalog, compatSet, doc, connection)
    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      expect(decision.edge).toEqual({ from: [returnId, 'values'], to: [rankId, 'values'] })
    }
  })

  it('rejects an incompatible pair with the composed LABEL message', () => {
    const { doc, priceId, rankId } = buildDoc()
    const connection: Connection = {
      source: priceId,
      target: rankId,
      sourceHandle: 'series',
      targetHandle: 'values',
    }
    const decision = decideConnection(catalog, compatSet, doc, connection)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toBe(
        'TimeSeries[Number] → CrossSection[Number] is not an allowed connection',
      )
    }
  })

  it('rejects a DUPLICATE of an existing edge (the canvas is the dedupe layer)', () => {
    let { doc, returnId, rankId } = buildDoc()
    const connection: Connection = {
      source: returnId,
      target: rankId,
      sourceHandle: 'values',
      targetHandle: 'values',
    }
    // First: the pair is allowed on an empty edge list.
    expect(decideConnection(catalog, compatSet, doc, connection).allowed).toBe(true)
    // Seed the identical edge into the doc, then a repeat drag must be rejected.
    doc = connect(doc, { from: [returnId, 'values'], to: [rankId, 'values'] })
    const decision = decideConnection(catalog, compatSet, doc, connection)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('already connected')
    }
  })

  it('rejects gracefully when a handle does not resolve to a port', () => {
    const { doc, returnId, rankId } = buildDoc()
    const decision = decideConnection(catalog, compatSet, doc, {
      source: returnId,
      target: rankId,
      sourceHandle: 'does_not_exist',
      targetHandle: 'values',
    })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('unknown port')
    }
  })

  it('rejects gracefully when a node type is not in the catalog', () => {
    // A node whose type_id resolves to no catalog entry (an unknown/future type).
    const doc = addNode(newStrategyDocument('t'), {
      typeId: 'does.not.exist',
      typeVersion: '1.0.0',
      params: {},
      position: { x: 0, y: 0 },
    })
    const [unknownNode] = doc.nodes
    const decision = decideConnection(catalog, compatSet, doc, {
      source: unknownNode.id,
      target: unknownNode.id,
      sourceHandle: 'out',
      targetHandle: 'in',
    })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('Unknown node type')
      expect(decision.reason).toContain('does.not.exist')
    }
  })

  it('rejects gracefully an incomplete connection (missing endpoint/handle)', () => {
    const { doc } = buildDoc()
    // RF hands us null endpoints/handles for an incomplete drag; the `Connection` type spells them as
    // string, so cast to model the real runtime shape the guard must survive.
    const incomplete = {
      source: null,
      target: null,
      sourceHandle: null,
      targetHandle: null,
    } as unknown as Connection
    const decision = decideConnection(catalog, compatSet, doc, incomplete)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('Incomplete connection')
    }
  })

  it('ALLOWS an edge into a component exposed input whose type matches the allow-set', () => {
    const { doc, priceId } = buildComponentDoc()
    const components = new Map([[componentCacheKey(DEF.component_id, DEF.version), DEF]])
    const decision = decideConnection(
      catalog,
      compatSet,
      doc,
      { source: priceId, target: 'mom', sourceHandle: 'series', targetHandle: 'series' },
      components,
    )
    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      expect(decision.edge).toEqual({ from: [priceId, 'series'], to: ['mom', 'series'] })
    }
  })

  it('rejects with "not loaded" when the component definition is a cache MISS', () => {
    const { doc, priceId } = buildComponentDoc()
    // Empty cache → the component endpoint cannot be resolved.
    const decision = decideConnection(
      catalog,
      compatSet,
      doc,
      { source: priceId, target: 'mom', sourceHandle: 'series', targetHandle: 'series' },
      new Map(),
    )
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('not loaded')
    }
  })
})

function stubActions(): StrategyDocumentActions {
  return {
    addNode: vi.fn(),
    removeNode: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    setParams: vi.fn(),
    setNodeUi: vi.fn(),
    replace: vi.fn(),
    replaceIf: vi.fn().mockReturnValue(true),
  }
}

describe('Canvas render', () => {
  it('renders the node(s) of the document over the canvas', async () => {
    const { doc } = buildDoc()
    render(
      <CatalogProvider>
        <ComponentsProvider>
          <Canvas doc={doc} actions={stubActions()} />
        </ComponentsProvider>
      </CatalogProvider>,
    )
    // Once the catalog resolves, the custom node shows the type's display name.
    expect(await screen.findByText('Trailing Return')).toBeInTheDocument()
    expect(screen.getByText('Rank')).toBeInTheDocument()
  })

  it('re-seeds RF-local state FROM the doc when the doc gains a node (doc is authoritative)', async () => {
    const { doc } = buildDoc()
    const { rerender } = render(
      <CatalogProvider>
        <ComponentsProvider>
          <Canvas doc={doc} actions={stubActions()} />
        </ComponentsProvider>
      </CatalogProvider>,
    )
    await screen.findByText('Trailing Return')
    // A node type the first render never saw ("Fixed Universe" is absent from buildDoc). Since
    // RF-local state must reconcile FROM the doc, the added node's display name must appear after
    // rerender — a refactor that let RF-local state win instead would fail this.
    expect(screen.queryByText('Fixed Universe')).not.toBeInTheDocument()
    const withAdded = addNode(doc, {
      typeId: 'universe.fixed_list',
      typeVersion: '1.0.0',
      params: {},
      position: { x: 400, y: 400 },
    })
    rerender(
      <CatalogProvider>
        <ComponentsProvider>
          <Canvas doc={withAdded} actions={stubActions()} />
        </ComponentsProvider>
      </CatalogProvider>,
    )
    expect(await screen.findByText('Fixed Universe')).toBeInTheDocument()
  })
})
