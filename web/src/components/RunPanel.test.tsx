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

    // Switch to forward mode.
    fireEvent.change(screen.getByLabelText(/run mode/i), { target: { value: 'forward' } })
    // Submit with a blank last_session is gated client-side — the request is NOT sent.
    fireEvent.click(screen.getByRole('button', { name: /run forward/i }))
    expect(await screen.findByText(/last session is required/i)).toBeInTheDocument()
    expect(mockForward).not.toHaveBeenCalled()

    // Provide last_session → the forward request includes it.
    fireEvent.change(screen.getByLabelText(/last session/i), { target: { value: '2025-08-29' } })
    fireEvent.click(screen.getByRole('button', { name: /run forward/i }))
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
