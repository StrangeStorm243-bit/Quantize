// App component-navigation trail (M13.8, Task 4): the App OWNS the breadcrumb trail
// (`ComponentTrailEntry[]`) that puts the main canvas into its read-only component view. Entering a
// component (the Inspector's "Enter component" button OR a canvas double-click) appends an entry;
// crumb clicks / Esc navigate to a depth; a freshly created document starts back at the strategy view.
// The extraction toolbar is hidden while a trail is open (a definition is immutable — nothing to
// extract). We STUB Canvas (to surface the trail + fire the enter/navigate callbacks), Inspector (to
// fire "Enter component"), StrategyBar (to reach Home), and Home (to create a document), so the wiring
// is observable without driving the real canvas. NO network.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
  }
})

// Canvas stub: surface the App-owned trail (length + ids) and the component-view selection, and expose
// buttons that fire the navigation callbacks — `canvas-enter` (the double-click path) appends via the
// SAME `onEnterComponent` the Inspector uses; `nav-0`/`nav-1` are crumb clicks at those depths.
type Entry = { componentId: string; version: string }
vi.mock('./components/Canvas', () => ({
  Canvas: (props: {
    componentTrail?: Entry[]
    componentSelectedNodeId?: string | null
    onEnterComponent?: (entry: Entry) => void
    onNavigateToDepth?: (depth: number) => void
  }) => (
    <div>
      <span data-testid="trail-len">{props.componentTrail?.length ?? 0}</span>
      <span data-testid="trail-ids">
        {(props.componentTrail ?? []).map((e) => e.componentId).join(',')}
      </span>
      <span data-testid="comp-sel">{String(props.componentSelectedNodeId)}</span>
      <button
        type="button"
        onClick={() => props.onEnterComponent?.({ componentId: 'cid-canvas', version: '1.0.0' })}
      >
        canvas-enter
      </button>
      <button type="button" onClick={() => props.onNavigateToDepth?.(0)}>
        nav-0
      </button>
      <button type="button" onClick={() => props.onNavigateToDepth?.(1)}>
        nav-1
      </button>
    </div>
  ),
}))

// Inspector stub: a single button that fires the "Enter component" callback with a ComponentTrailEntry
// payload (`{componentId, version}`) — exactly what the real Inspector's button emits.
vi.mock('./components/Inspector', () => ({
  Inspector: (props: { onEnterComponent?: (entry: Entry) => void }) => (
    <button
      type="button"
      onClick={() => props.onEnterComponent?.({ componentId: 'cid-inspector', version: '2.0.0' })}
    >
      inspector-enter
    </button>
  ),
}))

// StrategyBar stub: only `onHome` is exercised here (returning to Home so a new document can be made).
vi.mock('./components/StrategyBar', () => ({
  StrategyBar: (props: { onHome: () => void }) => (
    <button type="button" onClick={props.onHome}>
      go-home
    </button>
  ),
}))

// The app opens on Home (M13.3); a Home stub enters the editor via onNew.
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

function renderEditor(): void {
  render(<App />)
  fireEvent.click(screen.getByText('home-new'))
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('App component-navigation trail (M13.8)', () => {
  it('the Inspector "Enter component" payload starts a 1-entry trail from the strategy view', async () => {
    renderEditor()
    expect(screen.getByTestId('trail-len')).toHaveTextContent('0')
    fireEvent.click(screen.getByText('inspector-enter'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('1')
    expect(screen.getByTestId('trail-ids')).toHaveTextContent('cid-inspector')
    await flush()
  })

  it('the Inspector entry REPLACES the trail (a strategy-level entry, never a duplicate crumb)', async () => {
    renderEditor()
    // A 1-deep trail already open via the Inspector (its selected node is the same top-level ComponentRef).
    fireEvent.click(screen.getByText('inspector-enter'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('1')
    // Re-firing the SAME entry replaces rather than appends → length stays 1 (no Strategy ▸ X ▸ X).
    fireEvent.click(screen.getByText('inspector-enter'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('1')
    await flush()
  })

  it('the Inspector entry collapses a deeper trail to just the new entry', async () => {
    renderEditor()
    // Open a 1-deep trail with a DIFFERENT entry (the canvas double-click path, cid-canvas).
    fireEvent.click(screen.getByText('canvas-enter'))
    expect(screen.getByTestId('trail-ids')).toHaveTextContent('cid-canvas')
    // A strategy-level Inspector entry (cid-inspector) replaces it: length 1, new identity, old gone.
    fireEvent.click(screen.getByText('inspector-enter'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('1')
    expect(screen.getByTestId('trail-ids')).toHaveTextContent('cid-inspector')
    expect(screen.getByTestId('trail-ids')).not.toHaveTextContent('cid-canvas')
    await flush()
  })

  it('the canvas double-click path APPENDS onto the current trail', async () => {
    renderEditor()
    // Two canvas double-clicks descend two levels — append, not replace.
    fireEvent.click(screen.getByText('canvas-enter'))
    fireEvent.click(screen.getByText('canvas-enter'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('2')
    expect(screen.getByTestId('trail-ids')).toHaveTextContent('cid-canvas,cid-canvas')
    await flush()
  })

  it('navigating to depth 0 clears the trail', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('canvas-enter'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('1')
    fireEvent.click(screen.getByText('nav-0'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('0')
    await flush()
  })

  it('navigating to depth 1 from a 2-deep trail keeps one entry', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('canvas-enter'))
    fireEvent.click(screen.getByText('canvas-enter'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('2')
    fireEvent.click(screen.getByText('nav-1'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('1')
    await flush()
  })

  it('hides the extraction toolbar while a trail is open, restores it on exit', async () => {
    renderEditor()
    // Strategy view: the extraction entry affordance is present.
    expect(screen.getByRole('button', { name: 'Extract component' })).toBeInTheDocument()
    // Enter a component → a definition is immutable, so the toolbar disappears.
    fireEvent.click(screen.getByText('canvas-enter'))
    expect(screen.queryByRole('button', { name: 'Extract component' })).not.toBeInTheDocument()
    // Exit back to the strategy view → the toolbar returns.
    fireEvent.click(screen.getByText('nav-0'))
    expect(screen.getByRole('button', { name: 'Extract component' })).toBeInTheDocument()
    await flush()
  })

  it('creating a new document clears a non-empty trail', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('canvas-enter'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('1')
    // Return Home, then create a fresh document — a new document starts at the strategy view.
    fireEvent.click(screen.getByText('go-home'))
    fireEvent.click(screen.getByText('home-new'))
    expect(screen.getByTestId('trail-len')).toHaveTextContent('0')
    await flush()
  })
})
