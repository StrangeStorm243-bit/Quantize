// RunPanel builds backtest/forward request bodies from the form + current doc, omitting blank
// optional sessions and REQUIRING last_session for forward. The api client is mocked (no network).
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunList } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { newStrategyDocument } from '../document/store'
import { RunPanel } from './RunPanel'

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    runBacktest: vi.fn(),
    runForward: vi.fn(),
    listRuns: vi.fn(),
  }
})

// eslint-disable-next-line import/first
import { listRuns, runBacktest, runForward } from '../api/client'

const mockBacktest = vi.mocked(runBacktest)
const mockForward = vi.mocked(runForward)
const mockListRuns = vi.mocked(listRuns)

const DATASET = 'd'.repeat(64)
const EMPTY_RUNS: RunList = { runs: [] }

function makeDoc(): StrategyDocument {
  return newStrategyDocument('t') // version 1, a fresh strategy.id
}

beforeEach(() => {
  mockBacktest.mockReset().mockResolvedValue({ run_id: 'run-new' })
  mockForward.mockReset().mockResolvedValue({ run_id: 'run-fwd' })
  mockListRuns.mockReset().mockResolvedValue(EMPTY_RUNS)
})

describe('RunPanel', () => {
  it('shows an actionable empty state when the strategy has no runs yet', async () => {
    render(
      <RunPanel doc={makeDoc()} datasetId={DATASET} selectedRunId={undefined} onSelectRun={vi.fn()} />,
    )
    // The list fetch resolves to an empty list → an honest "no runs yet" line pointing at the form.
    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument()
  })

  it('builds a backtest request from the doc + defaults, omitting blank sessions', async () => {
    const doc = makeDoc()
    render(
      <RunPanel doc={doc} datasetId={DATASET} selectedRunId={undefined} onSelectRun={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /run backtest/i }))

    await waitFor(() =>
      expect(mockBacktest).toHaveBeenCalledWith({
        dataset_id: DATASET,
        strategy_id: doc.strategy.id,
        strategy_version: doc.strategy.version,
        initial_cash: 1_000_000,
      }),
    )
  })

  it('includes first/last sessions when provided', async () => {
    const doc = makeDoc()
    render(
      <RunPanel doc={doc} datasetId={DATASET} selectedRunId={undefined} onSelectRun={vi.fn()} />,
    )

    fireEvent.change(screen.getByLabelText(/first session/i), { target: { value: '2025-07-31' } })
    fireEvent.change(screen.getByLabelText(/last session/i), { target: { value: '2025-08-29' } })
    fireEvent.click(screen.getByRole('button', { name: /run backtest/i }))

    await waitFor(() =>
      expect(mockBacktest).toHaveBeenCalledWith({
        dataset_id: DATASET,
        strategy_id: doc.strategy.id,
        strategy_version: doc.strategy.version,
        initial_cash: 1_000_000,
        first_session: '2025-07-31',
        last_session: '2025-08-29',
      }),
    )
  })

  it('blocks a forward run with no last_session, then includes it once provided', async () => {
    const doc = makeDoc()
    render(
      <RunPanel doc={doc} datasetId={DATASET} selectedRunId={undefined} onSelectRun={vi.fn()} />,
    )

    // Switch to paper-replay mode (the existing forward endpoint, honestly renamed in M13.3).
    fireEvent.change(screen.getByLabelText(/run mode/i), { target: { value: 'forward' } })
    // Submit with a blank last_session is gated client-side — the request is NOT sent.
    fireEvent.click(screen.getByRole('button', { name: /run paper replay/i }))
    expect(await screen.findByText(/last session is required/i)).toBeInTheDocument()
    expect(mockForward).not.toHaveBeenCalled()

    // Provide last_session → the forward request includes it.
    fireEvent.change(screen.getByLabelText(/last session/i), { target: { value: '2025-08-29' } })
    fireEvent.click(screen.getByRole('button', { name: /run paper replay/i }))
    await waitFor(() =>
      expect(mockForward).toHaveBeenCalledWith({
        dataset_id: DATASET,
        strategy_id: doc.strategy.id,
        strategy_version: doc.strategy.version,
        initial_cash: 1_000_000,
        last_session: '2025-08-29',
      }),
    )
  })

  it('rejects an empty initial-cash field instead of submitting a silent $0 run (F3)', async () => {
    const doc = makeDoc()
    render(
      <RunPanel doc={doc} datasetId={DATASET} selectedRunId={undefined} onSelectRun={vi.fn()} />,
    )
    await waitFor(() => expect(mockListRuns).toHaveBeenCalled()) // flush the mount fetch

    // Clear the cash field, then submit. `Number('') === 0` would pass the finiteness guard, so the
    // blank must be caught first — no request is sent.
    fireEvent.change(screen.getByLabelText(/initial cash/i), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /run backtest/i }))

    expect(await screen.findByText(/initial cash is required/i)).toBeInTheDocument()
    expect(mockBacktest).not.toHaveBeenCalled()
  })

  it('disables submit when no dataset is selected', async () => {
    render(
      <RunPanel doc={makeDoc()} datasetId={undefined} selectedRunId={undefined} onSelectRun={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: /run backtest/i })).toBeDisabled()
    // Flush the mount refresh inside act so the async list update does not leak past the test.
    await waitFor(() => expect(mockListRuns).toHaveBeenCalled())
  })

  it('refreshes the run list and selects the new run after a submit', async () => {
    const doc = makeDoc()
    const onSelect = vi.fn()
    render(
      <RunPanel doc={doc} datasetId={DATASET} selectedRunId={undefined} onSelectRun={onSelect} />,
    )
    await waitFor(() => expect(mockListRuns).toHaveBeenCalledTimes(1)) // mount

    fireEvent.click(screen.getByRole('button', { name: /run backtest/i }))

    await waitFor(() => expect(mockBacktest).toHaveBeenCalled())
    await waitFor(() => expect(mockListRuns).toHaveBeenCalledTimes(2)) // refreshed
    expect(onSelect).toHaveBeenCalledWith('run-new')
  })
})

