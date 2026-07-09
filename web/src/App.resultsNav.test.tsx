// App results→trace navigation (M13.7, Task 4): selecting a session from the Results view (the chart,
// an evaluation row, or a fill row) sets the shared session cursor AND opens the Trace tab. We keep the
// REAL StrategyBar + Dock mounted so we can assert (1) the cursor readout reflects the chosen SERVER
// date and (2) the dock actually switched to the Trace panel. ResultsView is stubbed to a single button
// that fires `props.onSelectSession('2026-05-14')` — the same callback the real chart/rows invoke — so
// the test drives the App's wiring without depending on the view's internal markup.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PersistedRunRecord, RunRecordResponse } from '@quantize/quantize-api'

// A record whose valuations include 2026-05-14, so the chosen session is a real server session date.
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
      ['2026-05-14', 1_000_100],
      ['2026-05-15', 1_000_200],
    ],
    returns: [0.0, 0.0001, 0.0001],
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
  }
})

vi.mock('./components/Canvas', () => ({ Canvas: () => <div /> }))
vi.mock('./components/Palette', () => ({ Palette: () => <div /> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div /> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div /> }))
// RunPanel is mounted while the Runs tab is active; its stub exposes the run-select button.
vi.mock('./components/RunPanel', () => ({
  RunPanel: (props: { onSelectRun: (id: string) => void }) => (
    <button type="button" onClick={() => props.onSelectRun('run-1')}>
      select-run-1
    </button>
  ),
}))
// ResultsView stub: one button that fires the App's onSelectSession with a real server session date —
// standing in for a chart click / evaluation row / fill row (all invoke the same callback).
vi.mock('./components/ResultsView', () => ({
  ResultsView: (props: { onSelectSession?: (date: string) => void }) => (
    <button type="button" onClick={() => props.onSelectSession?.('2026-05-14')}>
      results-select-session
    </button>
  ),
}))
// TraceView stub: identifiable content so we can assert the dock switched to the Trace panel.
vi.mock('./components/TraceView', () => ({ TraceView: () => <div>trace-panel-content</div> }))
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

function cursorReadout(): HTMLElement {
  return screen.getByLabelText('session cursor')
}

describe('App results→trace navigation (M13.7)', () => {
  it('selecting a session from Results sets the cursor and opens the Trace tab', async () => {
    renderEditor()
    // Pick a run (opens the Results tab; the record loads and defaults the cursor to the last session).
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    fireEvent.click(screen.getByText('select-run-1'))
    await waitFor(() => expect(cursorReadout()).toHaveTextContent('2026-05-15'))

    // Fire the Results view's session selection (same callback the chart/rows use).
    fireEvent.click(screen.getByText('results-select-session'))

    // The cursor moves to the chosen server date, and the dock switches to the Trace panel.
    expect(cursorReadout()).toHaveTextContent('2026-05-14')
    expect(screen.getByText('trace-panel-content')).toBeInTheDocument()

    // Flush the trace-tree re-fetch (stubbed) so its trailing state update lands inside act().
    await act(async () => {
      await Promise.resolve()
    })
  })
})
