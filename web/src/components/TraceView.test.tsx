// TraceView: the session-date picker (from the run record's evaluations) drives a getTrace fetch;
// tailored renderers show the structured fields for select.selected / transform.excluded /
// engine.orders_proposed (with a dust/hold omitted row); an UNKNOWN event type falls back to the
// generic key/value renderer; an empty session shows the empty state. The api client is mocked (no
// network); ApiClientError is the real class so `instanceof` works.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedRunRecord, RunRecordResponse, TraceEvent, TraceResponse } from '@quantize/quantize-api'
import { TraceView } from './TraceView'

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, getRun: vi.fn(), getTrace: vi.fn() }
})

// eslint-disable-next-line import/first
import { getRun, getTrace } from '../api/client'

const mockGetRun = vi.mocked(getRun)
const mockGetTrace = vi.mocked(getTrace)

// A minimal record carrying just the evaluation session dates the picker needs (two distinct dates).
function runResponse(sessionDates: string[]): RunRecordResponse {
  const record = {
    evaluations: sessionDates.map((session_date) => ({
      session_date,
      evaluation_instant: `${session_date}T21:00:00Z`,
      ok: true,
      orders: [],
      plans: [],
      portfolio_value: 1_000_000,
      projected_cash: 0,
      scheduled_fill_instant: null,
      fill_session: null,
      target_cash: 0,
      target_weights: [],
    })),
  } as unknown as PersistedRunRecord
  return { record, replay_verifiable: true }
}

function event(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    run_id: 'run-1',
    timestamp: '2026-05-15T21:00:00+00:00',
    node_id: 'n',
    event_type: 'select.selected',
    payload: { v: 1 },
    ...overrides,
  }
}

beforeEach(() => {
  mockGetRun.mockReset()
  mockGetTrace.mockReset()
})

describe('TraceView', () => {
  it('drives the fetch from the session picker and renders tailored + generic renderers', async () => {
    mockGetRun.mockResolvedValue(runResponse(['2026-05-15', '2026-05-16']))
    const trace: TraceResponse = {
      events: [
        event({
          node_id: 'sel',
          component_path: ['mom'],
          event_type: 'select.selected',
          payload: { v: 1, n: 2, selected: ['SPY', 'QQQ'], unselected: ['GLD'] },
        }),
        event({
          node_id: 'ret',
          component_path: ['mom'],
          event_type: 'transform.excluded',
          payload: { v: 1, asset: 'IWM', reason: 'missing_current_close' },
        }),
        event({
          node_id: 'engine',
          event_type: 'engine.orders_proposed',
          payload: {
            v: 1,
            session: '2026-05-15',
            portfolio_value: 1_000_000,
            target_cash: 0,
            projected_cash: 0,
            orders: [['buy', 'SPY', 100]],
            omitted: [['GLD', 'dust', 3]],
          },
        }),
        event({
          node_id: 'x',
          event_type: 'mystery.unknown',
          payload: { v: 1, gizmo: 'widget', count: 42 },
        }),
      ],
    }
    mockGetTrace.mockResolvedValue(trace)

    render(<TraceView runId="run-1" />)

    // Auto-selects the first session and fetches its trace.
    await waitFor(() => expect(mockGetTrace).toHaveBeenCalledWith('run-1', '2026-05-15'))

    // select.selected tailored renderer: the count and selected assets.
    expect(await screen.findByText(/selected 2:/)).toBeInTheDocument()
    expect(screen.getByText(/SPY, QQQ/)).toBeInTheDocument()
    expect(screen.getByText(/unselected: GLD/)).toBeInTheDocument()

    // transform.excluded: asset + reason MACHINE token (not prose).
    expect(screen.getByText('IWM')).toBeInTheDocument()
    expect(screen.getByText('missing_current_close')).toBeInTheDocument()

    // engine.orders_proposed: the order row + the omitted dust row with its reason token.
    expect(screen.getByText('buy')).toBeInTheDocument()
    expect(screen.getByText('dust')).toBeInTheDocument()

    // Unknown event type → generic renderer lists the payload keys/values (v is dropped as noise).
    expect(screen.getByText('gizmo')).toBeInTheDocument()
    expect(screen.getByText('widget')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()

    // The engine root's node id appears — grouping placed engine after node roots.
    expect(screen.getByText('mystery.unknown')).toBeInTheDocument()
  })

  it('re-fetches when the picker changes and shows the empty state for a session with no trace', async () => {
    mockGetRun.mockResolvedValue(runResponse(['2026-05-15', '2026-05-16']))
    mockGetTrace.mockImplementation((_runId: string, sessionDate: string) =>
      Promise.resolve({
        events:
          sessionDate === '2026-05-16'
            ? []
            : [event({ event_type: 'select.selected', payload: { v: 1, n: 0, selected: [], unselected: [] } })],
      }),
    )

    render(<TraceView runId="run-1" />)
    await waitFor(() => expect(mockGetTrace).toHaveBeenCalledWith('run-1', '2026-05-15'))

    fireEvent.change(screen.getByLabelText('trace session'), { target: { value: '2026-05-16' } })

    await waitFor(() => expect(mockGetTrace).toHaveBeenCalledWith('run-1', '2026-05-16'))
    expect(await screen.findByText(/no trace for this session/i)).toBeInTheDocument()
  })

  it('renders nothing actionable when no run is selected', () => {
    render(<TraceView runId={undefined} />)
    expect(mockGetRun).not.toHaveBeenCalled()
    expect(screen.getByText(/select a run/i)).toBeInTheDocument()
  })
})
