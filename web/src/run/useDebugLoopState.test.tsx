// useDebugLoopState exposes only GATED views of the selected run (M13.7.5 fix pass). The load-bearing
// assertions here are the two consumer-facing guarantees the fix pass added: (1) the exposed run record
// is gated to the selection — the SELECTED run's record or loading, never another run's (finding 8) —
// and (2) the cursor session's `note` is a SINGLE memoized derivation the Trace panel and the atSession
// payload share (finding 6), so App must not re-derive it. Driven through `renderHook`; NO network.
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PersistedNote, PersistedRunRecord, RunRecordResponse } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'

// One record builder (mirrors App.cursor.test): every DTO field is present; callers override the few
// fields a case cares about. The note sits on the LAST EVALUATED session so the default cursor (D-12
// amended) lands on it — letting one fixture exercise both the note derivation and its sharing.
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

const NOTE: PersistedNote = {
  code: 'not_rebalance_session',
  message: 'monthly cadence: next rebalance after 2026-05-14',
  session_date: '2026-05-14',
}
const RUN_1 = record({ notes: [NOTE] }) // producing version s1@1 → monthly (see the mock below)
const RUN_2 = record({
  run_id: 'run-2',
  strategy_id: 's2',
  strategy_version: 2,
  first_session: '2026-06-01',
  last_session: '2026-06-01',
  valuations: [['2026-06-01', 2_000_000]],
  evaluations: [],
  notes: [],
})
// run-3 exercises the cadence-fetch FAILURE path: its producing version (s3@3) rejects.
const RUN_3 = record({ run_id: 'run-3', strategy_id: 's3', strategy_version: 3, notes: [] })
// run-4's RECORD resolves immediately but its version fetch (s4@4) is DEFERRED — so a test can hold a
// PREVIOUS run's already-RESOLVED cadence tag while run-4 is selected, pinning the stale-tag gate.
const RUN_4 = record({ run_id: 'run-4', strategy_id: 's4', strategy_version: 4, notes: [] })

// run-2's fetch is DEFERRED (held pending) so a test can switch to it while it is still in flight and
// assert that the previous run's record never leaks through the gate. The test resolves it at the end.
let run2Resolve: ((r: RunRecordResponse) => void) | null = null
const getRunMock = vi.fn((runId: string): Promise<RunRecordResponse> => {
  if (runId === 'run-1') return Promise.resolve(RUN_1)
  if (runId === 'run-2') return new Promise<RunRecordResponse>((resolve) => (run2Resolve = resolve))
  if (runId === 'run-3') return Promise.resolve(RUN_3)
  if (runId === 'run-4') return Promise.resolve(RUN_4)
  // run-err's RECORD fetch REJECTS — the failed-fetch path whose error must be gated by run identity.
  if (runId === 'run-err') return Promise.reject(new Error('boom-A'))
  return Promise.reject(new Error(`unexpected run ${runId}`))
})

// A minimal persisted strategy version — the hook reads ONLY `.schedule.kind` off it.
function docWithSchedule(kind: 'daily' | 'weekly' | 'monthly'): StrategyDocument {
  return { schedule: { kind } } as unknown as StrategyDocument
}

// run-4's version fetch is held so a test can resolve it AFTER switching away, exercising the stale-tag
// gate rather than the cancellation guard (its effect already resolved before the switch, so cancellation
// is moot; only the `scheduleFetch.runId === selectedRunId` gate can drop the stale tag).
let run4VersionResolve: ((d: StrategyDocument) => void) | null = null

// The producing-version fetch (finding 1): s1@1 → monthly; s3@3 rejects (the failure path); s4@4 is
// DEFERRED (held via run4VersionResolve); anything else (e.g. run-2's s2@2) stays PENDING so the
// run-switch test's cadence fetch never late-fires a setState after the deferred run-2 resolves.
const loadStrategyVersionMock = vi.fn((id: string, version: number): Promise<StrategyDocument> => {
  if (id === 's1' && version === 1) return Promise.resolve(docWithSchedule('monthly'))
  if (id === 's3' && version === 3) return Promise.reject(new Error('no such version'))
  if (id === 's4' && version === 4) return new Promise<StrategyDocument>((resolve) => (run4VersionResolve = resolve))
  return new Promise<StrategyDocument>(() => {})
})

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    getRun: (runId: string) => getRunMock(runId),
    // The hook re-keys a trace fetch on every cursor move; stub it so the memo settles without network.
    getTraceTree: vi.fn().mockResolvedValue({ trees: [] }),
    loadStrategyVersion: (id: string, version: number) => loadStrategyVersionMock(id, version),
  }
})

// eslint-disable-next-line import/first
import { useDebugLoopState } from './useDebugLoopState'

