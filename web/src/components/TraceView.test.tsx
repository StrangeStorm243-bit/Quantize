// TraceView: the session-date picker (from the run record's evaluations) drives a getTraceTree
// fetch; the SERVED per-instant tree (grouped server-side by build_trace_trees, M13.6) is rendered
// verbatim — component nesting shown as indentation, the engine root labeled. Tailored renderers
// show the structured fields for select.selected / transform.excluded / engine.orders_proposed
// (with a dust/hold omitted row); an UNKNOWN event type falls back to the generic key/value
// renderer; an empty session shows the empty state. The api client is mocked (no network).
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PersistedRunRecord,
  RunRecordResponse,
  TraceEvent,
  TraceTreeNodeDto,
  TraceTreeResponse,
} from '@quantize/quantize-api'
import { TraceView } from './TraceView'

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, getTraceTree: vi.fn() }
})

// eslint-disable-next-line import/first
import { getTraceTree } from '../api/client'

const mockGetTraceTree = vi.mocked(getTraceTree)

// A minimal record carrying just the evaluation session dates the picker needs (two distinct dates).
// The record is OWNED BY THE APP and passed in (M11.9, F7); `run_id` must match the `runId` prop
// (the view gates session derivation on that identity to ignore a previous run's record mid-switch).
function runResponse(sessionDates: string[], runId = 'run-1'): RunRecordResponse {
  const record = {
    run_id: runId,
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

// A served tree node with sensible defaults; override the fields a case cares about.
function treeNode(overrides: Partial<TraceTreeNodeDto>): TraceTreeNodeDto {
  return {
    node_id: 'n',
    component_path: [],
    origin: 'node',
    events: [],
    children: [],
    ...overrides,
  }
}

// One instant's served tree: the 'mom' component instance (emitting nothing, with two internal
// children), a top-level unknown-event node, and the engine root last (as build_trace_trees orders).
const SERVED_TREE: TraceTreeResponse = {
  trees: [
    {
      run_id: 'run-1',
      instant: '2026-05-15T21:00:00+00:00',
      roots: [
        treeNode({
          node_id: 'mom',
          children: [
            treeNode({
              node_id: 'sel',
              component_path: ['mom'],
              events: [
                event({
                  node_id: 'sel',
                  component_path: ['mom'],
                  event_type: 'select.selected',
                  payload: { v: 1, n: 2, selected: ['SPY', 'QQQ'], unselected: ['GLD'] },
                }),
              ],
            }),
            treeNode({
              node_id: 'ret',
              component_path: ['mom'],
              events: [
                event({
                  node_id: 'ret',
                  component_path: ['mom'],
                  event_type: 'transform.excluded',
                  payload: { v: 1, asset: 'IWM', reason: 'missing_current_close' },
                }),
              ],
            }),
          ],
        }),
        treeNode({
          node_id: 'x',
          events: [
            event({
              node_id: 'x',
              event_type: 'mystery.unknown',
              payload: { v: 1, gizmo: 'widget', count: 42 },
            }),
          ],
        }),
        treeNode({
          node_id: 'engine',
          origin: 'engine',
          events: [
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
          ],
        }),
      ],
    },
  ],
}

beforeEach(() => {
  mockGetTraceTree.mockReset()
})

// A helper: render with the App-owned record prop (loading/error default to idle).
function renderTrace(runId: string | undefined, record: RunRecordResponse | undefined): void {
  render(<TraceView runId={runId} record={record} recordLoading={false} recordError={undefined} />)
}

describe('TraceView', () => {
  it('drives the fetch from the picker and renders the served nested tree + tailored/generic renderers', async () => {
    mockGetTraceTree.mockResolvedValue(SERVED_TREE)

    renderTrace('run-1', runResponse(['2026-05-15', '2026-05-16']))

    // Auto-selects the first session and fetches its tree.
    await waitFor(() => expect(mockGetTraceTree).toHaveBeenCalledWith('run-1', '2026-05-15'))

    // Served nesting renders: the 'mom' instance head and its internal children appear.
    expect(await screen.findByText('mom')).toBeInTheDocument()
    expect(screen.getByText('sel')).toBeInTheDocument()
    expect(screen.getByText('ret')).toBeInTheDocument()

    // select.selected tailored renderer: the count and selected assets.
    expect(screen.getByText(/selected 2:/)).toBeInTheDocument()
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

    // The engine root's event type appears — the server placed engine after node roots.
    expect(screen.getByText('engine.orders_proposed')).toBeInTheDocument()
  })

  it('re-fetches when the picker changes and shows the empty state for a session with no trees', async () => {
    mockGetTraceTree.mockImplementation((_runId: string, sessionDate?: string) =>
      Promise.resolve(sessionDate === '2026-05-16' ? { trees: [] } : SERVED_TREE),
    )

    renderTrace('run-1', runResponse(['2026-05-15', '2026-05-16']))
    await waitFor(() => expect(mockGetTraceTree).toHaveBeenCalledWith('run-1', '2026-05-15'))

    fireEvent.change(screen.getByLabelText('trace session'), { target: { value: '2026-05-16' } })

    await waitFor(() => expect(mockGetTraceTree).toHaveBeenCalledWith('run-1', '2026-05-16'))
    expect(await screen.findByText(/no trace for this session/i)).toBeInTheDocument()
  })

  it('surfaces a record-fetch error passed from the App (no tree fetch attempted)', () => {
    render(<TraceView runId="run-1" record={undefined} recordLoading={false} recordError="record boom" />)
    expect(screen.getByRole('alert')).toHaveTextContent('record boom')
    expect(mockGetTraceTree).not.toHaveBeenCalled()
  })

  it('renders nothing actionable when no run is selected', () => {
    renderTrace(undefined, undefined)
    expect(mockGetTraceTree).not.toHaveBeenCalled()
    expect(screen.getByText(/select a run/i)).toBeInTheDocument()
  })
})
