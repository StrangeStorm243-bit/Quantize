// Inspector — the Node Value Tap "At session" values block (M14.2a). The M13.7 slot now also renders
// the VALUE a node's output port produced at the session cursor, served by GET /v1/runs/{id}/values
// (recompute-on-demand). Every field is rendered VERBATIM in served order via String(...) — the client
// computes nothing (CLAUDE.md invariant 5): no sums, ranks, stats, sorting, or highlighting. These
// tests pin that: served weight_sum/cash render as-served (not recomputed from the weights), served row
// order is preserved, and per-port fetches never prefetch the unselected ports. NO network — getNodeValue
// is stubbed; the rest of '../api/client' (errorMessage, ApiClientError) stays real so useFetch works.
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  NodeCatalogResponse,
  NodeValueResponse,
  ProvenanceDto,
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
// Stub ONLY getNodeValue; keep the rest of the module real — useFetch imports errorMessage from here,
// and the served-error test throws the real ApiClientError.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, getNodeValue: vi.fn() }
})

// eslint-disable-next-line import/first
import { ApiClientError, getNodeValue } from '../api/client'
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

function makeDef(overrides: Partial<ComponentDefinition> = {}): ComponentDefinition {
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
    ...overrides,
  }
}

// --- Served value fixtures -----------------------------------------------------------------------

function prov(overrides: Partial<ProvenanceDto> = {}): ProvenanceDto {
  return { captured: false, dataset_fingerprint: 'fp-9f3c', run_id: 'run-1', ...overrides }
}

// A NodeValueResponse with a scalar default; per-test overrides supply the summary/asset_values/preview.
function value(overrides: Partial<NodeValueResponse>): NodeValueResponse {
  return {
    node_id: 'x',
    component_path: [],
    output_port: 'values',
    session_date: '2026-05-15',
    provenance: prov(),
    value_summary: { kind: 'scalar', dtype: 'Number', value: 0.5 },
    ...overrides,
  }
}

// The App-owned "At session" props; evaluated + a run cursor by default so the value block mounts. The
// trees carry a top-level node 'x' with an unknown event, so the trace-facts part renders alongside.
function atSession(overrides: Partial<AtSessionProps> = {}): AtSessionProps {
  return {
    runId: 'run-1',
    cursor: '2026-05-15',
    trees: [
      {
        run_id: 'run-1',
        instant: '2026-05-15T21:00:00+00:00',
        roots: [
          {
            node_id: 'x',
            component_path: [],
            origin: 'node',
            events: [
              {
                run_id: 'run-1',
                timestamp: '2026-05-15T21:00:00+00:00',
                node_id: 'x',
                event_type: 'mystery.unknown',
                payload: { v: 1, gizmo: 'widget', count: 42 },
              },
            ],
            children: [],
          },
        ],
      },
    ],
    loading: false,
    error: undefined,
    evaluated: true,
    note: undefined,
    scheduleKind: undefined,
    ...overrides,
  }
}

const asMock = () => vi.mocked(getNodeValue)

beforeEach(() => {
  state.catalog = structuredClone(catalogJson) as unknown as NodeCatalogResponse
  state.def = undefined
})
afterEach(() => {
  state.def = undefined
  vi.clearAllMocks()
})

