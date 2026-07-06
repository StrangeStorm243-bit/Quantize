// ResultsView renders a run record's stats, fills, and evaluations — EVERY number comes from the
// record (invariant 5). The record is now OWNED BY THE APP and passed in as a prop (M11.9, F7); the
// view is presentational (no fetch of its own). An ok:false record still renders (a valid run to
// inspect, not an error).
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PersistedRunRecord, RunRecordResponse } from '@quantize/quantize-api'
import { ResultsView } from './ResultsView'

function record(overrides: Partial<PersistedRunRecord> = {}): PersistedRunRecord {
  return {
    run_id: 'run-1',
    record_format: 1,
    mode: 'backtest',
    ok: true,
    exchange: 'XNYS',
    timezone: 'America/New_York',
    first_session: '2025-07-31',
    last_session: '2025-08-29',
    valuations: [
      ['2025-07-31', 1_000_000],
      ['2025-08-29', 1_050_000],
    ],
    returns: [0.0, 0.05],
    total_return: 0.05,
    max_drawdown: -0.02,
    final_cash: 12_345.67,
    final_positions: [['SPY', 100]],
    evaluations: [
      {
        session_date: '2025-07-31',
        evaluation_instant: '2025-07-31T20:00:00Z',
        ok: true,
        orders: [{ side: 'buy', asset: 'SPY', quantity: 100 }],
        plans: [],
        portfolio_value: 1_000_000,
        projected_cash: 0,
        scheduled_fill_instant: '2025-08-01T13:30:00Z',
        fill_session: '2025-08-01',
        target_cash: 0,
        target_weights: [['SPY', 1.0]],
      },
    ],
    fills: [
      {
        session_date: '2025-08-01',
        actual_fill_instant: '2025-08-01T13:30:00Z',
        side: 'buy',
        asset: 'SPY',
        quantity: 100,
        price: 500.0,
        cost: 0,
        cash_delta: -50_000,
        scaled: false,
      },
    ],
    notes: [],
    diagnostics: [],
    stale_marks: [],
    strategy_id: 's1',
    strategy_version: 1,
    input_provenance: { status: 'recorded', dataset_hash: 'abc', calendar_hash: 'def' },
    ...overrides,
  }
}

function response(rec: PersistedRunRecord, replay_verifiable = true): RunRecordResponse {
  return { record: rec, replay_verifiable }
}

describe('ResultsView', () => {
  it('renders stats, a fills row, an evaluations row, and the replay badge from the record', () => {
    render(<ResultsView runId="run-1" record={response(record())} loading={false} error={undefined} />)

    // Stats are the raw record fields (formatted for display with toFixed, never derived).
    expect(screen.getByText('0.0500')).toBeInTheDocument() // total_return
    expect(screen.getByText('-0.0200')).toBeInTheDocument() // max_drawdown
    // A fills row (asset SPY appears in both the fills and evaluations tables).
    expect(screen.getAllByText('SPY').length).toBeGreaterThan(0)
    expect(screen.getByText('500')).toBeInTheDocument() // fill price, verbatim
    // The D+1 fill session (2025-08-01) appears in both the fills row and the evaluation fill_session.
    expect(screen.getAllByText('2025-08-01').length).toBeGreaterThan(0)
    // replay_verifiable badge.
    expect(screen.getByText(/replay/i)).toBeInTheDocument()
  })

  it('renders an ok:false record as a valid run (not an error)', () => {
    // runId must match the record's run_id — a mismatch renders as loading (the identity guard).
    render(
      <ResultsView
        runId="run-1"
        record={response(record({ ok: false, fills: [], evaluations: [] }), false)}
        loading={false}
        error={undefined}
      />,
    )

    // The failed run still renders its stats — ok:false is a run FACT, not an HTTP error.
    expect(screen.getByText(/failed|not ok|ok: no/i)).toBeInTheDocument()
    expect(screen.getByText('0.0500')).toBeInTheDocument()
  })

  it('shows the loading state while the App fetches the record', () => {
    render(<ResultsView runId="run-1" record={undefined} loading={true} error={undefined} />)
    expect(screen.getByText(/loading run/i)).toBeInTheDocument()
  })

  it("never paints another run's record: a run_id mismatch renders as loading", () => {
    // During a run switch the App briefly still holds the previous run's record (its reset effect
    // runs after paint). The view must not show run A's numbers under run B's selection.
    render(
      <ResultsView runId="run-B" record={response(record())} loading={false} error={undefined} />,
    )
    expect(screen.getByText(/loading run/i)).toBeInTheDocument()
    expect(screen.queryByText('backtest')).not.toBeInTheDocument()
  })

  it('surfaces a record-fetch error passed from the App', () => {
    render(<ResultsView runId="run-1" record={undefined} loading={false} error="boom" />)
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })

  it('renders nothing actionable when no run is selected', () => {
    render(<ResultsView runId={undefined} record={undefined} loading={false} error={undefined} />)
    expect(screen.getByText(/select a run/i)).toBeInTheDocument()
  })
})
