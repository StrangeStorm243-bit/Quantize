// Inspector — read-only internals for a node INSIDE a component view (M13.9 O3). A component
// definition is immutable, but its internals must still be understandable: given a `componentNode`
// (a node resolved from the trail tip's definition graph), the Inspector renders that node's identity,
// its CONFIGURED parameter values (read-only — no editable controls), its Explanation (meaning), and
// its Ports. It renders NO "At session" section (that is the Node Value Tap slot, out of scope here).
// The catalog is the golden catalog (real nodeTypeById); the component cache is stubbed. NO network.
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentDefinition, StrategyDocument } from '@quantize/quantize-ir'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import type { StrategyDocumentActions } from '../document/store'
import { Inspector } from './Inspector'

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

function renderInspector(componentNode: NonNullable<Parameters<typeof Inspector>[0]['componentNode']>) {
  return render(
    <Inspector
      doc={emptyDoc()}
      selectedNodeId={null}
      actions={stubActions()}
      componentNode={componentNode}
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

    // NO "At session" section — the Node Value Tap slot is out of scope for inner nodes.
    expect(screen.queryByRole('region', { name: 'at session' })).not.toBeInTheDocument()
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
    })

    expect(screen.getByText('Sub Component')).toBeInTheDocument()
    expect(screen.getByText('0.5')).toBeInTheDocument()
    expect(screen.getByText(/read-only/i)).toBeInTheDocument()
    // Still no editable control and no At-session section.
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'at session' })).not.toBeInTheDocument()
  })
})
