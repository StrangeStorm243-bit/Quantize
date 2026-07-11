// App wiring for read-only component-internals inspection (M13.9 O3). Entering a component and clicking
// an inner node must (a) select it in the App-owned `componentSelectedNodeId`, and (b) resolve that node
// from the trail tip's definition graph and hand it to the Inspector as `componentNode` so it renders
// read-only. We stub Canvas (to fire the enter + inner-click callbacks and surface the selection) and
// Inspector (to surface the resolved `componentNode`), and control the component-definition cache. NO network.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentDefinition } from '@quantize/quantize-ir'
import { componentCacheKey } from './document/flow'

const CID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

vi.mock('./api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/client')>()
  return {
    ...actual,
    getMeta: vi
      .fn()
      .mockResolvedValue({ api_version: 'v1', schema_version: '0.1.0', record_format: 1, trace_format: 1 }),
    getNodeCatalog: vi.fn().mockResolvedValue({
      api_version: 'v1', schema_version: '0.1.0', catalog_digest: '0'.repeat(64),
      port_types: [], compatibility: [], node_types: [],
    }),
    listStrategies: vi.fn().mockResolvedValue({ strategies: [] }),
    listComponents: vi.fn().mockResolvedValue({ components: [] }),
    getRun: vi.fn(),
    loadStrategyVersion: vi.fn().mockResolvedValue({ schedule: { kind: 'daily' } }),
  }
})

// A controllable component-definition cache: the App reads `defs.get(componentCacheKey(...))` to resolve
// the trail tip, then finds the selected inner node in its graph.
const state = vi.hoisted(() => ({ defs: new Map<string, unknown>() }))
vi.mock('./components-cache', () => ({
  ComponentsProvider: ({ children }: { children: unknown }) => children,
  useComponentDefs: () => ({
    defs: state.defs,
    get: (id: string, v: string) => state.defs.get(`${id}@${v}`),
    ensure: vi.fn(),
    seed: vi.fn(),
    isLoading: () => false,
    errorOf: () => undefined,
  }),
}))

// Canvas stub: enter a component (matching the seeded def), click an inner node, surface the selection.
type Entry = { componentId: string; version: string }
vi.mock('./components/Canvas', () => ({
  Canvas: (props: {
    componentSelectedNodeId?: string | null
    onEnterComponent?: (entry: Entry) => void
    onComponentNodeClick?: (nodeId: string) => void
  }) => (
    <div>
      <span data-testid="comp-sel">{String(props.componentSelectedNodeId)}</span>
      <button type="button" onClick={() => props.onEnterComponent?.({ componentId: CID, version: '1.0.0' })}>
        canvas-enter
      </button>
      <button type="button" onClick={() => props.onComponentNodeClick?.('rk')}>
        inner-click
      </button>
    </div>
  ),
}))

// Inspector stub: surface the resolved read-only `componentNode` (its node id), or 'none'.
vi.mock('./components/Inspector', () => ({
  Inspector: (props: { componentNode?: { node: { id: string } } }) => (
    <div data-testid="inspector-component-node">
      {props.componentNode ? props.componentNode.node.id : 'none'}
    </div>
  ),
}))

vi.mock('./components/Home', () => ({
  DEMO_NAME: /momentum/i,
  Home: (props: { onNew: (name: string) => void }) => (
    <button type="button" onClick={() => props.onNew('Test')}>
      home-new
    </button>
  ),
}))

// eslint-disable-next-line import/first
import { App } from './App'

function seededDef(): ComponentDefinition {
  return {
    schema_version: '0.1.0', component_id: CID, version: '1.0.0', name: 'Momentum', description: null,
    component_refs: [],
    implementation: {
      kind: 'graph',
      graph: { nodes: [{ id: 'rk', type_id: 'transform.rank', type_version: '1.0.0', params: {} }], edges: [] },
    },
    exposed_inputs: [], exposed_outputs: [], exposed_params: [],
    provenance: {
      owner: '22222222-2222-2222-2222-222222222222', creator: '22222222-2222-2222-2222-222222222222',
      contributors: [], visibility: 'private', duplicable: false,
      created_at: '2026-07-06T00:00:00Z', forked_from: null,
    },
  }
}

afterEach(async () => {
  state.defs = new Map()
  vi.clearAllMocks()
  await act(async () => {
    await Promise.resolve()
  })
})

describe('App read-only component-internals inspection (O3)', () => {
  it('selecting an inner node resolves it from the tip definition and passes it to the Inspector', async () => {
    state.defs = new Map([[componentCacheKey(CID, '1.0.0'), seededDef()]])
    render(<App />)
    fireEvent.click(screen.getByText('home-new')) // enter the editor

    // Strategy view: no in-component selection, so the Inspector gets no componentNode.
    expect(screen.getByTestId('inspector-component-node')).toHaveTextContent('none')

    // Enter the component, then click an inner node.
    fireEvent.click(screen.getByText('canvas-enter'))
    fireEvent.click(screen.getByText('inner-click'))

    // The click selected the node, and the App resolved it from the tip definition graph.
    expect(screen.getByTestId('comp-sel')).toHaveTextContent('rk')
    expect(screen.getByTestId('inspector-component-node')).toHaveTextContent('rk')
    await act(async () => {
      await Promise.resolve()
    })
  })
})
