// App → Canvas value-probe threading (M14.3, Task 5). The edge-hover readout's run/cursor half is the
// `valueProbe` the App derives from the debug-loop `atSession` and hands to the Canvas. The honest
// integration seam here is PROP CORRECTNESS: driving a real edge hover through the App is impractical
// under jsdom (React Flow renders no edge DOM — the Task-4 finding), and the hover/pin behaviour is
// already proven at the FlowReadout/Canvas level. So we STUB Canvas with a recording stub that captures
// `valueProbe` on every render, select runs through the real StrategyBar/RunPanel path (as
// App.cursor.test.tsx does), and assert the four scalar fields track the selection — plus that the probe
// reference stays STABLE across an unrelated App re-render (the memoization contract). NO network.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PersistedRunRecord, RunRecordResponse } from '@quantize/quantize-api'
import type { FlowProbe } from './components/FlowReadout'

// One record builder (mirrors App.cursor.test): every field present so the DTO type is satisfied;
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
    // The ONLY evaluation is on the MIDDLE session (2026-05-14) → the last EVALUATED session (the D-12
    // cursor default) differs from the last session, and `evaluated` is true there.
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

const RUN_1 = record()
// run-2 evaluated NOTHING → its cursor defaults to the last session (2026-06-02) and `evaluated` is false.
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

const getRunMock = vi.fn((runId: string): Promise<RunRecordResponse> =>
  Promise.resolve(runId === 'run-2' ? RUN_2 : RUN_1),
)

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
    getTraceTree: vi.fn().mockResolvedValue({ trees: [] }),
    // The probe's scheduleKind comes from the RUN's producing strategy version (M13.7): 'daily' here.
    loadStrategyVersion: vi.fn().mockResolvedValue({ schedule: { kind: 'daily' } }),
    // Stubbed but never invoked — the Canvas is a recording stub, so no readout fetch fires through it.
    getNodeValue: vi.fn(),
  }
})

// The Canvas recording stub: capture `valueProbe` on EVERY render into a hoisted list. Recording per
// render (not a single post-action read) is what lets us prove the run-switch never flashes the old
// run's probe and that the memoized reference is stable across an unrelated re-render.
const rec = vi.hoisted(() => ({ probes: [] as Array<FlowProbe | undefined> }))
vi.mock('./components/Canvas', () => ({
  Canvas: (props: { valueProbe?: FlowProbe | undefined }) => {
    rec.probes.push(props.valueProbe)
    return <div data-testid="canvas-stub" />
  },
}))
vi.mock('./components/Palette', () => ({ Palette: () => <div /> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div /> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div /> }))
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

function selectRun(id: 'run-1' | 'run-2'): void {
  fireEvent.click(screen.getByRole('button', { name: 'Run' }))
  fireEvent.click(screen.getByText(id === 'run-1' ? 'select-run-1' : 'select-run-2'))
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function lastProbe(): FlowProbe | undefined {
  return rec.probes.at(-1)
}

describe('App value-probe threading (M14.3)', () => {
  it('passes no probe when no run is selected', async () => {
    renderEditor()
    await flush()
    // Every render so far — the editor with no run selected — carried an undefined probe.
    expect(rec.probes.length).toBeGreaterThan(0)
    expect(rec.probes.every((p) => p === undefined)).toBe(true)
  })

  it('threads the four probe fields from atSession once a run + evaluated cursor exist', async () => {
    renderEditor()
    selectRun('run-1')
    // The cursor defaults to the last EVALUATED session (2026-05-14); the scheduleKind resolves to
    // 'daily' from the run's producing version. The final probe carries all four fields.
    await waitFor(() =>
      expect(lastProbe()).toEqual({
        runId: 'run-1',
        cursor: '2026-05-14',
        evaluated: true,
        scheduleKind: 'daily',
      }),
    )
  })

  it('tracks the new run on a switch and never flashes the old run id afterward', async () => {
    renderEditor()
    selectRun('run-1')
    await waitFor(() => expect(lastProbe()?.runId).toBe('run-1'))
    await waitFor(() => expect(lastProbe()?.cursor).toBe('2026-05-14'))

    // Open the Runs tab FIRST — run-1 is still legitimately the selected run for that re-render, so the
    // switch commit we mark is the run-2 selection itself, not the tab change. Capture the index right
    // before it so `after` covers only renders at-or-past the switch.
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const switchIdx = rec.probes.length
    fireEvent.click(screen.getByText('select-run-2'))
    // run-2 evaluated nothing → cursor defaults to its last session, evaluated:false.
    await waitFor(() =>
      expect(lastProbe()).toEqual({
        runId: 'run-2',
        cursor: '2026-06-02',
        evaluated: false,
        scheduleKind: 'daily',
      }),
    )
    // No render committed after the switch ever carried run-1 (it is either the blank transition —
    // undefined, gated off-axis — or the new run's probe). The stale-address one-frame guarantee.
    const after = rec.probes.slice(switchIdx)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((p) => p === undefined || p.runId !== 'run-1')).toBe(true)
  })

  it('keeps the probe reference stable across an unrelated App re-render (memoization)', async () => {
    renderEditor()
    selectRun('run-1')
    // Wait until the probe has fully settled (scheduleKind resolved) so the baseline is stable.
    await waitFor(() =>
      expect(lastProbe()).toEqual({
        runId: 'run-1',
        cursor: '2026-05-14',
        evaluated: true,
        scheduleKind: 'daily',
      }),
    )
    await flush()

    const before = lastProbe()
    const countBefore = rec.probes.length
    // An unrelated App-level state poke: toggling the theme re-renders AppShell (hence the Canvas stub)
    // without touching any atSession field. The memoized probe must be the SAME reference.
    fireEvent.click(screen.getByRole('button', { name: /switch to/i }))
    await flush()

    expect(rec.probes.length).toBeGreaterThan(countBefore) // the re-render did happen
    const after = lastProbe()
    expect(Object.is(after, before)).toBe(true)
  })
})
