// Inspector — read-only internals for a node INSIDE a component view (M13.9 O3 + M14.2b). A component
// definition is immutable, but its internals must still be understandable: given a `componentNode`
// (a node resolved from the trail tip's definition graph), the Inspector renders that node's identity,
// its CONFIGURED parameter values (read-only — no editable controls), its Explanation (meaning), its
// Ports, and — M14.2b — a VALUES-ONLY "At session" section (decision D-f): the value the inner node
// produced at the cursor, tapped by (node id, the enclosing trail), with NO trace facts and NO editing.
// The catalog is the golden catalog (real nodeTypeById); the component cache is stubbed; getNodeValue is
// stubbed (the value block mounts on evaluated sessions — keep it off the network from the start). NO network.
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeValueResponse, ProvenanceDto } from '@quantize/quantize-api'
import type { ComponentDefinition, StrategyDocument } from '@quantize/quantize-ir'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import type { StrategyDocumentActions } from '../document/store'
import type { AtSessionProps } from './Inspector'

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
// Stub ONLY getNodeValue; keep the rest of '../api/client' real (useFetch imports errorMessage there).
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, getNodeValue: vi.fn() }
})

// eslint-disable-next-line import/first
import { getNodeValue } from '../api/client'
// eslint-disable-next-line import/first
import { Inspector } from './Inspector'

const asMock = () => vi.mocked(getNodeValue)

function stubActions(): StrategyDocumentActions {
  return {
    addNode: vi.fn(), removeNode: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
    setParams: vi.fn(), setNodeUi: vi.fn(), replace: vi.fn(),
    replaceIf: vi.fn().mockReturnValue(true),
  }
}

// A minimal strategy doc — irrelevant here: `componentNode` takes precedence over `selectedNodeId`.
function emptyDoc(): StrategyDocument {
  return {
    schema_version: '0.1.0',
    strategy: {
      id: '11111111-1111-1111-1111-111111111111', version: 1, name: 'S',
      provenance: {
        owner: '22222222-2222-2222-2222-222222222222', creator: '22222222-2222-2222-2222-222222222222',
        contributors: [], visibility: 'private', duplicable: false, created_at: '2026-07-06T00:00:00Z',
      },
    },
    execution_policy: {
      policy: 'close_signal_next_session_open', valuation: 'session_close',
      transaction_costs: { model: 'bps', bps: 0 },
    },
    schedule: { kind: 'daily' },
    component_refs: [],
    nodes: [],
    edges: [],
  }
}

// --- Served value fixtures (the value block reads these verbatim) ---------------------------------

function prov(overrides: Partial<ProvenanceDto> = {}): ProvenanceDto {
  return { captured: false, dataset_fingerprint: 'fp-9f3c', run_id: 'run-1', ...overrides }
}

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
// trees are empty — the values-only section never reads them (no trace facts, D-f).
function atSession(overrides: Partial<AtSessionProps> = {}): AtSessionProps {
  return {
    runId: 'run-1',
    cursor: '2026-05-15',
    trees: [],
    loading: false,
    error: undefined,
    evaluated: true,
    note: undefined,
    scheduleKind: undefined,
    ...overrides,
  }
}

function renderInspector(
  componentNode: NonNullable<Parameters<typeof Inspector>[0]['componentNode']>,
  atSessionProp?: AtSessionProps,
) {
  return render(
    <Inspector
      doc={emptyDoc()}
      selectedNodeId={null}
      actions={stubActions()}
      componentNode={componentNode}
      {...(atSessionProp !== undefined ? { atSession: atSessionProp } : {})}
    />,
  )
}

afterEach(() => {
  state.catalog = undefined
  state.def = undefined
  vi.clearAllMocks()
})

