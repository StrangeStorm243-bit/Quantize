// Inspector — ComponentRefNode branch (M12.4, E10). A selected component instance edits its EXPOSED
// params via the same ParamForm over a synthesized object schema, and offers a read-only "Inspect
// internals" affordance. We mock the catalog + component-definition cache so this is a pure unit test:
// the cache's `get` returns a controllable definition (or undefined for the cache-miss path). NO network.
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentDefinition, ExposedParam, StrategyDocument } from '@quantize/quantize-ir'
import type { StrategyDocumentActions } from '../document/store'

// The definition the mocked cache hands back (per-test controllable; undefined = a cache miss).
const state = vi.hoisted(() => ({ def: undefined as ComponentDefinition | undefined }))

vi.mock('../catalog', () => ({
  // The component branch never consults the node catalog; stub both imports so the module resolves.
  useCatalog: () => ({ catalog: undefined, loading: false, error: undefined }),
  nodeTypeById: () => undefined,
}))
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
    addNode: vi.fn(),
    removeNode: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    setParams: vi.fn(),
    setNodeUi: vi.fn(),
    replace: vi.fn(),
    replaceIf: vi.fn().mockReturnValue(true),
  }
}

function makeDef(exposedParams: ExposedParam[]): ComponentDefinition {
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
    exposed_params: exposedParams,
    provenance: {
      owner: '22222222-2222-2222-2222-222222222222',
      creator: '22222222-2222-2222-2222-222222222222',
      contributors: [],
      visibility: 'private',
      duplicable: false,
      created_at: '2026-07-06T00:00:00Z',
      forked_from: null,
    },
  }
}

function makeDoc(): StrategyDocument {
  return {
    schema_version: '0.1.0',
    strategy: {
      id: '11111111-1111-1111-1111-111111111111',
      version: 1,
      name: 'S',
      provenance: {
        owner: '22222222-2222-2222-2222-222222222222',
        creator: '22222222-2222-2222-2222-222222222222',
        contributors: [],
        visibility: 'private',
        duplicable: false,
        created_at: '2026-07-06T00:00:00Z',
      },
    },
    execution_policy: {
      policy: 'close_signal_next_session_open',
      valuation: 'session_close',
      transaction_costs: { model: 'bps', bps: 0 },
    },
    schedule: { kind: 'daily' },
    component_refs: [{ id: 'r1', component_id: CID, version: '1.0.0' }],
    nodes: [{ id: 'mom', type_id: 'component', ref: 'r1', params: {} }],
    edges: [],
  }
}

afterEach(() => {
  state.def = undefined
  vi.clearAllMocks()
})

describe('Inspector — ComponentRefNode branch', () => {
  it('renders an exposed-param control and dispatches setParams keyed by the exposed name', () => {
    state.def = makeDef([
      { name: 'lookback_sessions', binds_to: ['ret', 'lookback_sessions'], schema: { type: 'integer', minimum: 1 } },
    ])
    const actions = stubActions()
    render(<Inspector doc={makeDoc()} selectedNodeId="mom" actions={actions} />)

    const input = screen.getByLabelText('lookback_sessions')
    fireEvent.change(input, { target: { value: '5' } })
    // Params are keyed by the EXPOSED NAME — the server layers them as overrides.
    expect(actions.setParams).toHaveBeenCalledWith('mom', { lookback_sessions: 5 })
  })

  it('shows an explicit no-exposed-parameters state when the definition exposes none', () => {
    state.def = makeDef([])
    render(<Inspector doc={makeDoc()} selectedNodeId="mom" actions={stubActions()} />)
    expect(screen.getByText(/No exposed parameters/i)).toBeInTheDocument()
  })

  it('degrades gracefully on a cache miss: shows the ref id and a note, no crash', () => {
    state.def = undefined
    render(<Inspector doc={makeDoc()} selectedNodeId="mom" actions={stubActions()} />)
    expect(screen.getByText('r1')).toBeInTheDocument()
    expect(screen.getByText(/not loaded/i)).toBeInTheDocument()
  })

  it('calls onInspectComponent with the ref\'s component id and version', () => {
    state.def = makeDef([])
    const onInspect = vi.fn()
    render(
      <Inspector
        doc={makeDoc()}
        selectedNodeId="mom"
        actions={stubActions()}
        onInspectComponent={onInspect}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /inspect internals/i }))
    expect(onInspect).toHaveBeenCalledWith({ componentId: CID, version: '1.0.0' })
  })

  it('renders the "At session" shell for a component instance (value-tap slot, M13.5)', () => {
    state.def = makeDef([])
    render(<Inspector doc={makeDoc()} selectedNodeId="mom" actions={stubActions()} />)
    expect(screen.getByText('At session')).toBeInTheDocument()
    expect(screen.getByText(/run a strategy and select a session/i)).toBeInTheDocument()
  })
})
