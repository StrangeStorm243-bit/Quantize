// App shell (M13.3): the app opens on Home (no document); creating/opening a document switches to the
// editor (strategy bar + three columns + bottom Dock). The former strategies/datasets bottom tabs are
// gone. Heavy leaf children are stubbed; Home/StrategyBar/Dock are exercised for real. NO network.
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

// DatasetPanel + the heavy canvas / rails / dock panels are stubbed so the shell test stays focused.
vi.mock('./components/DatasetPanel', () => ({
  DatasetPanel: () => <div>dataset-panel</div>,
  LAST_DATASET_KEY: 'quantize.lastDatasetId',
}))
// The mock exposes the Engine chip's callback (PX-2) as a button so a test can drive it through App.
vi.mock('./components/Canvas', () => ({
  Canvas: (props: { onEngineClick?: () => void }) => (
    <div>
      canvas
      <button type="button" onClick={() => props.onEngineClick?.()}>
        mock-engine-click
      </button>
    </div>
  ),
}))
vi.mock('./components/Palette', () => ({ Palette: () => <div>palette</div> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div>inspector</div> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div>problems-panel</div> }))
vi.mock('./components/RunPanel', () => ({ RunPanel: () => <div>runs-panel</div> }))
vi.mock('./components/ResultsView', () => ({ ResultsView: () => <div>results-panel</div> }))
vi.mock('./components/TraceView', () => ({ TraceView: () => <div>trace-panel</div> }))

// eslint-disable-next-line import/first
import { App } from './App'

function enterEditor(): void {
  fireEvent.change(screen.getByLabelText('new strategy name'), { target: { value: 'My Strat' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
}

// Settle the boot-time catalog/meta + Home strategies fetches within act (so no state update lands
// after the synchronous test body). Called at the end of each test.
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('App shell (M13.3)', () => {
  it('opens on Home with no strategy bar', async () => {
    render(<App />)
    expect(screen.getByText(/visual IDE for quantitative trading/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Validate' })).not.toBeInTheDocument()
    await flush()
  })

  it('switches to the editor when a new strategy is created', async () => {
    render(<App />)
    enterEditor()
    // Strategy bar verbs and the named document appear.
    expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByText('My Strat')).toBeInTheDocument()
    // Home is gone.
    expect(screen.queryByText(/visual IDE for quantitative trading/i)).not.toBeInTheDocument()
    await flush()
  })

  it('mounts the bottom dock with Problems/Runs/Results/Trace (Results+Trace disabled before a run)', async () => {
    render(<App />)
    enterEditor()
    for (const label of ['Problems', 'Runs', 'Results', 'Trace']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByText('problems-panel')).toBeInTheDocument() // default active tab
    expect(screen.getByRole('button', { name: 'Results' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Trace' })).toBeDisabled()
    await flush()
  })

  it('no longer shows the old strategies/datasets bottom tabs', async () => {
    render(<App />)
    enterEditor()
    expect(screen.queryByRole('button', { name: 'strategies' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'datasets' })).not.toBeInTheDocument()
    await flush()
  })

  it('shows the unbound dataset chip and returns Home via the bar', async () => {
    render(<App />)
    enterEditor()
    expect(screen.getByRole('button', { name: 'active dataset' })).toHaveTextContent(/none — choose/)
    fireEvent.click(screen.getByRole('button', { name: /Home/ }))
    expect(screen.getByText(/visual IDE for quantitative trading/i)).toBeInTheDocument()
    await flush()
  })

  it('switches the dock to Runs when the Engine chip is clicked and no run is selected (PX-2)', async () => {
    render(<App />)
    enterEditor()
    expect(screen.getByText('problems-panel')).toBeInTheDocument() // default active tab
    fireEvent.click(screen.getByRole('button', { name: 'mock-engine-click' }))
    // No run selected → the handler targets Runs (never the disabled Results/Trace tabs).
    expect(screen.getByText('runs-panel')).toBeInTheDocument()
    expect(screen.queryByText('problems-panel')).not.toBeInTheDocument()
    await flush()
  })

  it('switches dock panels when a tab is clicked', async () => {
    render(<App />)
    enterEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    expect(screen.getByText('runs-panel')).toBeInTheDocument()
    expect(screen.queryByText('problems-panel')).not.toBeInTheDocument()
    await flush()
  })
})
