// Dock-collapse intent routing (M14.4): `openDock` must un-collapse the dock for EVERY dock-opening
// intent, not just Validate. This file covers the run-selection intent (`onSelectRun` → Results). That
// intent originates INSIDE the dock (the Runs panel), which the real Dock unmounts while collapsed — so
// there is no real-UI way to click it collapsed. We therefore mock the Dock to always render its panel
// nodes and to expose `collapsed`/`tab`, letting the test drive `onSelectRun` from a collapsed dock and
// assert the App un-collapsed onto Results. The real-Dock collapse round-trip is covered in
// App.validity.test.tsx (Validate) and the e2e a8 case (tab clicks).
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
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
    // Selecting a run kicks the debug-loop hook; stub its fetches so nothing touches the network.
    getRun: vi.fn().mockResolvedValue({ record: null, replay_verifiable: false }),
    getTraceTree: vi.fn().mockResolvedValue({ trees: [] }),
    loadStrategyVersion: vi.fn().mockResolvedValue({ schedule: { kind: 'daily' } }),
  }
})

vi.mock('./components/Canvas', () => ({ Canvas: () => <div /> }))
vi.mock('./components/Palette', () => ({ Palette: () => <div /> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div /> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div /> }))
vi.mock('./components/ResultsView', () => ({ ResultsView: () => <div>results-panel</div> }))
vi.mock('./components/TraceView', () => ({ TraceView: () => <div /> }))
// RunPanel stub: a single button that fires the App's onSelectRun (the same callback the real run list
// invokes). Our mock Dock renders every panel node unconditionally, so it stays reachable while collapsed.
vi.mock('./components/RunPanel', () => ({
  RunPanel: (props: { onSelectRun: (id: string) => void }) => (
    <button type="button" onClick={() => props.onSelectRun('run-1')}>
      select-run-1
    </button>
  ),
}))
// Mock Dock: renders ALL panel nodes always (so the collapsed run panel is still reachable) and exposes
// the collapse state + a toggle, so the test can assert the App's `openDock` un-collapses onto Results.
vi.mock('./components/Dock', () => ({
  Dock: (props: {
    tab: string
    collapsed: boolean
    onToggleCollapse: () => void
    panels: { id: string; node: ReactNode }[]
  }) => (
    <div>
      <span data-testid="dock-collapsed">{String(props.collapsed)}</span>
      <span data-testid="dock-tab">{props.tab}</span>
      <button type="button" onClick={props.onToggleCollapse}>
        toggle-dock
      </button>
      {props.panels.map((p) => (
        <div key={p.id}>{p.node}</div>
      ))}
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('App dock-collapse intent routing (M14.4)', () => {
  it('selecting a run while the dock is collapsed re-expands it onto Results', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('home-new')) // enter the editor
    await flush()
    expect(screen.getByTestId('dock-collapsed')).toHaveTextContent('false')

    // Collapse, then select a run: `onSelectRun` routes through `openDock('results')`, which must
    // un-collapse (dock-collapsed → false) AND switch to the Results tab.
    fireEvent.click(screen.getByText('toggle-dock'))
    expect(screen.getByTestId('dock-collapsed')).toHaveTextContent('true')

    fireEvent.click(screen.getByText('select-run-1'))
    expect(screen.getByTestId('dock-collapsed')).toHaveTextContent('false')
    expect(screen.getByTestId('dock-tab')).toHaveTextContent('results')
    await flush()
  })
})
