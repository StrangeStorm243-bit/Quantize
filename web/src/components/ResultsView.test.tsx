// ResultsView renders a run record's stats, fills, and evaluations — EVERY number comes from the
// record (invariant 5). The record is now OWNED BY THE APP and passed in as a prop (M11.9, F7); the
// view is presentational (no fetch of its own). An ok:false record still renders (a valid run to
// inspect, not an error).
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

    // Stats are the raw record fields, rendered through the ONE shared display formatter (D-27:
    // trailing zeros trimmed, no padding) with the verbatim served number kept in the title.
    const totalReturn = screen.getByText('0.05') // total_return
    expect(totalReturn).toBeInTheDocument()
    expect(totalReturn).toHaveAttribute('title', '0.05')
    expect(screen.getByText('-0.02')).toBeInTheDocument() // max_drawdown
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
    expect(screen.getByText('0.05')).toBeInTheDocument()
  })

  it('shows the loading state while the App fetches the record', () => {
    render(<ResultsView runId="run-1" record={undefined} loading={true} error={undefined} />)
    expect(screen.getByText(/loading run/i)).toBeInTheDocument()
  })

  it('is presentational: renders the record it is given (the run-identity gate moved upstream)', () => {
    // The run-switch stale-window guard now lives in useDebugLoopState (run/projections gatedRecord):
    // the App hands ResultsView the SELECTED run's record or `loading`, never a mismatch. ResultsView no
    // longer re-gates on run_id — it renders the record it is passed, trusting that upstream contract.
    render(
      <ResultsView runId="run-1" record={response(record())} loading={false} error={undefined} />,
    )
    expect(screen.getByText('backtest')).toBeInTheDocument()
    expect(screen.queryByText(/loading run/i)).not.toBeInTheDocument()
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

describe('ResultsView interactivity (M13.7)', () => {
  it('clicking an evaluation row session button selects that session', () => {
    const onSelectSession = vi.fn()
    render(
      <ResultsView
        runId="run-1"
        record={response(record())}
        loading={false}
        error={undefined}
        onSelectSession={onSelectSession}
      />,
    )
    // The evaluation row's session date (2025-07-31) is wrapped in a button; clicking it selects it.
    fireEvent.click(screen.getByRole('button', { name: '2025-07-31' }))
    expect(onSelectSession).toHaveBeenCalledWith('2025-07-31')
  })

  it('clicking a fill row session button selects the fill session', () => {
    const onSelectSession = vi.fn()
    render(
      <ResultsView
        runId="run-1"
        record={response(record())}
        loading={false}
        error={undefined}
        onSelectSession={onSelectSession}
      />,
    )
    // The fill's session date (2025-08-01) is a row button; clicking it selects that session.
    fireEvent.click(screen.getByRole('button', { name: '2025-08-01' }))
    expect(onSelectSession).toHaveBeenCalledWith('2025-08-01')
  })

  it('groups the fills under an explicit Engine section with targets → orders → fills framing', () => {
    render(
      <ResultsView
        runId="run-1"
        record={response(record())}
        loading={false}
        error={undefined}
        onSelectSession={() => {}}
      />,
    )
    const engine = screen.getByRole('region', { name: 'engine stage' })
    // The engine framing copy and the Fills table both live inside the Engine section.
    expect(within(engine).getByText(/targets → orders → fills/i)).toBeInTheDocument()
    expect(within(engine).getByText(/^Fills/)).toBeInTheDocument()
  })

  it("renders each evaluation's served target weights (the Target Portfolio)", () => {
    render(<ResultsView runId="run-1" record={response(record())} loading={false} error={undefined} />)
    // target_weights [['SPY', 1.0]] → the served asset + its weight through the shared display
    // formatter (D-27: trimmed, verbatim in title — no derivation).
    const weight = screen.getByText('SPY 1')
    expect(weight).toBeInTheDocument()
    expect(weight).toHaveAttribute('title', '1')
  })

  it("renders each evaluation's served orders (side / asset / quantity)", () => {
    render(<ResultsView runId="run-1" record={response(record())} loading={false} error={undefined} />)
    // orders [{ side:'buy', asset:'SPY', quantity:100 }] → the served order verbatim.
    expect(screen.getByText('buy SPY 100')).toBeInTheDocument()
  })

  it('takes the displayed weight and order values from the server record fields (not derived)', () => {
    // Change ONLY the served fields; the display must follow them exactly (formatting, never computing).
    const rec = record()
    rec.evaluations = [
      {
        ...rec.evaluations[0],
        target_weights: [['QQQ', 0.25]],
        orders: [{ side: 'sell', asset: 'QQQ', quantity: 7 }],
      },
    ]
    render(<ResultsView runId="run-1" record={response(rec)} loading={false} error={undefined} />)
    expect(screen.getByText('QQQ 0.25')).toBeInTheDocument()
    expect(screen.getByText('sell QQQ 7')).toBeInTheDocument()
  })

  it('renders fill quantity and price through the shared formatter with verbatim titles (D-27)', () => {
    const rec = record()
    rec.fills = [{ ...rec.fills[0], quantity: 7.000500123456789, price: 500.12345678901 }]
    render(<ResultsView runId="run-1" record={response(rec)} loading={false} error={undefined} />)
    expect(screen.getByText('500.1235')).toHaveAttribute('title', '500.12345678901')
    expect(screen.getByText('7.0005')).toHaveAttribute('title', '7.000500123456789')
  })

  it('handles an evaluation with no targets and no orders gracefully (placeholders, no crash)', () => {
    const rec = record()
    rec.evaluations = [{ ...rec.evaluations[0], target_weights: [], orders: [] }]
    render(<ResultsView runId="run-1" record={response(rec)} loading={false} error={undefined} />)
    // The row still renders its session; empty targets/orders read as explicit placeholders.
    expect(screen.getAllByText('2025-07-31').length).toBeGreaterThan(0)
    expect(screen.getByText('no targets')).toBeInTheDocument()
    expect(screen.getByText('no orders')).toBeInTheDocument()
  })

  it('passes chart clicks through: clicking the chart selects the server date at that index', () => {
    // Pin the svg box so a clientX maps to a deterministic index over the two valuations.
    vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 120,
      top: 0,
      left: 0,
      right: 100,
      bottom: 120,
      toJSON: () => ({}),
    })
    const onSelectSession = vi.fn()
    const { container } = render(
      <ResultsView
        runId="run-1"
        record={response(record())}
        loading={false}
        error={undefined}
        onSelectSession={onSelectSession}
      />,
    )
    const svg = container.querySelector('.chart__svg')!
    fireEvent.click(svg, { clientX: 100 }) // → last valuation index → its server date
    expect(onSelectSession).toHaveBeenCalledWith('2025-08-29')
    vi.restoreAllMocks()
  })

  it('without onSelectSession, rows render plain dates (no session buttons)', () => {
    render(<ResultsView runId="run-1" record={response(record())} loading={false} error={undefined} />)
    // No row-select buttons exist; the dates are plain text as before.
    expect(screen.queryByRole('button', { name: '2025-07-31' })).toBeNull()
    expect(screen.queryByRole('button', { name: '2025-08-01' })).toBeNull()
    // The dates still render as plain text (the evaluation row's session date + the chart axis label).
    expect(screen.getAllByText('2025-07-31').length).toBeGreaterThan(0)
  })
})
