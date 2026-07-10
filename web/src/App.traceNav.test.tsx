// App trace→canvas navigation (M13.7, Task 3): clicking a node-origin trace row selects and centers
// the emitting node on the canvas. The App receives (node_id, component_path) from TraceView and (1)
// sets `selectedNodeId`, (2) bumps a nonce-keyed `focusRequest` so re-clicking the same row re-centers
// the canvas. A row INSIDE a component selects the ComponentRef INSTANCE node (component_path[0]) until
// M13.8's breadcrumb navigation lands. The engine is not a graph node (invariant 2) → engine rows are
// never clickable, so there is nothing to test for them here (covered in TraceView.test).
//
// We STUB Canvas (to expose selectedNodeId + focusRequest), TraceView (to fire onNodeClick), and the
// Dock (to render every panel's node) so the Trace panel's callback is reachable without driving the
// real run-selection + tab-switch flow — the least-fragile shape for asserting pure event plumbing.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { newStrategyDocument } from './document/store'

// A document that CONTAINS the two nodes a trace row can target, so the App's clear-stale-selection
// effect (which drops a selection whose node is absent) keeps the selection — mirroring the real app,
// where the emitting node always exists in the open document. 'mom' stands in for the on-canvas
// ComponentRef instance a nested-component row resolves to (component_path[0]); 'n1' is a top-level node.
const seededDoc: StrategyDocument = {
  ...newStrategyDocument('Seed'),
  nodes: [
    { id: 'mom', type_id: 'x.y', type_version: '1.0.0', params: {}, ui: { position: { x: 0, y: 0 } } },
    { id: 'n1', type_id: 'x.y', type_version: '1.0.0', params: {}, ui: { position: { x: 0, y: 0 } } },
  ],
}

vi.mock('./api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/client')>()
  return {
    ...actual,
    getMeta: vi
      .fn()
      .mockResolvedValue({ api_version: 'v1', schema_version: '0.1.0', record_format: 1, trace_format: 1 }),
    getNodeCatalog: vi.fn().mockResolvedValue({
      api_version: 'v1',
      schema_version: '0.1.0',
      catalog_digest: '0'.repeat(64),
      port_types: [],
      compatibility: [],
      node_types: [],
    }),
    listStrategies: vi.fn().mockResolvedValue({ strategies: [] }),
    listComponents: vi.fn().mockResolvedValue({ components: [] }),
    getRun: vi.fn(),
    getTraceTree: vi.fn().mockResolvedValue({ trees: [] }),
  }
})

// Canvas stub: surface the App-passed selection + the focus request (id + nonce) so the plumbing is
// observable, and expose a `seed-doc` button that replaces the document with one CONTAINING the nodes a
// trace row targets ('mom', 'n1'). Seeding matters because the App clears a selection whose node is not
// in the document — in the real app the emitting node always exists, so the seed reproduces that. The
// real fitView viewport call cannot be meaningfully asserted in jsdom (Task 3 note).
vi.mock('./components/Canvas', () => ({
  Canvas: (props: {
    actions: { replace: (doc: StrategyDocument) => void }
    selectedNodeId: string | null
    focusRequest: { nodeId: string; nonce: number } | null
  }) => (
    <div>
      <span data-testid="sel-node">{String(props.selectedNodeId)}</span>
      <span data-testid="focus">{props.focusRequest?.nodeId ?? 'none'}</span>
      <span data-testid="focus-nonce">{String(props.focusRequest?.nonce ?? 0)}</span>
      <button type="button" onClick={() => props.actions.replace(seededDoc)}>
        seed-doc
      </button>
    </div>
  ),
}))

// TraceView stub: two buttons that drive the App's onNodeClick — one for a row INSIDE component 'mom'
// (component_path[0] === 'mom'), one for a top-level node (empty component_path).
vi.mock('./components/TraceView', () => ({
  TraceView: (props: { onNodeClick?: (nodeId: string, componentPath: string[]) => void }) => (
    <div>
      <button type="button" onClick={() => props.onNodeClick?.('sel', ['mom'])}>
        trace-click-component
      </button>
      <button type="button" onClick={() => props.onNodeClick?.('n1', [])}>
        trace-click-toplevel
      </button>
    </div>
  ),
}))

// Dock stub: render EVERY panel's node so the (otherwise tab-gated) TraceView stub is always mounted —
// the App only mounts the active panel in the real Dock. This isolates the wiring under test.
vi.mock('./components/Dock', () => ({
  Dock: (props: { panels: { id: string; node: React.ReactNode }[] }) => (
    <div>{props.panels.map((p) => <div key={p.id}>{p.node}</div>)}</div>
  ),
}))

vi.mock('./components/Palette', () => ({ Palette: () => <div /> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div /> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div /> }))
vi.mock('./components/RunPanel', () => ({ RunPanel: () => <div /> }))
vi.mock('./components/ResultsView', () => ({ ResultsView: () => <div /> }))
// The app opens on Home (M13.3); a Home stub enters the editor via onNew.
vi.mock('./components/Home', () => ({
  Home: (props: { onNew: (name: string) => void }) => (
    <button type="button" onClick={() => props.onNew('Test')}>
      home-new
    </button>
  ),
}))

// eslint-disable-next-line import/first
import { App } from './App'

function renderEditor(): void {
  render(<App />)
  fireEvent.click(screen.getByText('home-new'))
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('App trace→canvas navigation (M13.7)', () => {
  it('selects the ComponentRef instance (component_path[0]) for a row inside a component', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('seed-doc')) // put 'mom' + 'n1' in the document
    fireEvent.click(screen.getByText('trace-click-component'))
    // Until M13.8, a nested-component row selects the ref INSTANCE node, not the inner leaf.
    expect(screen.getByTestId('sel-node')).toHaveTextContent('mom')
    expect(screen.getByTestId('focus')).toHaveTextContent('mom')
    await flush()
  })

  it('selects the node itself for a top-level row (empty component_path)', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('seed-doc'))
    fireEvent.click(screen.getByText('trace-click-toplevel'))
    expect(screen.getByTestId('sel-node')).toHaveTextContent('n1')
    expect(screen.getByTestId('focus')).toHaveTextContent('n1')
    await flush()
  })

  it('bumps the focus nonce on each click so re-clicking the same row re-centers', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('seed-doc'))
    const before = Number(screen.getByTestId('focus-nonce').textContent)
    fireEvent.click(screen.getByText('trace-click-toplevel'))
    const afterFirst = Number(screen.getByTestId('focus-nonce').textContent)
    fireEvent.click(screen.getByText('trace-click-toplevel'))
    const afterSecond = Number(screen.getByTestId('focus-nonce').textContent)
    expect(afterFirst).toBeGreaterThan(before)
    expect(afterSecond).toBeGreaterThan(afterFirst)
    await flush()
  })
})