describe('useDebugLoopState (M13.7.5 fix pass)', () => {
  it('without a run exposes no record, is not loading, and derives no cursor/note/atSession', () => {
    const { result } = renderHook(() => useDebugLoopState(undefined))
    expect(result.current.runRecord).toBeUndefined()
    expect(result.current.runRecordLoading).toBe(false)
    expect(result.current.sessionCursor).toBeNull()
    expect(result.current.note).toBeUndefined()
    expect(result.current.atSession).toBeUndefined()
  })

  it('exposes the fetched record GATED to the selection, then stops loading (finding 8)', async () => {
    const { result } = renderHook(() => useDebugLoopState('run-1'))
    await waitFor(() => expect(result.current.runRecord).toBe(RUN_1))
    // Once the SELECTED run's record is in hand it is exposed verbatim and loading has cleared.
    expect(result.current.runRecordLoading).toBe(false)
    expect(result.current.runRecordError).toBeUndefined()
  })

  it('on a run switch whose fetch is unresolved, exposes no record and reads as loading (finding 8)', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useDebugLoopState(id),
      { initialProps: { id: 'run-1' as string | undefined } },
    )
    await waitFor(() => expect(result.current.runRecord).toBe(RUN_1))

    // Switch to run-2 while its fetch is still pending. The previous run's record must NOT leak through
    // the gate: the consumer sees `undefined` + loading, never RUN_1 under run-2. NOTE: this observes the
    // post-switch RESET path (the effect nulls the record + sets loading before the new fetch lands). The
    // exact one-render DEFINED-but-mismatched instant that the `runRecord !== undefined && gated === undefined`
    // fold covers is masked by React's after-paint reset effect + act flushing, so it is unobservable here;
    // that fold term is pinned by the gatedRecord + matchesRun unit tests (projections.test.ts) and the
    // App.cursor run-switch integration.
    rerender({ id: 'run-2' })
    await waitFor(() => expect(result.current.runRecordLoading).toBe(true))
    expect(result.current.runRecord).toBeUndefined()

    // Resolve run-2 so no pending promise / act warning trails the test.
    await act(async () => {
      run2Resolve?.(RUN_2)
      await Promise.resolve()
    })
  })

  it("gates the record-fetch error by run identity: run A's failure never shows under run B", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useDebugLoopState(id),
      { initialProps: { id: 'run-err' as string | undefined } },
    )
    // Run A's record fetch FAILS → its error surfaces under run A.
    await waitFor(() => expect(result.current.runRecordError).toBe('boom-A'))

    // Switch to run-2 while its fetch is still pending. Run A's error must NOT surface under run B: the
    // record-based fold can't catch this (the record is undefined when an error is set), so the error is
    // tagged with the runId it was fetched for and gated to the selection — it clears on the switch, before
    // run B resolves. NOTE: the exact one-render window (the error tag still A's, before the record effect's
    // reset runs) is masked here by React's after-paint reset + act flushing — same as the record fold; the
    // identity-gate MECHANISM (`tag.runId === selectedRunId`) is fail-first-pinned by the schedule stale-tag
    // test below, which exercises the identical gate shape on the sibling cadence tag with no reset to mask it.
    rerender({ id: 'run-2' })
    expect(result.current.runRecordError).toBeUndefined()

    // Resolve run-2 so no pending promise / act warning trails the test.
    await act(async () => {
      run2Resolve?.(RUN_2)
      await Promise.resolve()
    })
  })

  it('derives ONE cursor-session note shared by the run layer and the atSession payload (finding 6)', async () => {
    // The default cursor lands on the last EVALUATED session (2026-05-14), which carries NOTE.
    const { result } = renderHook(() => useDebugLoopState('run-1'))
    await waitFor(() => expect(result.current.sessionCursor).toBe('2026-05-14'))
    // The hook exposes the note once (App threads THIS to TraceView)…
    expect(result.current.note).toBe(NOTE)
    // …and the atSession payload reuses the SAME object — never a second derivation.
    await waitFor(() => expect(result.current.atSession).toBeDefined())
    expect(result.current.atSession?.note).toBe(result.current.note)
    // The payload carries the SELECTED run's id — the value-tap request address needs it.
    expect(result.current.atSession?.runId).toBe('run-1')
  })

  it("sources the cadence from the RUN's producing strategy version, not the live doc (finding 1)", async () => {
    const { result } = renderHook(() => useDebugLoopState('run-1'))
    // The kind comes from loadStrategyVersion resolved for the RECORD's (strategy_id, strategy_version).
    await waitFor(() => expect(result.current.runScheduleKind).toBe('monthly'))
    expect(loadStrategyVersionMock).toHaveBeenCalledWith('s1', 1)
    // The atSession payload carries the same run cadence for the Inspector's no-eval line.
    await waitFor(() => expect(result.current.atSession?.scheduleKind).toBe('monthly'))
  })

  it('leaves runScheduleKind undefined when the version fetch fails, without erroring the record (finding 1)', async () => {
    const { result } = renderHook(() => useDebugLoopState('run-3'))
    // The record path is unaffected by the cadence fetch rejecting…
    await waitFor(() => expect(result.current.runRecord).toBe(RUN_3))
    expect(result.current.runRecordError).toBeUndefined()
    // …and the cadence clause simply drops (deliberate non-fatal display degradation).
    await waitFor(() => expect(loadStrategyVersionMock).toHaveBeenCalledWith('s3', 3))
    expect(result.current.runScheduleKind).toBeUndefined()
  })

  it('gates out a RESOLVED-but-stale cadence tag after switching runs, then reflects the new run (finding 1)', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useDebugLoopState(id),
      { initialProps: { id: 'run-1' as string | undefined } },
    )
    // run-1's version fetch resolves immediately → the tag is { runId: 'run-1', kind: 'monthly' }.
    await waitFor(() => expect(result.current.runScheduleKind).toBe('monthly'))

    // Switch to run-4: its RECORD loads but its version fetch stays PENDING. The scheduleFetch tag is
    // still run-1's RESOLVED 'monthly' (the effect only ever writes, never clears), so cancellation is
    // moot here — ONLY the `scheduleFetch.runId === selectedRunId` gate can keep run-1's monthly from
    // surfacing under run-4. It must read undefined until run-4's own fetch lands.
    rerender({ id: 'run-4' })
    await waitFor(() => expect(result.current.runRecord).toBe(RUN_4))
    expect(result.current.runScheduleKind).toBeUndefined()

    // Now land run-4's version fetch: the cadence reflects ONLY the current selection.
    await act(async () => {
      run4VersionResolve?.(docWithSchedule('weekly'))
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.runScheduleKind).toBe('weekly'))
  })
})