describe('Inspector — read-only component internals (O3)', () => {
  it('renders a primitive inner node read-only: identity, configured params, explanation, ports', () => {
    state.catalog = catalogJson
    renderInspector({
      node: {
        id: 'ret', type_id: 'transform.trailing_return', type_version: '1.0.0',
        params: { lookback_sessions: 126 },
      } as never,
      componentRefs: [],
      componentPath: ['mom'],
    })

    // Identity: the catalog display name + type id.
    expect(screen.getByText('Trailing Return')).toBeInTheDocument()
    expect(screen.getByText('transform.trailing_return')).toBeInTheDocument()

    // Configured parameter VALUE is shown, but READ-ONLY: no editable control renders.
    expect(screen.getByText('126')).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    // A read-only affordance signals the internals are immutable.
    expect(screen.getByText(/read-only/i)).toBeInTheDocument()

    // Meaning: the Explanation formula and the Ports.
    expect(screen.getByText(/r_D = close\(D\)/)).toBeInTheDocument()
    expect(screen.getByText('values')).toBeInTheDocument()

    // The values-only "At session" section IS present (M14.2b), but with no run/cursor it is INERT: the
    // shared empty note renders and no value fetch fires.
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/run a strategy and select a session/i)).toBeInTheDocument()
    expect(asMock()).not.toHaveBeenCalled()
  })

  it('renders a nested ComponentRef inner node read-only: definition identity + exposed values', () => {
    state.catalog = catalogJson
    state.def = {
      schema_version: '0.1.0', component_id: 'cid-sub', version: '1.0.0', name: 'Sub Component',
      description: null, component_refs: [],
      implementation: { kind: 'graph', graph: { nodes: [], edges: [] } },
      exposed_inputs: [], exposed_outputs: [],
      exposed_params: [{ name: 'threshold', schema: { type: 'number' }, binds_to: ['n', 'p'] }],
      provenance: {
        owner: '22222222-2222-2222-2222-222222222222', creator: '22222222-2222-2222-2222-222222222222',
        contributors: [], visibility: 'private', duplicable: false,
        created_at: '2026-07-06T00:00:00Z', forked_from: null,
      },
    }
    renderInspector({
      node: { id: 'sub', type_id: 'component', ref: 'subref', params: { threshold: 0.5 } } as never,
      componentRefs: [{ id: 'subref', component_id: 'cid-sub', version: '1.0.0' }],
      componentPath: ['mom'],
    })

    expect(screen.getByText('Sub Component')).toBeInTheDocument()
    expect(screen.getByText('0.5')).toBeInTheDocument()
    expect(screen.getByText(/read-only/i)).toBeInTheDocument()
    // Still no editable control; the At-session section is present but inert (no run/cursor).
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/run a strategy and select a session/i)).toBeInTheDocument()
  })
})

