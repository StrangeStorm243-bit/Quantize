// Inspector — the "At session" live section (M13.7). The M13.5 slot is now wired to the App-owned
// served trace tree at the session cursor: the SELECTED node's served events, the engine reconciliation
// rows at the output boundary, and honest no-evaluation notes. It renders SERVED facts addressed by
// (node_id, component_path) — the Node Value Tap contract (design W4) — and computes nothing (invariant
// 5). We drive it purely by props (the `atSession` object the App builds); the catalog is the golden
// catalog (partial mock, real nodeTypeById) so a primitive node's `category` resolves, and the
// component-definition cache is stubbed for the ComponentRef branch. NO network.
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  NodeCatalogResponse,
  PersistedNote,
  TraceEvent,
  TraceTreeDto,
  TraceTreeNodeDto,
} from '@quantize/quantize-api'
import type { ComponentDefinition, StrategyDocument } from '@quantize/quantize-ir'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import type { StrategyDocumentActions } from '../document/store'
import type { AtSessionProps } from './Inspector'

// Per-test controllable module state: the served catalog and the component definition the cache hands
// back (undefined = a cache miss). Hoisted so the vi.mock factories can close over it.
const state = vi.hoisted(() => ({
  catalog: undefined as unknown,
  def: undefined as ComponentDefinition | undefined,
}))

vi.mock('../catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../catalog')>()
  return {
    ...actual,
    useCatalog: () => ({ catalog: state.catalog, loading: false, error: undefined }),
  }
})
vi.mock('../components-cache', () => ({
  useComponentDefs: () => ({
    defs: new Map(),
    get: () => state.def,
    ensure: vi.fn(),
    seed: vi.fn(),
    isLoading: () => false,
    errorOf: () => undefined,
  }),
}))

// eslint-disable-next-line import/first
import { Inspector } from './Inspector'

const CID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function stubActions(): StrategyDocumentActions {
  return {
    addNode: vi.fn(), removeNode: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
    setParams: vi.fn(), setNodeUi: vi.fn(), replace: vi.fn(),
    replaceIf: vi.fn().mockReturnValue(true),
  }
}

// A primitive-node document with a chosen node id + catalog type.
function docWith(nodeId: string, typeId: string): StrategyDocument {
  return {
    schema_version: '0.1.0',
    strategy: {
      id: '11111111-1111-1111-1111-111111111111',
      version: 1,
      name: 'S',
      provenance: {
        owner: '22222222-2222-2222-2222-222222222222',
        creator: '22222222-2222-2222-2222-222222222222',
        contributors: [], visibility: 'private', duplicable: false,
        created_at: '2026-07-06T00:00:00Z',
      },
    },
    execution_policy: {
      policy: 'close_signal_next_session_open',
      valuation: 'session_close',
      transaction_costs: { model: 'bps', bps: 0 },
    },
    schedule: { kind: 'daily' },
    component_refs: [],
    nodes: [{ id: nodeId, type_id: typeId, type_version: '1.0.0', params: {} as never }],
    edges: [],
  }
}

// A ComponentRef-instance document: node id 'mom' references pinned component r1.
function componentDoc(): StrategyDocument {
  return {
    ...docWith('mom', 'component'),
    component_refs: [{ id: 'r1', component_id: CID, version: '1.0.0' }],
    nodes: [{ id: 'mom', type_id: 'component', ref: 'r1', params: {} } as never],
  }
}

function makeDef(): ComponentDefinition {
  return {
    schema_version: '0.1.0',
    component_id: CID,
    version: '1.0.0',
    name: 'Momentum',
    description: 'A momentum selector.',
    component_refs: [],
    implementation: { kind: 'graph', graph: { nodes: [], edges: [] } },
    exposed_inputs: [],
    exposed_outputs: [],
    exposed_params: [],
    provenance: {
      owner: '22222222-2222-2222-2222-222222222222',
      creator: '22222222-2222-2222-2222-222222222222',
      contributors: [], visibility: 'private', duplicable: false,
      created_at: '2026-07-06T00:00:00Z', forked_from: null,
    },
  }
}

// --- Served trace fixtures (mirroring TraceView.test.tsx's SERVED_TREE shape) ---------------------

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

function treeNode(overrides: Partial<TraceTreeNodeDto>): TraceTreeNodeDto {
  return { node_id: 'n', component_path: [], origin: 'node', events: [], children: [], ...overrides }
}

// One served instant: the 'mom' component instance (no own events, two internal children), a top-level
// node 'x' (an unknown event → generic renderer), and the engine reconciliation root last.
function servedTrees(): TraceTreeDto[] {
  return [
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
                  node_id: 'sel', component_path: ['mom'], event_type: 'select.selected',
                  payload: { v: 1, n: 2, selected: ['SPY', 'QQQ'], unselected: ['GLD'] },
                }),
              ],
            }),
            treeNode({
              node_id: 'ret',
              component_path: ['mom'],
              events: [
                event({
                  node_id: 'ret', component_path: ['mom'], event_type: 'transform.excluded',
                  payload: { v: 1, asset: 'IWM', reason: 'missing_current_close' },
                }),
              ],
            }),
          ],
        }),
        treeNode({
          node_id: 'x',
          events: [
            event({ node_id: 'x', event_type: 'mystery.unknown', payload: { v: 1, gizmo: 'widget', count: 42 } }),
          ],
        }),
        treeNode({
          node_id: 'engine',
          origin: 'engine',
          events: [
            event({
              node_id: 'engine', event_type: 'engine.orders_proposed',
              payload: {
                v: 1, session: '2026-05-15', portfolio_value: 1_000_000, target_cash: 0,
                projected_cash: 0, orders: [['buy', 'SPY', 100]], omitted: [],
              },
            }),
          ],
        }),
      ],
    },
  ]
}

