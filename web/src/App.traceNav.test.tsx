// App trace→canvas/breadcrumb navigation (M13.7 hook, closed in M13.8): clicking a node-origin trace
// row navigates to its emitting node. A TOP-LEVEL row (empty component_path) lands in the strategy view
// — trail cleared, node selected + centered. A row INSIDE a component walks the breadcrumb as deep as the
// served `component_path` resolves (`resolveTrailFromPath`): the strategy-doc ComponentRef instance
// (component_path[0]) stays selected for Inspector continuity, and when the path fully resolves the
// emitting leaf is emphasized (`componentSelectedNodeId`) and centered in the component view. A malformed
// path falls back to selecting the ref instance. The engine is not a graph node (invariant 2) → engine
// rows are never clickable, so there is nothing to test for them here (covered in TraceView.test).
//
// We STUB Canvas (to expose selection, focus, trail, and in-component emphasis), TraceView (to fire
// onNodeClick), and the Dock (to render every panel's node) so the Trace panel's callback is reachable
// without driving the real run-selection + tab-switch flow — the least-fragile shape for asserting pure
// event plumbing.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { newStrategyDocument } from './document/store'

// A component id the seeded ComponentRef instance pins (matches the `component_refs` entry below).
const CID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

// A document that CONTAINS the nodes a trace row can target, so the App's clear-stale-selection effect
// (which drops a selection whose node is absent) keeps the selection — mirroring the real app, where the
// emitting node always exists in the open document. 'mom' is a real on-canvas ComponentRef INSTANCE
// (component_path[0] for a nested-component row); 'n1' is a top-level node; 'plain' is a plain registered
// node used to exercise the malformed-path fallback (a non-component element in component_path).
const seededDoc: StrategyDocument = {
  ...newStrategyDocument('Seed'),
  nodes: [
    { id: 'mom', type_id: 'component', ref: 'r1', params: {}, ui: { position: { x: 0, y: 0 } } },
    { id: 'n1', type_id: 'x.y', type_version: '1.0.0', params: {}, ui: { position: { x: 0, y: 0 } } },
    { id: 'plain', type_id: 'x.y', type_version: '1.0.0', params: {}, ui: { position: { x: 0, y: 0 } } },
  ],
  component_refs: [{ id: 'r1', component_id: CID, version: '1.0.0' }],
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
    // The debug-loop hook fetches the RUN's producing strategy version for its cadence (M13.7 fix pass);
    // stub it so selecting a run never touches the network (only `.schedule.kind` is read).
    loadStrategyVersion: vi.fn().mockResolvedValue({ schedule: { kind: 'daily' } }),
  }
})

// Canvas stub: surface the App-passed selection, focus request (id + nonce), the component-navigation
// trail length, and the in-component emphasis so the plumbing is observable, and expose a `seed-doc`
// button that replaces the document with one CONTAINING the targeted nodes ('mom', 'n1', 'plain').
// Seeding matters because the App clears a selection whose node is not in the document — in the real app
// the emitting node always exists, so the seed reproduces that. The real fitView viewport call cannot be
// meaningfully asserted in jsdom (Task 3 note).
vi.mock('./components/Canvas', () => ({
  Canvas: (props: {
    actions: { replace: (doc: StrategyDocument) => void }
    selectedNodeId: string | null
    focusRequest: { nodeId: string; nonce: number } | null
    componentTrail?: { componentId: string; version: string }[]
    componentSelectedNodeId?: string | null
  }) => (
    <div>
      <span data-testid="sel-node">{String(props.selectedNodeId)}</span>
      <span data-testid="focus">{props.focusRequest?.nodeId ?? 'none'}</span>
      <span data-testid="focus-nonce">{String(props.focusRequest?.nonce ?? 0)}</span>
      <span data-testid="trail-len">{String(props.componentTrail?.length ?? 0)}</span>
      <span data-testid="comp-sel">{String(props.componentSelectedNodeId ?? null)}</span>
      <button type="button" onClick={() => props.actions.replace(seededDoc)}>
        seed-doc
      </button>
    </div>
  ),
}))

// TraceView stub: buttons that drive the App's onNodeClick — a row INSIDE component 'mom'
// (component_path[0] === 'mom'), a top-level node (empty component_path), and a row whose component_path
// names a PLAIN node (malformed → fallback).
vi.mock('./components/TraceView', () => ({
  TraceView: (props: { onNodeClick?: (nodeId: string, componentPath: string[]) => void }) => (
    <div>
      <button type="button" onClick={() => props.onNodeClick?.('sel', ['mom'])}>
        trace-click-component
      </button>
      <button type="button" onClick={() => props.onNodeClick?.('n1', [])}>
        trace-click-toplevel
      </button>
      <button type="button" onClick={() => props.onNodeClick?.('leaf', ['plain'])}>
        trace-click-plain
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

describe('App trace→breadcrumb navigation (M13.8)', () => {
  it('navigates the breadcrumb for a row inside a component (path fully resolves)', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('seed-doc')) // put 'mom' + 'n1' + 'plain' in the document
    fireEvent.click(screen.getByText('trace-click-component'))
    // The single-level path resolves off the ref alone (no cache needed) → trail set to that component.
    expect(screen.getByTestId('trail-len')).toHaveTextContent('1')
    // The strategy-doc ComponentRef instance stays selected for Inspector continuity...
    expect(screen.getByTestId('sel-node')).toHaveTextContent('mom')
    // ...and the emitting leaf is emphasized + centered inside the component view.
    expect(screen.getByTestId('comp-sel')).toHaveTextContent('sel')
    expect(screen.getByTestId('focus')).toHaveTextContent('sel')
    await flush()
  })

  it('clears the trail and lands in the strategy view for a top-level row (empty component_path)', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('seed-doc'))
    // First open a trail, then a top-level row must return to the strategy view.
    fireEvent.click(screen.getByText('trace-click-component'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('1')
    fireEvent.click(screen.getByText('trace-click-toplevel'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('0')
    expect(screen.getByTestId('comp-sel')).toHaveTextContent('null')
    expect(screen.getByTestId('sel-node')).toHaveTextContent('n1')
    expect(screen.getByTestId('focus')).toHaveTextContent('n1')
    await flush()
  })

  it('falls back to selecting component_path[0] for a malformed (non-component) path', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('seed-doc'))
    fireEvent.click(screen.getByText('trace-click-plain'))
    // 'plain' is not a component → the path does not resolve → pre-breadcrumb fallback: no trail, the
    // named strategy node is selected + centered.
    expect(screen.getByTestId('trail-len')).toHaveTextContent('0')
    expect(screen.getByTestId('sel-node')).toHaveTextContent('plain')
    expect(screen.getByTestId('focus')).toHaveTextContent('plain')
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
