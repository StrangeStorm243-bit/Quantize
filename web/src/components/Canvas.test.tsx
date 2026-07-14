import { fireEvent, render, screen } from '@testing-library/react'
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

// waitFor options for the catalog-resolve → first-RF-paint gate: under full-suite parallel load it can
// exceed findBy's 1s default (observed ~1.1s in gate runs — an intermittent whole-gate failure).
const FIRST_PAINT = { timeout: 5000 }

// No network in tests: the CatalogProvider's fetch resolves to the committed golden, and the
// component-definition cache resolves to a fixed definition (the ComponentsProvider fetches every
// pinned ref on mount). `errorMessage` is used by the cache's failure path.
vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return {
    getNodeCatalog: () => Promise.resolve(json),
    loadComponentVersion: () =>
      Promise.resolve({
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
      }),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  }
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
    // Once the catalog resolves, the custom node shows the type's display name. The catalog-resolve →
    // first-RF-paint gate can exceed findBy's 1s default under full-suite parallel load (observed at
    // ~1.1s in gate runs) — an extended timeout everywhere this file awaits that first paint.
    expect(await screen.findByText('Trailing Return', undefined, FIRST_PAINT)).toBeInTheDocument()
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
    await screen.findByText('Trailing Return', undefined, FIRST_PAINT)
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

// A single-node doc carrying a param, so the card face has a summary to show.
function cardDoc(): { doc: StrategyDocument; nodeId: string } {
  const doc = addNode(newStrategyDocument('t'), {
    typeId: 'transform.trailing_return',
    typeVersion: '1.0.0',
    params: { lookback_sessions: 63 },
    position: { x: 0, y: 0 },
  })
  return { doc, nodeId: doc.nodes[0].id }
}

function renderCanvas(ui: Parameters<typeof render>[0]): ReturnType<typeof render> {
  return render(
    <CatalogProvider>
      <ComponentsProvider>{ui}</ComponentsProvider>
    </CatalogProvider>,
  )
}

describe('Canvas M13.4 legibility', () => {
  it('renders a node as a category card with icon, param summary and a validity badge', async () => {
    const { doc, nodeId } = cardDoc()
    const { container } = renderCanvas(
      <Canvas doc={doc} actions={stubActions()} nodeValidity={new Map([[nodeId, 'error']])} />,
    )
    await screen.findByText('Trailing Return', undefined, FIRST_PAINT)
    // Category color/icon: the card carries the served category class and an inline svg glyph.
    const card = container.querySelector('.snode--cat-transform')
    expect(card).not.toBeNull()
    expect(card?.querySelector('svg')).not.toBeNull()
    // The param summary is on the card face.
    expect(screen.getByText('lookback_sessions = 63')).toBeInTheDocument()
    // The validity badge reflects the passed-in (server-derived) verdict.
    expect(container.querySelector('.snode__badge--error')).not.toBeNull()
  })

  it('gives the card a description tooltip and each port row a served type title (PX-3)', async () => {
    const { doc } = cardDoc()
    const { container } = renderCanvas(<Canvas doc={doc} actions={stubActions()} />)
    await screen.findByText('Trailing Return', undefined, FIRST_PAINT)
    // The card's hover tooltip is the catalog description verbatim.
    const retType = catalog.node_types.find((n) => n.type_id === 'transform.trailing_return')
    const card = container.querySelector('.snode--cat-transform')
    expect(card?.getAttribute('title')).toBe(retType?.description)
    // Each port row carries "<port name> · <served port-type label>" — the label comes from labelOf,
    // never hardcoded (the same label the Legend and rejection banners use).
    expect(container.querySelector('[title="series · TimeSeries[Number]"]')).not.toBeNull()
    expect(container.querySelector('[title="values · CrossSection[Number]"]')).not.toBeNull()
  })

  it('renders a ComponentRef as the composition variant with a version chip', async () => {
    const { doc } = buildComponentDoc()
    const { container } = renderCanvas(<Canvas doc={doc} actions={stubActions()} />)
    await screen.findByLabelText('port type legend')
    expect(container.querySelector('.snode--component')).not.toBeNull()
    expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument()
  })

  it('shows the on-canvas legend listing the catalog port types', async () => {
    const { doc } = buildDoc()
    renderCanvas(<Canvas doc={doc} actions={stubActions()} />)
    expect(await screen.findByLabelText('port type legend')).toBeInTheDocument()
    // A representative lattice label sourced from the catalog.
    expect(screen.getByText('CrossSection[Number]')).toBeInTheDocument()
  })

  it('shows the pipeline stage strip with per-segment counts for the graph', async () => {
    const { doc } = buildDoc() // trailing_return(transform) + rank(selection) + price(data)
    renderCanvas(<Canvas doc={doc} actions={stubActions()} />)
    // Await a node so the catalog has resolved and categories are projected into the strip.
    await screen.findByText('Rank')
    expect(screen.getByRole('button', { name: /Data: 1 node/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Transforms: 1 node/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Rank & Select: 1 node/ })).toBeInTheDocument()
  })

  it('forwards onEngineClick to the stage strip Engine chip (PX-2)', async () => {
    const { doc } = buildDoc()
    const onEngineClick = vi.fn()
    renderCanvas(<Canvas doc={doc} actions={stubActions()} onEngineClick={onEngineClick} />)
    const engine = await screen.findByRole('button', { name: 'Engine — targets to orders to fills' })
    fireEvent.click(engine)
    expect(onEngineClick).toHaveBeenCalledTimes(1)
  })

  it('opens the quick-add menu on a double-click of the canvas pane', async () => {
    const { doc } = buildDoc()
    const { container } = renderCanvas(<Canvas doc={doc} actions={stubActions()} />)
    await screen.findByLabelText('port type legend')
    const pane = container.querySelector('.react-flow__pane')
    expect(pane).not.toBeNull()
    fireEvent.doubleClick(pane as Element)
    expect(screen.getByLabelText('quick add search')).toBeInTheDocument()
  })
})