// The output-boundary node's OWN served root (id 'tp'), plus the engine reconciliation root.
function outputTrees(): TraceTreeDto[] {
  return [
    {
      run_id: 'run-1',
      instant: '2026-05-15T21:00:00+00:00',
      roots: [
        treeNode({
          node_id: 'tp',
          events: [
            event({ node_id: 'tp', event_type: 'target.portfolio', payload: { v: 1, weights: [['SPY', 1.0]] } }),
          ],
        }),
        treeNode({
          node_id: 'engine',
          origin: 'engine',
          events: [
            event({
              node_id: 'engine', event_type: 'engine.orders_filled',
              payload: { v: 1, fills: [['buy', 'SPY', 100, 500.0, 0, 0, false]] },
            }),
          ],
        }),
      ],
    },
  ]
}

function atSession(overrides: Partial<AtSessionProps> = {}): AtSessionProps {
  return {
    cursor: '2026-05-15',
    trees: servedTrees(),
    loading: false,
    error: undefined,
    evaluated: true,
    note: undefined,
    ...overrides,
  }
}

beforeEach(() => {
  state.catalog = structuredClone(catalogJson) as unknown as NodeCatalogResponse
  state.def = undefined
})
afterEach(() => {
  state.def = undefined
  vi.clearAllMocks()
})

describe('Inspector — "At session" live section (M13.7)', () => {
  it('renders the M13.5 empty-state sentence unchanged when there is no run/cursor', () => {
    render(
      <Inspector doc={docWith('x', 'transform.trailing_return')} selectedNodeId="x" actions={stubActions()} />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/run a strategy and select a session/i)).toBeInTheDocument()
    // No live artifacts leak in without an atSession prop.
    expect(within(shell).queryByText('2026-05-15')).not.toBeInTheDocument()
  })

  it('shows the cursor date and the selected top-level node\'s served events', () => {
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText('2026-05-15')).toBeInTheDocument()
    // Node x emitted an unknown event → the SHARED renderer's generic fallback lists its payload.
    expect(within(shell).getByText('mystery.unknown')).toBeInTheDocument()
    expect(within(shell).getByText('gizmo')).toBeInTheDocument()
    expect(within(shell).getByText('widget')).toBeInTheDocument()
    // No engine subsection for a non-output node.
    expect(within(shell).queryByText('Engine')).not.toBeInTheDocument()
  })

  it('shows the honest empty line when the selected node emitted nothing', () => {
    render(
      <Inspector
        doc={docWith('ghost', 'transform.trailing_return')}
        selectedNodeId="ghost"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/emitted no events at this session/i)).toBeInTheDocument()
  })

  it('shows the no-evaluation line + the run note verbatim for a non-evaluated cursor', () => {
    const note: PersistedNote = {
      code: 'warmup_not_satisfied',
      message: 'warm-up requires more than 60 sessions; only 42 visible',
      session_date: '2026-05-14',
    }
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession({ cursor: '2026-05-14', trees: [], evaluated: false, note })}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/No evaluation this session/i)).toBeInTheDocument()
    expect(within(shell).getByText('warmup_not_satisfied')).toBeInTheDocument()
    expect(within(shell).getByText(/only 42 visible/)).toBeInTheDocument()
  })

  it('shows the no-evaluation line without a note (no crash) when none matches', () => {
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession({ cursor: '2026-05-14', trees: undefined, evaluated: false, note: undefined })}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/No evaluation this session/i)).toBeInTheDocument()
  })

  it('shows the loading state while the App is fetching the trace', () => {
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession({ trees: undefined, loading: true })}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/loading trace/i)).toBeInTheDocument()
  })

  it('surfaces a trace-fetch error passed from the App', () => {
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession({ trees: undefined, error: 'trace boom' })}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText('trace boom')).toBeInTheDocument()
  })

  it('appends an Engine subsection with the engine root\'s events for an output-category node', () => {
    render(
      <Inspector
        doc={docWith('tp', 'output.target_portfolio')}
        selectedNodeId="tp"
        actions={stubActions()}
        atSession={atSession({ trees: outputTrees() })}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    // The node's OWN event renders…
    expect(within(shell).getByText('target.portfolio')).toBeInTheDocument()
    // …and the Engine subheading + the engine reconciliation event both appear.
    expect(within(shell).getByText('Engine')).toBeInTheDocument()
    expect(within(shell).getByText('engine.orders_filled')).toBeInTheDocument()
  })

  it('flattens one level of a ComponentRef instance\'s children, labeled by node_id', () => {
    state.def = makeDef()
    render(
      <Inspector
        doc={componentDoc()}
        selectedNodeId="mom"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText('2026-05-15')).toBeInTheDocument()
    // The instance's internal children are listed with their node ids + their served events.
    expect(within(shell).getByText('sel')).toBeInTheDocument()
    expect(within(shell).getByText('ret')).toBeInTheDocument()
    expect(within(shell).getByText(/SPY, QQQ/)).toBeInTheDocument()
    expect(within(shell).getByText('missing_current_close')).toBeInTheDocument()
    // A component instance never gets an engine subsection (no catalog category).
    expect(within(shell).queryByText('Engine')).not.toBeInTheDocument()
  })
})