describe('Inspector — component-internal "At session" values (M14.2b)', () => {
  it('taps an inner primitive node by (node id, the trail), rendering the served value', async () => {
    state.catalog = catalogJson
    asMock().mockResolvedValue(
      value({
        node_id: 'ret',
        component_path: ['mom'],
        output_port: 'values',
        value_summary: {
          kind: 'cross_section', dtype: 'Number', domain_count: 3, present_count: 2,
          missing: ['GLD'], min: 0.01, max: 0.2, true_count: null, false_count: null,
        },
        asset_values: [
          { asset: 'SPY', value: 0.2 },
          { asset: 'QQQ', value: 0.01 },
        ],
      }),
    )
    renderInspector(
      {
        node: {
          id: 'ret', type_id: 'transform.trailing_return', type_version: '1.0.0',
          params: { lookback_sessions: 126 },
        } as never,
        componentRefs: [],
        componentPath: ['mom'],
      },
      atSession(),
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText('2 of 3 assets')).toBeInTheDocument()
    // The tap address is (the inner node's OWN id, the enclosing trail); the port is its catalog output.
    expect(asMock().mock.calls[0][0]).toBe('run-1')
    expect(asMock().mock.calls[0][1]).toEqual({
      nodeId: 'ret', sessionDate: '2026-05-15', componentPath: ['mom'], outputPort: 'values',
    })
  })

  it('taps a nested ComponentRef inner node by (its instance id, the trail); ports from exposed_outputs', async () => {
    state.catalog = catalogJson
    state.def = {
      schema_version: '0.1.0', component_id: 'cid-sub', version: '1.0.0', name: 'Sub Component',
      description: null, component_refs: [],
      implementation: { kind: 'graph', graph: { nodes: [], edges: [] } },
      exposed_inputs: [],
      exposed_outputs: [{ name: 'picks', maps_to: ['sel', 'assets'], type: { kind: 'AssetSet' } }],
      exposed_params: [],
      provenance: {
        owner: '22222222-2222-2222-2222-222222222222', creator: '22222222-2222-2222-2222-222222222222',
        contributors: [], visibility: 'private', duplicable: false,
        created_at: '2026-07-06T00:00:00Z', forked_from: null,
      },
    }
    asMock().mockResolvedValue(
      value({
        node_id: 'sub',
        component_path: ['mom'],
        output_port: 'picks',
        value_summary: { kind: 'asset_set', count: 1, members: ['SPY'] },
      }),
    )
    renderInspector(
      {
        node: { id: 'sub', type_id: 'component', ref: 'subref', params: {} } as never,
        componentRefs: [{ id: 'subref', component_id: 'cid-sub', version: '1.0.0' }],
        componentPath: ['mom'],
      },
      atSession(),
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText('1 members')).toBeInTheDocument()
    // The nested ref taps as (ITS instance id, the trail) — its own id is NOT appended: the evaluator
    // stores a component's exposed outputs under `(*trail, instanceId)`. The port comes from exposed_outputs.
    expect(asMock().mock.calls[0][0]).toBe('run-1')
    expect(asMock().mock.calls[0][1]).toEqual({
      nodeId: 'sub', sessionDate: '2026-05-15', componentPath: ['mom'], outputPort: 'picks',
    })
  })

  it('re-defaults the output port when a late-loading definition first lists the ports', async () => {
    state.catalog = catalogJson
    asMock().mockResolvedValue(
      value({
        node_id: 'sub',
        component_path: ['mom'],
        output_port: 'picks',
        value_summary: { kind: 'asset_set', count: 1, members: ['SPY'] },
      }),
    )
    // The definition is NOT cached yet (state.def undefined): the nested ref renders with zero listed
    // ports, so the first request omits output_port (the server answers or 422s — served either way).
    const inspectorFor = (): Parameters<typeof render>[0] => (
      <Inspector
        doc={emptyDoc()}
        selectedNodeId={null}
        actions={stubActions()}
        componentNode={{
          node: { id: 'sub', type_id: 'component', ref: 'subref', params: {} } as never,
          componentRefs: [{ id: 'subref', component_id: 'cid-sub', version: '1.0.0' }],
          componentPath: ['mom'],
        }}
        atSession={atSession()}
      />
    )
    const view = render(inspectorFor())
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(await within(shell).findByText('1 members')).toBeInTheDocument()
    expect(asMock()).toHaveBeenCalledTimes(1)
    expect(asMock().mock.calls[0][1]).toEqual({
      nodeId: 'sub', sessionDate: '2026-05-15', componentPath: ['mom'],
    })

    // The definition arrives (cache fill) exposing TWO outputs. The value block must re-default to the
    // FIRST listed port — not sit on the stale portless state — and offer the selector.
    state.def = {
      schema_version: '0.1.0', component_id: 'cid-sub', version: '1.0.0', name: 'Sub Component',
      description: null, component_refs: [],
      implementation: { kind: 'graph', graph: { nodes: [], edges: [] } },
      exposed_inputs: [],
      exposed_outputs: [
        { name: 'picks', maps_to: ['sel', 'assets'], type: { kind: 'AssetSet' } },
        { name: 'scores', maps_to: ['rk', 'values'], type: { kind: 'CrossSection', dtype: 'Number' } },
      ],
      exposed_params: [],
      provenance: {
        owner: '22222222-2222-2222-2222-222222222222', creator: '22222222-2222-2222-2222-222222222222',
        contributors: [], visibility: 'private', duplicable: false,
        created_at: '2026-07-06T00:00:00Z', forked_from: null,
      },
    }
    view.rerender(inspectorFor())
    const selector = await within(screen.getByRole('region', { name: 'at session' }))
      .findByRole('combobox', { name: 'output port' })
    expect((selector as HTMLSelectElement).value).toBe('picks')
    expect(asMock()).toHaveBeenCalledTimes(2)
    expect(asMock().mock.calls[1][1]).toEqual({
      nodeId: 'sub', sessionDate: '2026-05-15', componentPath: ['mom'], outputPort: 'picks',
    })
  })

  it('keeps the sole exposed port visible as static context while the value is still loading', () => {
    state.catalog = catalogJson
    state.def = {
      schema_version: '0.1.0', component_id: 'cid-sub', version: '1.0.0', name: 'Sub Component',
      description: null, component_refs: [],
      implementation: { kind: 'graph', graph: { nodes: [], edges: [] } },
      exposed_inputs: [],
      exposed_outputs: [{ name: 'picks', maps_to: ['sel', 'assets'], type: { kind: 'AssetSet' } }],
      exposed_params: [],
      provenance: {
        owner: '22222222-2222-2222-2222-222222222222', creator: '22222222-2222-2222-2222-222222222222',
        contributors: [], visibility: 'private', duplicable: false,
        created_at: '2026-07-06T00:00:00Z', forked_from: null,
      },
    }
    // A pending request (never resolves): the nested ref has NO Ports section, so the sole exposed
    // port must label the pending value itself (review P3 — port context during loading/error).
    asMock().mockReturnValue(new Promise(() => undefined))
    renderInspector(
      {
        node: { id: 'sub', type_id: 'component', ref: 'subref', params: {} } as never,
        componentRefs: [{ id: 'subref', component_id: 'cid-sub', version: '1.0.0' }],
        componentPath: ['mom'],
      },
      atSession(),
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/Loading value/)).toBeInTheDocument()
    expect(within(shell).getByText('out picks')).toBeInTheDocument()
  })

  it('shows the honest no-eval line and fires no value fetch on a non-evaluated session', () => {
    state.catalog = catalogJson
    renderInspector(
      {
        node: {
          id: 'ret', type_id: 'transform.trailing_return', type_version: '1.0.0',
          params: { lookback_sessions: 126 },
        } as never,
        componentRefs: [],
        componentPath: ['mom'],
      },
      atSession({ cursor: '2026-05-14', trees: [], evaluated: false }),
    )
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/No evaluation this session/i)).toBeInTheDocument()
    expect(asMock()).not.toHaveBeenCalled()
  })
})
