// TraceView (M13.7): the view is now CURSOR-CONTROLLED — it no longer fetches. The App owns the
// single trace-tree fetch (keyed on run + cursor) and passes the served trees + loading/error in as
// props; the session axis, the evaluated subset, and the cursor session's note are ALSO props
// (M13.7.5 — the App computes them once through `run/projections`). The session picker lists ALL
// sessions (evaluated ones unmarked, non-evaluated ones flagged " — no evaluation") and reports
// changes via onCursorChange.
// The SERVED per-instant tree (grouped server-side by build_trace_trees, M13.6) is rendered verbatim:
// node-origin roots first, then the engine-origin root under a distinct "engine stage" section.
// Tailored renderers show the structured fields for select.selected / transform.excluded /
// engine.orders_proposed (with a dust/hold omitted row); an UNKNOWN event type falls back to the
// generic key/value renderer. An evaluated-but-empty session shows "No trace for this session."; a
// non-evaluated cursor shows an honest "No evaluation this session." plus the run's note verbatim.
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  PersistedNote,
  TraceEvent,
  TraceTreeNodeDto,
  TraceTreeResponse,
} from '@quantize/quantize-api'
import { TraceView } from './TraceView'

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

// A helper mirroring the App's prop contract; overrides drive each case. `sessions` is the full
// axis (the App's run_id-gated `sessionAxis` projection) and `evaluated` its evaluated subset —
// pass a strict subset to include a non-evaluated session.
function renderTrace(props: {
  runId: string | undefined
  sessions?: string[]
  evaluated?: string[]
  note?: PersistedNote
  scheduleKind?: string
  recordLoading?: boolean
  recordError?: string | undefined
  sessionCursor?: string | null
  onCursorChange?: (date: string) => void
  trees?: TraceTreeResponse['trees'] | undefined
  treesLoading?: boolean
  treesError?: string | undefined
}): { onCursorChange: ReturnType<typeof vi.fn> } {
  const onCursorChange = vi.fn(props.onCursorChange)
  render(
    <TraceView
      runId={props.runId}
      recordLoading={props.recordLoading ?? false}
      recordError={props.recordError}
      sessions={props.sessions ?? []}
      evaluatedSessions={new Set(props.evaluated ?? props.sessions ?? [])}
      note={props.note}
      scheduleKind={props.scheduleKind}
      sessionCursor={props.sessionCursor ?? null}
      onCursorChange={onCursorChange}
      trees={props.trees}
      treesLoading={props.treesLoading ?? false}
      treesError={props.treesError}
    />,
  )
  return { onCursorChange }
}

