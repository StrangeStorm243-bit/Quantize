// App session-cursor lifecycle (M13.7, Task 1; default amended M13.7.5): the App owns ONE
// `sessionCursor` drawn exclusively from the selected run's server session dates. On run select it
// defaults to that run's LAST EVALUATED session (D-12 as amended — the old last-session default
// stranded monthly strategies on a no-evaluation session), falling back to the last session for a
// run with no evaluations; on a run switch it is cleared and re-defaulted from the new run's record;
// without a run it is absent (—). The cursor derives nothing and NEVER touches the document
// (invariant 5 / D-12) — the strategy bar only navigates by list index over the served date array.
// We mock the API client + all children that would hit the network, but keep the REAL StrategyBar
// mounted so we can assert on its cursor readout + stepper.
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
    // The ONLY evaluation is on the MIDDLE session (2026-05-14), so the last evaluated session
    // differs from the last session (2026-05-15) — the fixture can therefore distinguish the amended
    // D-12 default (last evaluated) from the old one (last session).
    evaluations: [
      {
        session_date: '2026-05-14',
        evaluation_instant: '2026-05-14T20:00:00Z',
        ok: true,
        orders: [],
        plans: [],
        portfolio_value: 1_000_100,
        projected_cash: 0,
        scheduled_fill_instant: '2026-05-15T13:30:00Z',
        fill_session: '2026-05-15',
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
// A one-shot deferral hook for run-1: when `deferRun1` is set, the NEXT getRun('run-1') returns a
// promise this test resolves manually — so we can hold run-1 in-flight, switch away, and resolve it
// late to exercise the effect's `cancelled` guard (the trickiest, otherwise-untested path).
let deferRun1 = false
let run1Resolve: ((r: RunRecordResponse) => void) | null = null
const getRunMock = vi.fn((runId: string): Promise<RunRecordResponse> => {
  if (runId === 'run-2') return Promise.resolve(RUN_2)
  if (runId === 'run-1' && deferRun1) {
    deferRun1 = false // consume the deferral so only the FIRST run-1 fetch is held open
    return new Promise<RunRecordResponse>((resolve) => {
      run1Resolve = resolve
    })
  }
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
    // The App lifts the trace-tree fetch (M13.7 Task 2) and re-keys it on every cursor move; stub it so
    // stepping the cursor here neither hits the network nor leaves an async state update untested.
    getTraceTree: vi.fn().mockResolvedValue({ trees: [] }),
    // The debug-loop hook fetches the RUN's producing strategy version for its cadence (M13.7 fix pass);
    // stub it so selecting a run never touches the network (only `.schedule.kind` is read).
    loadStrategyVersion: vi.fn().mockResolvedValue({ schedule: { kind: 'daily' } }),
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
// The app opens on Home (M13.3); a Home stub enters the editor via onNew. The App also imports
// DEMO_NAME from Home (M13.9 journey inference), so the mock must re-export it.
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

// Open the Runs dock tab (so the RunPanel stub mounts), then pick the given run.
function selectRun(id: 'run-1' | 'run-2'): void {
  fireEvent.click(screen.getByRole('button', { name: 'Run' }))
  fireEvent.click(screen.getByText(id === 'run-1' ? 'select-run-1' : 'select-run-2'))
}

function cursorReadout(): HTMLElement {
  return screen.getByLabelText('session cursor')
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('App session cursor (M13.7)', () => {
  it("defaults the cursor to the run's LAST EVALUATED session when the record arrives (D-12 amended)", async () => {
    // run-1's only evaluation is on the MIDDLE session (2026-05-14); the amended D-12 default lands
    // there (the most recent DECISION), NOT on the last session (2026-05-15) the old default stranded on.
    renderEditor()
    selectRun('run-1')
    await waitFor(() => expect(cursorReadout()).toHaveTextContent('2026-05-14'))
    expect(cursorReadout()).not.toHaveTextContent('2026-05-15')
  })

  it("falls back to the run's LAST session when the run has NO evaluated sessions", async () => {
    // run-2 evaluated nothing, so there is no "last decision" to land on; the cursor defaults to the
    // last server session (2026-06-02) — a served-date selection, never a computed date.
    renderEditor()
    selectRun('run-2')
    await waitFor(() => expect(cursorReadout()).toHaveTextContent('2026-06-02'))
  })

  it('never writes the cursor into the document: defaulting + stepping leaves the doc clean (D-12)', async () => {
    // The cursor is app-level presentation state; it must never touch the strategy document (invariant
    // 5 / D-12). A freshly created doc is clean, and every mutation returns a NEW object, so if a cursor
    // change reached the document the dirty ("unsaved changes") indicator would appear. It must not.
    renderEditor()
    selectRun('run-1')
    await waitFor(() => expect(cursorReadout()).toHaveTextContent('2026-05-14'))
    expect(screen.queryByLabelText('unsaved changes')).not.toBeInTheDocument()

    // Stepping the cursor over the served axis still leaves the document clean.
    fireEvent.click(screen.getByLabelText('previous session'))
    expect(cursorReadout()).toHaveTextContent('2026-05-13')
    expect(screen.queryByLabelText('unsaved changes')).not.toBeInTheDocument()
    await flush()
  })

  it('clears the cursor on run switch, then re-defaults; a late-resolving prior fetch is ignored', async () => {
    // Hold run-1's fetch in-flight so the switch happens WHILE run-1 is still loading — exercising the
    // effect's `cancelled` guard and the memo's run_id gate together. A regression dropping either would
    // let run-1's stale last session (or dates) win once its promise resolves late.
    deferRun1 = true
    renderEditor()
    selectRun('run-1')
    // run-1 is pending: no record yet → empty axis → the readout is the bare em-dash (transient clear).
    await flush()
    expect(cursorReadout()).toHaveTextContent('—')
    expect(screen.queryByLabelText('previous session')).not.toBeInTheDocument()

    // Switch to run-2 (resolves normally). Its cursor defaults to run-2's OWN last session.
    selectRun('run-2')
    await waitFor(() => expect(cursorReadout()).toHaveTextContent('2026-06-02'))

    // Now resolve run-1 LATE. The prior effect was cancelled on switch, so its .then must not fire:
    // the cursor stays on run-2's date and never flips to run-1's last session (2026-05-15).
    await act(async () => {
      run1Resolve?.(RUN_1)
      await Promise.resolve()
    })
    expect(cursorReadout()).toHaveTextContent('2026-06-02')
    expect(cursorReadout()).not.toHaveTextContent('2026-05-15')
  })

  it("steps the cursor with ◀ / ▶ bounded by the run's session list", async () => {
    renderEditor()
    selectRun('run-1')
    // The cursor defaults to the last EVALUATED session (2026-05-14, the middle of the axis).
    await waitFor(() => expect(cursorReadout()).toHaveTextContent('2026-05-14'))

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

    // Each cursor move re-keys the App's lifted trace-tree fetch; flush its (stubbed) resolution so
    // the trailing state update lands inside act() rather than after the test.
    await flush()
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