describe('Inspector — Node Value Tap "At session" values (M14.2a)', () => {
  it('renders SERVED portfolio_targets weight_sum/cash verbatim — no client arithmetic', async () => {
    // Weights sum to 1.0, but the server says weight_sum=0.75, cash=0.25. The client must NOT recompute:
    // the rendered totals are the served ones (0.75 / 0.25), proving no summation happened here. The
    // weights are DISPLAY-formatted (PX-C): the long served weight shows trimmed, with the verbatim
    // value in `title`.
    asMock().mockResolvedValue(
      value({
        output_port: 'targets',
        value_summary: { kind: 'portfolio_targets', count: 2, weight_sum: 0.75, cash: 0.25 },
        asset_values: [
          { asset: 'SPY', value: 0.3333333333333333 },
          { asset: 'QQQ', value: 0.6666666666666667 },
        ],
      }),
    )
    render(
      <Inspector
        doc={docWith('x', 'output.target_portfolio')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText('Weight sum: 0.75')).toBeInTheDocument()
    expect(within(shell).getByText('Cash: 0.25')).toBeInTheDocument()
    // The un-summed weights render, but their arithmetic sum (1) is never shown as the total.
    expect(within(shell).queryByText('Weight sum: 1')).not.toBeInTheDocument()
    // The served weight is display-formatted to 4 dp, but the verbatim value survives in `title` (PX-C).
    const spyWeight = within(shell).getByText('0.3333')
    expect(spyWeight).toHaveAttribute('title', '0.3333333333333333')
    // A zero-output node sends NO output_port — the response's own output_port labels the value.
    expect(asMock().mock.calls[0][1]).toEqual({ nodeId: 'x', sessionDate: '2026-05-15', componentPath: [] })
    expect(within(shell).getByText('out targets')).toBeInTheDocument()
  })

  it('renders a cross_section (Number) in SERVED row order with min/max and missing', async () => {
    asMock().mockResolvedValue(
      value({
        value_summary: {
          kind: 'cross_section', dtype: 'Number', domain_count: 4, present_count: 3,
          missing: ['GLD'], min: -0.02, max: 0.15, true_count: null, false_count: null,
        },
        // Deliberately non-alphabetical — the DOM must preserve THIS order (no client sort).
        asset_values: [
          { asset: 'QQQ', value: 0.15 },
          { asset: 'SPY', value: 0.05 },
          { asset: 'IWM', value: -0.02 },
        ],
      }),
    )
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText('3 of 4 assets')).toBeInTheDocument()
    expect(within(shell).getByText('Min: -0.02')).toBeInTheDocument()
    expect(within(shell).getByText('Max: 0.15')).toBeInTheDocument()
    expect(within(shell).getByText('Missing: GLD')).toBeInTheDocument()
    // The table rows appear in the served order QQQ, SPY, IWM.
    const rows = within(shell).getAllByRole('row')
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['QQQ', 'SPY', 'IWM'])
  })

  it('renders a cross_section (Boolean) with true/false counts and NO min/max labels', async () => {
    asMock().mockResolvedValue(
      value({
        value_summary: {
          kind: 'cross_section', dtype: 'Boolean', domain_count: 3, present_count: 3,
          missing: [], min: null, max: null, true_count: 2, false_count: 1,
        },
        asset_values: [
          { asset: 'SPY', value: true },
          { asset: 'QQQ', value: false },
        ],
      }),
    )
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText('True: 2')).toBeInTheDocument()
    expect(within(shell).getByText('False: 1')).toBeInTheDocument()
    expect(within(shell).queryByText(/^Min:/)).not.toBeInTheDocument()
    expect(within(shell).queryByText(/^Max:/)).not.toBeInTheDocument()
  })

  it('renders scalar and asset_set fields verbatim', async () => {
    asMock().mockResolvedValue(value({ value_summary: { kind: 'scalar', dtype: 'Number', value: 0.123 } }))
    const { rerender } = render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    let shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText('Number: 0.123')).toBeInTheDocument()

    asMock().mockResolvedValue(
      value({
        output_port: 'assets',
        value_summary: { kind: 'asset_set', count: 2, members: ['SPY', 'QQQ'] },
      }),
    )
    rerender(
      <Inspector
        doc={docWith('u', 'universe.fixed_list')}
        selectedNodeId="u"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText('2 members')).toBeInTheDocument()
    expect(within(shell).getByText('SPY')).toBeInTheDocument()
    expect(within(shell).getByText('QQQ')).toBeInTheDocument()
  })

  it('renders a time_series window and per-asset preview points, empty preview shows label only', async () => {
    asMock().mockResolvedValue(
      value({
        output_port: 'series',
        value_summary: {
          kind: 'time_series', asset_count: 2, total_points: 3,
          window: { first_date: '2026-05-01', last_date: '2026-05-15' },
        },
        series_preview: [
          { asset: 'SPY', points: [['2026-05-01', 1], ['2026-05-15', 1.1]] },
          { asset: 'QQQ', points: [] },
        ],
      }),
    )
    render(
      <Inspector
        doc={docWith('p', 'data.price')}
        selectedNodeId="p"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText('2 assets · 3 points')).toBeInTheDocument()
    expect(within(shell).getByText('2026-05-01 → 2026-05-15')).toBeInTheDocument()
    // SPY's two served points render; QQQ's empty group shows its label with zero point rows.
    const spy = within(shell).getByText('SPY').closest('.inspector__value-series') as HTMLElement
    expect(within(spy).getByText('2026-05-01')).toBeInTheDocument()
    expect(within(spy).getByText('2026-05-15')).toBeInTheDocument()
    const qqq = within(shell).getByText('QQQ').closest('.inspector__value-series') as HTMLElement
    expect(qqq.querySelectorAll('.inspector__value-row').length).toBe(0)
  })

  it('defaults a single output port and, for multi-output, fetches only the selected port', async () => {
    // Single-output node: getNodeValue is called ONCE, with that port.
    asMock().mockResolvedValue(value({}))
    const { unmount } = render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    let shell = screen.getByRole('region', { name: 'at session' })
    await within(shell).findByText('Number: 0.5')
    expect(asMock().mock.calls).toHaveLength(1)
    expect(asMock().mock.calls[0][1].outputPort).toBe('values')
    // No selector for a single port.
    expect(within(shell).queryByLabelText('output port')).not.toBeInTheDocument()
    unmount()
    asMock().mockClear()

    // Multi-output node (golden catalog has none, so add a second output to the cloned catalog).
    const cat = structuredClone(catalogJson) as unknown as NodeCatalogResponse
    const nt = cat.node_types.find((n) => n.type_id === 'transform.trailing_return')
    nt!.outputs = [
      { name: 'a', port_type: { kind: 'CrossSection', dtype: 'Number' } },
      { name: 'b', port_type: { kind: 'CrossSection', dtype: 'Number' } },
    ]
    state.catalog = cat
    asMock().mockResolvedValue(value({ output_port: 'a' }))
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    shell = screen.getByRole('region', { name: 'at session' })
    await within(shell).findByText('Number: 0.5')
    const select = within(shell).getByLabelText('output port') as HTMLSelectElement
    expect(asMock().mock.calls).toHaveLength(1)
    expect(asMock().mock.calls[0][1].outputPort).toBe('a')

    // Selecting port 'b' fires exactly ONE new request, for 'b' only (no prefetch of unselected ports).
    fireEvent.change(select, { target: { value: 'b' } })
    await within(shell).findByText('Number: 0.5')
    expect(asMock().mock.calls).toHaveLength(2)
    expect(asMock().mock.calls[1][1].outputPort).toBe('b')
  })

  it('renders a served error verbatim under role=alert, keeping the sole port label as context', async () => {
    asMock().mockRejectedValue(
      new ApiClientError('engine_drift', 'engine drift — recomputation disagrees with the run', 409),
    )
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    const alert = await within(shell).findByRole('alert')
    expect(alert).toHaveTextContent('engine drift — recomputation disagrees with the run')
    // The SOLE listed port stays visible as static context beside the refusal (review P3): the reader
    // must still see WHICH port the refused request addressed. No value content renders, of course.
    expect(within(shell).getByText('out values')).toBeInTheDocument()
    expect(within(shell).queryByText(/Recomputed on demand/)).not.toBeInTheDocument()
  })

  it('never fetches a value for a NON-evaluated session (the honest no-eval line renders instead)', () => {
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession({ cursor: '2026-05-14', trees: [], evaluated: false })}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/No evaluation this session/i)).toBeInTheDocument()
    expect(asMock()).not.toHaveBeenCalled()
  })

  it('taps a ComponentRef instance by (instance id, empty path), ports from exposed_outputs', async () => {
    state.def = makeDef({
      exposed_outputs: [{ name: 'picks', maps_to: ['sel', 'assets'], type: { kind: 'AssetSet' } }],
    })
    asMock().mockResolvedValue(
      value({
        node_id: 'mom',
        output_port: 'picks',
        value_summary: { kind: 'asset_set', count: 1, members: ['SPY'] },
      }),
    )
    render(
      <Inspector
        doc={componentDoc()}
        selectedNodeId="mom"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText('1 members')).toBeInTheDocument()
    // The tap address is the INSTANCE id with an empty component_path; the port comes from exposed_outputs.
    expect(asMock().mock.calls[0][0]).toBe('run-1')
    expect(asMock().mock.calls[0][1]).toEqual({
      nodeId: 'mom', sessionDate: '2026-05-15', componentPath: [], outputPort: 'picks',
    })
  })

  it('is additive — the value block renders alongside the section title, cursor date, and trace facts', async () => {
    asMock().mockResolvedValue(value({}))
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    // The value…
    expect(await within(shell).findByText('Number: 0.5')).toBeInTheDocument()
    // …and the untouched section furniture: title, cursor date, and the node's own trace event.
    expect(within(shell).getByRole('heading', { name: 'At session' })).toBeInTheDocument()
    expect(within(shell).getByText('2026-05-15')).toBeInTheDocument()
    expect(within(shell).getByText('mystery.unknown')).toBeInTheDocument()
    expect(within(shell).getByText('gizmo')).toBeInTheDocument()
  })

  it('shows a loading note while the value fetch is in flight', () => {
    asMock().mockReturnValue(new Promise(() => {}))
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/loading value/i)).toBeInTheDocument()
  })

  it('shows the recompute-provenance footer with the ABBREVIATED dataset fingerprint (full hash in title)', async () => {
    // A full 64-char content-addressed hash would overflow the narrow panel — the footer abbreviates it
    // to head…tail (PX-E) and keeps the verbatim hash reachable in `title`.
    const fp = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    asMock().mockResolvedValue(value({ provenance: prov({ captured: false, dataset_fingerprint: fp }) }))
    render(
      <Inspector
        doc={docWith('x', 'transform.trailing_return')}
        selectedNodeId="x"
        actions={stubActions()}
        atSession={atSession()}
      />,
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText(/Recomputed on demand/i)).toBeInTheDocument()
    const code = within(shell).getByText('0123456789…abcdef')
    expect(code).toHaveAttribute('title', fp)
    // The full untruncated hash is NOT rendered inline (it lives in the title only).
    expect(within(shell).queryByText(fp)).not.toBeInTheDocument()
  })
})
