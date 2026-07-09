// App session-cursor lifecycle (M13.7, Task 1): the App owns ONE `sessionCursor` drawn exclusively
// from the selected run's server session dates. On run select it defaults to that run's LAST session
// (D-12); on a run switch it is cleared and re-defaulted to the new run's last session; without a run
// it is absent (—). The cursor derives nothing (invariant 5) — the strategy bar only navigates by
// list index over the served date array. We mock the API client + all children that would hit the
// network, but keep the REAL StrategyBar mounted so we can assert on its cursor readout + stepper.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PersistedRunRecord, RunRecordResponse } from '@quantize/quantize-api'

// One record builder (mirrors ResultsView.test): every field is present so the DTO type is satisfied;
// callers override run_id / valuations / evaluations per case.
function record(overrides: Partial<PersistedRunRecord> = {}): RunRecordResponse {
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
    evaluations: [
      {
        session_date: '2026-05-15',
        evaluation_instant: '2026-05-15T20:00:00Z',
        ok: true,
        orders: [],
        plans: [],
        portfolio_value: 1_000_200,
        projected_cash: 0,
        scheduled_fill_instant: '2026-05-18T13:30:00Z',
        fill_session: '2026-05-18',
        target_cash: 0,
        target_weights: [],
      },
    ],
    fills: [],
    notes: [],
    diagnostics: [],
    stale_marks: [],
    strategy_id: 's1',
    strategy_version: 1,
    input_provenance: { status: 'recorded', dataset_hash: 'abc', calendar_hash: 'def' },
    ...overrides,
  }
  return { record: rec, replay_verifiable: true }
}

// getRun resolves a per-id record so a run switch yields DIFFERENT server dates.
const RUN_1 = record()
const RUN_2 = record({
  run_id: 'run-2',
  first_session: '2026-06-01',
  last_session: '2026-06-02',
  valuations: [
    ['2026-06-01', 2_000_000],
    ['2026-06-02', 2_000_500],
  ],
  evaluations: [],
})
const getRunMock = vi.fn((runId: string): Promise<RunRecordResponse> => {
  if (runId === 'run-2') return Promise.resolve(RUN_2)
  return Promise.resolve(RUN_1)
})

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
    getRun: (runId: string) => getRunMock(runId),
  }
})

vi.mock('./components/Canvas', () => ({ Canvas: () => <div /> }))
vi.mock('./components/Palette', () => ({ Palette: () => <div /> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div /> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div /> }))
// RunPanel is only mounted while the Runs dock tab is active; its stub exposes a button per run id
// that drives the App's onSelectRun (the real path a user takes to pick a run).
vi.mock('./components/RunPanel', () => ({
  RunPanel: (props: { onSelectRun: (id: string) => void }) => (
    <div>
      <button type="button" onClick={() => props.onSelectRun('run-1')}>
        select-run-1
      </button>
      <button type="button" onClick={() => props.onSelectRun('run-2')}>
        select-run-2
      </button>
    </div>
  ),
}))
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

// Open the Runs dock tab (so the RunPanel stub mounts), then pick the given run.
function selectRun(id: 'run-1' | 'run-2'): void {
  fireEvent.click(screen.getByRole('button', { name: 'Run' }))
  fireEvent.click(screen.getByText(id === 'run-1' ? 'select-run-1' : 'select-run-2'))
}

function cursorReadout(): HTMLElement {
  return screen.getByLabelText('session cursor')
}

describe('App session cursor (M13.7)', () => {
  it("sets the cursor to the run's LAST session when the record arrives (D-12)", async () => {
    renderEditor()
    selectRun('run-1')
    await waitFor(() => expect(cursorReadout()).toHaveTextContent('2026-05-15'))
  })

  it("clears the cursor on run switch and re-defaults to the new run's last session", async () => {
    renderEditor()
    selectRun('run-1')
    await waitFor(() => expect(cursorReadout()).toHaveTextContent('2026-05-15'))

    // Switching to run-2 clears the cursor (— while the new record loads) then re-defaults to run-2's
    // last session — a date drawn EXCLUSIVELY from run-2's own valuations, never run-1's.
    selectRun('run-2')
    await waitFor(() => expect(cursorReadout()).toHaveTextContent('2026-06-02'))
    expect(cursorReadout()).not.toHaveTextContent('2026-05-15')
  })

  it("steps the cursor with ◀ / ▶ bounded by the run's session list", async () => {
    renderEditor()
    selectRun('run-1')
    await waitFor(() => expect(cursorReadout()).toHaveTextContent('2026-05-15'))

    const prev = (): HTMLElement => screen.getByLabelText('previous session')
    const next = (): HTMLElement => screen.getByLabelText('next session')

    // ◀ twice walks back to the first session, where ◀ then disables.
    fireEvent.click(prev())
    fireEvent.click(prev())
    expect(cursorReadout()).toHaveTextContent('2026-05-13')
    expect(prev()).toBeDisabled()

    // ▶ three times walks to the last session and stops there (bounded), where ▶ disables.
    fireEvent.click(next())
    fireEvent.click(next())
    fireEvent.click(next())
    expect(cursorReadout()).toHaveTextContent('2026-05-15')
    expect(next()).toBeDisabled()
  })

  it('renders no stepper and an em-dash without a run', async () => {
    renderEditor()
    // No run selected yet → the readout is a bare em-dash with no navigation buttons.
    expect(cursorReadout()).toHaveTextContent('—')
    expect(screen.queryByLabelText('previous session')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('next session')).not.toBeInTheDocument()
    // Flush the boot effects (schema check etc.) so no act() warning trails the test.
    await act(async () => {
      await Promise.resolve()
    })
  })
})
