// App journey-checklist wiring (M13.9): the checklist state is INFERRED from app-owned view state
// (open demo, selected run, active dock tab, a landed extraction) — the App never fabricates a tick.
// We mock the network + the heavy children (mirroring App.cursor / App.extraction), but keep the REAL
// JourneyChecklist and Dock mounted so we can assert the on-screen ticks and dock-tab-driven steps.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedRunRecord, RunRecordResponse } from '@quantize/quantize-api'
import { newStrategyDocument } from './document/store'

function record(): RunRecordResponse {
  const rec: PersistedRunRecord = {
    run_id: 'run-1',
    record_format: 1,
    mode: 'backtest',
    ok: true,
    exchange: 'XNYS',
    timezone: 'America/New_York',
    first_session: '2026-05-13',
    last_session: '2026-05-15',
    valuations: [
      ['2026-05-13', 1_000_000],
      ['2026-05-15', 1_000_200],
    ],
    returns: [0.0, 0.0002],
    total_return: 0.0002,
    max_drawdown: 0.0,
    final_cash: 0,
    final_positions: [],
    evaluations: [],
    fills: [],
    notes: [],
    diagnostics: [],
    stale_marks: [],
    strategy_id: 's1',
    strategy_version: 1,
    input_provenance: { status: 'recorded', dataset_hash: 'abc', calendar_hash: 'def' },
  }
  return { record: rec, replay_verifiable: true }
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
    getRun: vi.fn().mockResolvedValue(record()),
    getTraceTree: vi.fn().mockResolvedValue({ trees: [] }),
    loadStrategyVersion: vi.fn().mockResolvedValue({ schedule: { kind: 'daily' } }),
  }
})

vi.mock('./components/Palette', () => ({ Palette: () => <div /> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div /> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div /> }))
vi.mock('./components/TraceView', () => ({ TraceView: () => <div /> }))
vi.mock('./components/ResultsView', () => ({ ResultsView: () => <div /> }))
vi.mock('./components/Canvas', () => ({
  Canvas: (props: { onToggleExtractionNode?: (id: string) => void }) => (
    <div>
      <button type="button" onClick={() => props.onToggleExtractionNode?.('n1')}>
        toggle-n1
      </button>
    </div>
  ),
}))
vi.mock('./components/ExtractDialog', () => ({
  ExtractDialog: (props: {
    doc: unknown
    onCommit: (captured: unknown, strategy: unknown, id: string) => boolean
  }) => (
    <button
      type="button"
      onClick={() => props.onCommit(props.doc, newStrategyDocument('Extracted'), 'newnode')}
    >
      simulate-extracted
    </button>
  ),
}))
vi.mock('./components/RunPanel', () => ({
  RunPanel: (props: { onSelectRun: (id: string) => void }) => (
    <button type="button" onClick={() => props.onSelectRun('run-1')}>
      select-run-1
    </button>
  ),
}))
// Home stub: two entry buttons — a demo-named strategy (matches DEMO_NAME) and a plain one (does not).
// The App also imports DEMO_NAME from Home (the shared demo-match rule), so the mock must re-export it.
vi.mock('./components/Home', () => ({
  DEMO_NAME: /momentum/i,
  Home: (props: { onNew: (name: string) => void }) => (
    <div>
      <button type="button" onClick={() => props.onNew('ETF Momentum Rotation')}>
        open-demo
      </button>
      <button type="button" onClick={() => props.onNew('Blank Strategy')}>
        open-blank
      </button>
    </div>
  ),
}))

// eslint-disable-next-line import/first
import { App } from './App'

beforeEach(() => {
  window.localStorage.clear()
})
afterEach(() => {
  window.localStorage.clear()
})

function stepLi(label: string): HTMLLIElement {
  const li = screen.getByText(label).closest('li')
  if (li === null) throw new Error(`no step row for ${label}`)
  return li as HTMLLIElement
}
function isDone(label: string): boolean {
  return stepLi(label).getAttribute('data-done') === 'true'
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

const OPEN_DEMO = 'Open the demo strategy'
const RUN_BACKTEST = 'Run a backtest'
const OPEN_RESULTS = 'Open Results'
const OPEN_TRACE = 'Open the Trace'
const EXTRACT = 'Extract a component'

describe('App journey checklist (M13.9)', () => {
  it('a fresh profile shows the checklist with zero ticks', async () => {
    render(<App />)
    expect(isDone(OPEN_DEMO)).toBe(false)
    expect(isDone(RUN_BACKTEST)).toBe(false)
    expect(isDone(OPEN_RESULTS)).toBe(false)
    expect(isDone(OPEN_TRACE)).toBe(false)
    expect(isDone(EXTRACT)).toBe(false)
    await flush()
  })

  it('ticks open-demo when a demo-named strategy is opened', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('open-demo'))
    await waitFor(() => expect(isDone(OPEN_DEMO)).toBe(true))
    await flush()
  })

  it('does NOT tick open-demo for a non-demo document', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('open-blank'))
    await flush()
    expect(isDone(OPEN_DEMO)).toBe(false)
  })

  it('ticks run-backtest and open-results when a run is selected', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('open-demo'))
    // Open the Runs dock tab, then pick a run (onSelectRun opens Results).
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    fireEvent.click(screen.getByText('select-run-1'))
    await waitFor(() => expect(isDone(RUN_BACKTEST)).toBe(true))
    expect(isDone(OPEN_RESULTS)).toBe(true)
    await flush()
  })

  it('ticks open-trace when the Trace dock tab is opened for a selected run', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('open-demo'))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    fireEvent.click(screen.getByText('select-run-1'))
    await waitFor(() => expect(isDone(RUN_BACKTEST)).toBe(true))
    expect(isDone(OPEN_TRACE)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Trace' }))
    await waitFor(() => expect(isDone(OPEN_TRACE)).toBe(true))
    await flush()
  })

  it('ticks extract-component when an extraction commit lands', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('open-demo'))
    fireEvent.click(screen.getByRole('button', { name: 'Extract component' }))
    fireEvent.click(screen.getByText('toggle-n1'))
    fireEvent.click(screen.getByRole('button', { name: 'Create component…' }))
    fireEvent.click(screen.getByText('simulate-extracted'))
    await waitFor(() => expect(isDone(EXTRACT)).toBe(true))
    await flush()
  })

  it('persists ticks across an App remount', async () => {
    const { unmount } = render(<App />)
    fireEvent.click(screen.getByText('open-demo'))
    await waitFor(() => expect(isDone(OPEN_DEMO)).toBe(true))
    await flush()
    unmount()
    render(<App />)
    // Back on Home after remount — the latched tick survived via localStorage.
    expect(isDone(OPEN_DEMO)).toBe(true)
    await flush()
  })

  it('dismiss hides the checklist and the dismissal persists across a remount', async () => {
    const { unmount } = render(<App />)
    expect(screen.getByText(OPEN_DEMO)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText(OPEN_DEMO)).not.toBeInTheDocument()
    await flush()
    unmount()
    render(<App />)
    expect(screen.queryByText(OPEN_DEMO)).not.toBeInTheDocument()
    await flush()
  })
})
