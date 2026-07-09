// Inspector — primitive-node Explanation/Ports/At-session sections (M13.5). Uses the committed golden
// catalog through a PARTIAL module mock: useCatalog is stubbed to serve a per-test catalog object,
// everything else (nodeTypeById, labelOf, portColor consumers, …) stays the real implementation. NO network.
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeCatalogResponse, NodeTypeDto } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import type { StrategyDocumentActions } from '../document/store'

const state = vi.hoisted(() => ({ catalog: undefined as unknown }))

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
    get: () => undefined,
    ensure: vi.fn(),
    seed: vi.fn(),
    isLoading: () => false,
    errorOf: () => undefined,
  }),
}))

// eslint-disable-next-line import/first
import { Inspector } from './Inspector'

function stubActions(): StrategyDocumentActions {
  return {
    addNode: vi.fn(), removeNode: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
    setParams: vi.fn(), setNodeUi: vi.fn(), replace: vi.fn(),
    replaceIf: vi.fn().mockReturnValue(true),
  }
}

function docWith(typeId: string, params: Record<string, unknown> = {}): StrategyDocument {
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
    nodes: [{ id: 'n1', type_id: typeId, type_version: '1.0.0', params: params as never }],
    edges: [],
  }
}

beforeEach(() => {
  state.catalog = structuredClone(catalogJson) as unknown as NodeCatalogResponse
})

describe('Inspector — Explanation section (M13.5)', () => {
  it('renders the role sentence FIRST, then formula, then semantics/warm-up', () => {
    render(<Inspector doc={docWith('transform.trailing_return', { lookback_sessions: 63 })}
                      selectedNodeId="n1" actions={stubActions()} />)
    const summary = screen.getByText(/Measures each asset's momentum as its return/)
    const formula = screen.getByText(/r_D = close\(D\) \/ close\(D - L\) - 1/)
    const semantics = screen.getByText(/Warm-up: lookback_sessions prior sessions/)
    expect(summary.compareDocumentPosition(formula) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(formula.compareDocumentPosition(semantics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(/latex/i)).not.toBeInTheDocument()
  })

  it('renders the Ports section with names, served type labels, and the required marker', () => {
    render(<Inspector doc={docWith('transform.trailing_return')} selectedNodeId="n1" actions={stubActions()} />)
    const ports = screen.getByRole('region', { name: 'ports' })
    expect(within(ports).getByText('series')).toBeInTheDocument()
    expect(within(ports).getByText('TimeSeries[Number]')).toBeInTheDocument()
    expect(within(ports).getByText('required')).toBeInTheDocument()
    expect(within(ports).getByText('values')).toBeInTheDocument()
    expect(within(ports).getByText('CrossSection[Number]')).toBeInTheDocument()
  })

  it('drives ParamForm with doc labels/help and still emits raw-key params', () => {
    const actions = stubActions()
    render(<Inspector doc={docWith('transform.trailing_return')} selectedNodeId="n1" actions={actions} />)
    const input = screen.getByLabelText('Lookback sessions')
    expect(screen.getByText(/Calendar sessions back to the anchor close/)).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '21' } })
    expect(actions.setParams).toHaveBeenCalledWith('n1', { lookback_sessions: 21 })
  })

  it('falls back to the catalog description for a doc-less node type, without crashing', () => {
    ;(state.catalog as NodeCatalogResponse).node_types.push({
      type_id: 'future.mystery', type_version: '1.0.0', display_name: 'Mystery',
      description: 'A future node with no doc block.', category: 'statistics',
      doc: null, inputs: [], outputs: [], parameter_schema: null,
    } as NodeTypeDto)
    render(<Inspector doc={docWith('future.mystery')} selectedNodeId="n1" actions={stubActions()} />)
    expect(screen.getByText('A future node with no doc block.')).toBeInTheDocument()
    expect(screen.queryByText('Formula')).not.toBeInTheDocument()
  })

  it('renders a reserved-category node WITH a doc block generically (ceiling absorption)', () => {
    ;(state.catalog as NodeCatalogResponse).node_types.push({
      type_id: 'stats.regression', type_version: '1.0.0', display_name: 'Regression',
      description: 'Fits a linear model.', category: 'statistics',
      doc: {
        summary: 'Explains each asset by a fitted linear model.',
        formula: 'y = Xβ + ε', latex: 'LATEX_SENTINEL_XYZ',
        semantics: 'Assets with insufficient history are excluded.',
        parameters: {},
      },
      inputs: [], outputs: [], parameter_schema: null,
    } as NodeTypeDto)
    render(<Inspector doc={docWith('stats.regression')} selectedNodeId="n1" actions={stubActions()} />)
    expect(screen.getByText('Explains each asset by a fitted linear model.')).toBeInTheDocument()
    expect(screen.getByText('y = Xβ + ε')).toBeInTheDocument()
    // A populated `latex` is RESERVED and must never render — the formula shows, the latex does not.
    expect(screen.queryByText('LATEX_SENTINEL_XYZ')).not.toBeInTheDocument()
  })

  it('renders the "At session" shell with its empty state', () => {
    render(<Inspector doc={docWith('transform.trailing_return')} selectedNodeId="n1" actions={stubActions()} />)
    const shell = screen.getByRole('region', { name: 'at session' })
    expect(within(shell).getByText(/run a strategy and select a session/i)).toBeInTheDocument()
  })
})