describe('RunPanel run-list display (D-27)', () => {
  it("renders a run row's return through the shared display formatter, verbatim in the title", async () => {
    mockListRuns.mockResolvedValue({
      runs: [
        {
          run_id: 'run-1',
          mode: 'backtest',
          ok: true,
          total_return: 0.025015130971708377,
          first_session: null,
          last_session: null,
          saved_at: '2026-07-16T00:00:00Z',
          strategy_id: 's1',
          strategy_version: 2,
        },
      ],
    })
    render(
      <RunPanel doc={makeDoc()} datasetId={DATASET} selectedRunId={undefined} onSelectRun={vi.fn()} />,
    )
    // The 17-digit served float displays trimmed (never raw); the NUMBER's own element carries the
    // bare verbatim value in its title (the shared verbatim-title shape — no label baked in).
    const value = await screen.findByText('0.025')
    expect(value).toHaveAttribute('title', '0.025015130971708377')
    // The row meta still reads as one line around it.
    expect(screen.getByText(/backtest · ok · ret/)).toBeInTheDocument()
  })
})

describe('RunPanel execution-mode framing (M13.3)', () => {
  it('shows a persistent simulation-only notice at the run-launch surface', async () => {
    render(
      <RunPanel doc={makeDoc()} datasetId={DATASET} selectedRunId={undefined} onSelectRun={vi.fn()} />,
    )
    expect(await screen.findByText(/simulations over local data/i)).toBeInTheDocument()
    expect(screen.getByText(/no live trading/i)).toBeInTheDocument()
  })

  it('presents Backtest + Paper replay as available modes and Live as explicitly deferred', async () => {
    render(
      <RunPanel doc={makeDoc()} datasetId={DATASET} selectedRunId={undefined} onSelectRun={vi.fn()} />,
    )
    await screen.findByRole('option', { name: 'Backtest' })
    expect(screen.getByRole('option', { name: 'Paper replay' })).toBeInTheDocument()
    const live = screen.getByRole('option', { name: /Live/ })
    expect(live).toBeDisabled()
    expect(live.textContent).toMatch(/not available|future/i)
  })
})