describe('TraceView', () => {
  it('renders the served nested tree for the cursor session with tailored + generic renderers', () => {
    renderTrace({
      runId: 'run-1',
      sessions: ['2026-05-15', '2026-05-16'],
      sessionCursor: '2026-05-15',
      trees: SERVED_TREE.trees,
    })

    // Served nesting renders: the 'mom' instance head and its internal children appear.
    expect(screen.getByText('mom')).toBeInTheDocument()
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
  })

  it('lists ALL sessions, flags non-evaluated ones, reflects the cursor, and reports changes', () => {
    const { onCursorChange } = renderTrace({
      runId: 'run-1',
      sessions: ['2026-05-15', '2026-05-16'],
      evaluated: ['2026-05-15'],
      sessionCursor: '2026-05-15',
      trees: undefined,
    })

    const select = screen.getByLabelText('trace session') as HTMLSelectElement
    // The select is controlled by the cursor.
    expect(select.value).toBe('2026-05-15')

    // Both valuations dates are offered; the non-evaluated one is flagged (value stays the bare date).
    const evaluatedOption = screen.getByRole('option', { name: '2026-05-15' }) as HTMLOptionElement
    const noEvalOption = screen.getByRole('option', { name: '2026-05-16 — no evaluation' }) as HTMLOptionElement
    expect(evaluatedOption.value).toBe('2026-05-15')
    expect(noEvalOption.value).toBe('2026-05-16')

    // Changing the picker reports the bare date up to the App.
    fireEvent.change(select, { target: { value: '2026-05-16' } })
    expect(onCursorChange).toHaveBeenCalledWith('2026-05-16')
  })

  it('groups the engine-origin root under a distinct "engine stage" section, node roots first', () => {
    renderTrace({
      runId: 'run-1',
      sessions: ['2026-05-15'],
      sessionCursor: '2026-05-15',
      trees: SERVED_TREE.trees,
    })

    const engineSection = screen.getByRole('region', { name: 'engine stage' })
    expect(within(engineSection).getByText('Engine — targets → orders → fills')).toBeInTheDocument()
    // The engine root's event lives inside the engine section…
    expect(within(engineSection).getByText('engine.orders_proposed')).toBeInTheDocument()
    // …and the node-origin roots do NOT.
    expect(within(engineSection).queryByText('mom')).not.toBeInTheDocument()
    expect(within(engineSection).queryByText('mystery.unknown')).not.toBeInTheDocument()
  })

  it('shows an honest no-evaluation state with the run note verbatim for a non-evaluated cursor', () => {
    renderTrace({
      runId: 'run-1',
      sessions: ['2026-05-14', '2026-05-15'],
      evaluated: ['2026-05-15'],
      note: {
        code: 'warmup_not_satisfied',
        message: 'warm-up requires more than 60 sessions; only 42 visible',
        session_date: '2026-05-14',
      },
      sessionCursor: '2026-05-14',
      trees: [],
    })

    expect(screen.getByText(/No evaluation this session/i)).toBeInTheDocument()
    expect(screen.getByText('warmup_not_satisfied')).toBeInTheDocument()
    expect(screen.getByText(/warm-up requires more than 60 sessions; only 42 visible/)).toBeInTheDocument()
    // It is NOT the evaluated-empty message.
    expect(screen.queryByText(/no trace for this session/i)).not.toBeInTheDocument()
  })

  it('explains a non-evaluated session with the strategy cadence when scheduleKind is provided', () => {
    // A monthly strategy only decides on rebalance days; the no-eval state names that cadence so the
    // empty session is self-explanatory (M13.7.5) — a pure phrasing of the served schedule kind.
    renderTrace({
      runId: 'run-1',
      sessions: ['2026-05-14', '2026-05-15'],
      evaluated: ['2026-05-15'],
      scheduleKind: 'monthly',
      sessionCursor: '2026-05-14',
      trees: [],
    })
    expect(
      screen.getByText('No evaluation this session — this strategy evaluates monthly.'),
    ).toBeInTheDocument()
  })

  it('shows the bare no-evaluation line when the schedule kind is unknown/absent (safe fallback)', () => {
    renderTrace({
      runId: 'run-1',
      sessions: ['2026-05-14', '2026-05-15'],
      evaluated: ['2026-05-15'],
      scheduleKind: 'quarterly', // unrecognised → no cadence tail, no crash
      sessionCursor: '2026-05-14',
      trees: [],
    })
    expect(screen.getByText('No evaluation this session.')).toBeInTheDocument()
  })

  it('shows the no-evaluation line without a note (and without crashing) when none matches', () => {
    renderTrace({
      runId: 'run-1',
      sessions: ['2026-05-14', '2026-05-15'],
      evaluated: ['2026-05-15'],
      sessionCursor: '2026-05-14',
      trees: [],
    })

    expect(screen.getByText(/No evaluation this session/i)).toBeInTheDocument()
  })

  it('keeps the evaluated-empty message for an evaluated session with no trees', () => {
    renderTrace({
      runId: 'run-1',
      sessions: ['2026-05-15', '2026-05-16'],
      sessionCursor: '2026-05-15',
      trees: [],
    })

    expect(screen.getByText(/no trace for this session/i)).toBeInTheDocument()
    expect(screen.queryByText(/no evaluation this session/i)).not.toBeInTheDocument()
  })

  it('shows the loading state driven by treesLoading', () => {
    renderTrace({
      runId: 'run-1',
      sessions: ['2026-05-15'],
      sessionCursor: '2026-05-15',
      treesLoading: true,
    })
    expect(screen.getByText(/loading trace/i)).toBeInTheDocument()
  })

  it('surfaces a trace-fetch error passed from the App in the alert slot', () => {
    renderTrace({
      runId: 'run-1',
      sessions: ['2026-05-15'],
      sessionCursor: '2026-05-15',
      treesError: 'trace boom',
    })
    expect(screen.getByRole('alert')).toHaveTextContent('trace boom')
  })

  it('surfaces a RECORD-fetch error (getRun failure), not a silent empty picker (P3)', () => {
    // When the run record itself fails to load there are no sessions; the record error must be shown
    // rather than the bare "No sessions" picker with no explanation.
    renderTrace({ runId: 'run-1', recordError: 'record boom' })
    expect(screen.getByRole('alert')).toHaveTextContent('record boom')
  })

  it('shows the loading state while the run record is being fetched (P3)', () => {
    renderTrace({ runId: 'run-1', recordLoading: true })
    expect(screen.getByText(/loading trace/i)).toBeInTheDocument()
  })

  it('prefers the record error over a trace error when both are present (P3)', () => {
    renderTrace({
      runId: 'run-1',
      recordError: 'record boom',
      treesError: 'trace boom',
    })
    expect(screen.getByRole('alert')).toHaveTextContent('record boom')
    expect(screen.queryByText('trace boom')).not.toBeInTheDocument()
  })

  it('renders nothing actionable when no run is selected', () => {
    renderTrace({ runId: undefined })
    expect(screen.getByText(/select a run/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('trace session')).not.toBeInTheDocument()
  })

  // --- Click-through to the canvas (M13.7 Task 3) -----------------------------------------------
  // A node-origin trace row head is a BUTTON that reports (node_id, component_path) up to the App,
  // which selects + centers the emitting node. The engine is not a graph node (invariant 2) → its
  // head stays a non-interactive element and is never clickable.
  it('makes node-origin row heads clickable and reports (node_id, component_path); engine stays non-navigable', () => {
    const onNodeClick = vi.fn()
    render(
      <TraceView
        runId="run-1"
        sessions={['2026-05-15']}
        evaluatedSessions={new Set(['2026-05-15'])}
        note={undefined}
        sessionCursor="2026-05-15"
        onCursorChange={vi.fn()}
        trees={SERVED_TREE.trees}
        treesLoading={false}
        treesError={undefined}
        onNodeClick={onNodeClick}
      />,
    )

    // A nested node inside the 'mom' component reports its own node_id + component_path. The head's
    // accessible name conveys the ACTION ("Show <id> on canvas"), not just the id.
    fireEvent.click(screen.getByRole('button', { name: 'Show sel on canvas' }))
    expect(onNodeClick).toHaveBeenLastCalledWith('sel', ['mom'])

    // A top-level node reports an empty component_path.
    fireEvent.click(screen.getByRole('button', { name: 'Show x on canvas' }))
    expect(onNodeClick).toHaveBeenLastCalledWith('x', [])

    // The engine root's head is NOT a button (the engine is not a canvas node) — its id text is still
    // present, but there is no clickable control for it, so it can never be navigated to.
    expect(screen.queryByRole('button', { name: /engine/ })).not.toBeInTheDocument()
    // The engine head is still rendered (id + origin both read 'engine'), just not as a control.
    const engineSection = screen.getByRole('region', { name: 'engine stage' })
    expect(within(engineSection).getAllByText('engine').length).toBeGreaterThan(0)
  })

  it('gives node-origin heads a visible clickable affordance class; engine heads lack it', () => {
    // Idle affordance (M13.7.5): clickable heads carry a modifier class so CSS shows a hover
    // underline/tint and they read as clickable BEFORE hover-discovery. Engine heads (not canvas
    // nodes, invariant 2) never get it, staying visually distinct and non-navigable.
    render(
      <TraceView
        runId="run-1"
        sessions={['2026-05-15']}
        evaluatedSessions={new Set(['2026-05-15'])}
        note={undefined}
        sessionCursor="2026-05-15"
        onCursorChange={vi.fn()}
        trees={SERVED_TREE.trees}
        treesLoading={false}
        treesError={undefined}
        onNodeClick={vi.fn()}
      />,
    )
    const clickable = document.querySelectorAll('.trace-node__head--clickable')
    expect(clickable.length).toBeGreaterThan(0)
    clickable.forEach((el) => expect(el.tagName).toBe('BUTTON'))
    // The engine head is present but NOT marked clickable.
    const engineSection = screen.getByRole('region', { name: 'engine stage' })
    expect(engineSection.querySelector('.trace-node__head--clickable')).toBeNull()
  })
})
