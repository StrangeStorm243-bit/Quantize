// ExtractDialog + two-phase commit tests (M12.5, E5/E6). The CRITICAL invariant: the document is NEVER
// mutated on any abort path — proven here by asserting `onReplace` is NOT called whenever extraction,
// save, or validate fails. `saveComponent`/`validateStrategy` are mocked; `extractComponent` is a
// spy-through (real behaviour, recorded calls) so the preview + port-name flow are exercised for real.
// The catalog resolves from the committed golden (no network).
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValidateResponse } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import strategyAJson from '../../../tests/fixtures/strategy_a.json'
import { addNode, newStrategyDocument } from '../document/store'
import { CatalogProvider } from '../catalog'
import { ExtractDialog } from './ExtractDialog'

const mocks = vi.hoisted(() => ({ seed: vi.fn() }))

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return {
    ...actual,
    getNodeCatalog: () => Promise.resolve(json),
    saveComponent: vi.fn(),
    validateStrategy: vi.fn(),
  }
})

// Control `seed` (asserted on the happy path) and keep the cache empty (strategy_a has no nested refs).
// The returned value + its `defs` Map are STABLE across renders so the dialog's preview `useMemo` (keyed
// on `defs`) doesn't recompute spuriously — otherwise a busy-state re-render would fire a stray preview
// `extractComponent` and mask the real confirm call under test.
vi.mock('../components-cache', () => {
  const value = {
    defs: new Map(),
    get: () => undefined,
    ensure: () => {},
    seed: mocks.seed,
    isLoading: () => false,
    errorOf: () => undefined,
  }
  return {
    useComponentDefs: () => value,
    ComponentsProvider: ({ children }: { children: ReactNode }) => children,
    componentCacheKey: (id: string, version: string) => `${id}@${version}`,
    componentPorts: () => ({ inputs: [], outputs: [] }),
  }
})

// Spy-through: real extraction behaviour, but calls are recorded so we can assert the port-name flow.
vi.mock('../document/extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../document/extract')>()
  return { ...actual, extractComponent: vi.fn(actual.extractComponent) }
})

// eslint-disable-next-line import/first
import { saveComponent, validateStrategy } from '../api/client'
// eslint-disable-next-line import/first
import { extractComponent } from '../document/extract'

const OK_VERDICT: ValidateResponse = {
  ok: true,
  structural: [],
  semantic: [],
  runtime: [],
  warmup_sessions: 0,
} as unknown as ValidateResponse

beforeEach(() => {
  vi.mocked(saveComponent).mockResolvedValue({} as never)
  vi.mocked(validateStrategy).mockResolvedValue(OK_VERDICT)
})

afterEach(() => {
  vi.clearAllMocks()
})

function strategyA(): StrategyDocument {
  return structuredClone(strategyAJson) as unknown as StrategyDocument
}

// The momentum subgraph selection (audit-verified: exposed inputs `series` + `universe`, output `assets`).
const MOMENTUM = new Set(['ret', 'rk', 'sel'])

function renderDialog(
  doc: StrategyDocument,
  selection: ReadonlySet<string>,
  overrides: Partial<{
    onReplace: (d: StrategyDocument) => void
    onCancel: () => void
    onExtracted: (id: string) => void
  }> = {},
): {
  onReplace: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  onExtracted: ReturnType<typeof vi.fn>
} {
  const onReplace = vi.fn(overrides.onReplace)
  const onCancel = vi.fn(overrides.onCancel)
  const onExtracted = vi.fn(overrides.onExtracted)
  render(
    <CatalogProvider>
      <ExtractDialog
        doc={doc}
        selection={selection}
        onReplace={onReplace}
        onCancel={onCancel}
        onExtracted={onExtracted}
      />
    </CatalogProvider>,
  )
  return { onReplace, onCancel, onExtracted }
}

describe('ExtractDialog preview', () => {
  it('shows the deduped exposed ports for the momentum selection (series, universe in; assets out)', async () => {
    renderDialog(strategyA(), MOMENTUM)
    // Once the catalog resolves the dry-run computes the port names as editable inputs.
    expect(await screen.findByLabelText('port name series')).toBeInTheDocument()
    expect(screen.getByLabelText('port name universe')).toBeInTheDocument()
    expect(screen.getByLabelText('port name assets')).toBeInTheDocument()
  })

  it('shows a fan-out output as ONE deduped exposed port (two consumers → one port)', async () => {
    // sel's `assets` output feeds two OUTSIDE nodes; the boundary dedupes to a single exposed output.
    let doc = newStrategyDocument('t')
    doc = addNode(doc, {
      typeId: 'portfolio.select_top_n',
      typeVersion: '1.0.0',
      params: { n: 3 },
      position: { x: 0, y: 0 },
    })
    doc = addNode(doc, {
      typeId: 'portfolio.equal_weight',
      typeVersion: '1.0.0',
      params: {},
      position: { x: 200, y: 0 },
    })
    doc = addNode(doc, {
      typeId: 'data.price',
      typeVersion: '1.0.0',
      params: {},
      position: { x: 200, y: 200 },
    })
    const [sel, ew, px] = doc.nodes
    doc = {
      ...doc,
      edges: [
        { from: [sel.id, 'assets'], to: [ew.id, 'assets'] },
        { from: [sel.id, 'assets'], to: [px.id, 'assets'] },
      ],
    }
    renderDialog(doc, new Set([sel.id]))
    // Exactly one `assets` output port, despite the two rewired consumers.
    expect(await screen.findByLabelText('port name assets')).toBeInTheDocument()
    expect(screen.getAllByLabelText('port name assets')).toHaveLength(1)
  })

  it('blocks Confirm on a bad port-name identifier and re-enables on a valid rename', async () => {
    renderDialog(strategyA(), MOMENTUM)
    const seriesPort = await screen.findByLabelText('port name series')
    fireEvent.change(screen.getByLabelText('component name'), { target: { value: 'Momentum' } })
    const confirm = screen.getByRole('button', { name: 'Create component' })
    expect(confirm).not.toBeDisabled()

    // A space is not in `^[A-Za-z0-9_]+$` → Confirm blocked.
    fireEvent.change(seriesPort, { target: { value: 'bad name' } })
    expect(confirm).toBeDisabled()
    expect(screen.getAllByText('must be a valid identifier').length).toBeGreaterThan(0)

    // A valid rename → Confirm allowed again.
    fireEvent.change(seriesPort, { target: { value: 'series_in' } })
    expect(confirm).not.toBeDisabled()
  })
})

describe('ExtractDialog two-phase commit', () => {
  it('happy path: extract → save → validate ok → replace(strategy) + seed(def) + onExtracted', async () => {
    const { onReplace, onExtracted } = renderDialog(strategyA(), MOMENTUM)
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))

    await waitFor(() => expect(onReplace).toHaveBeenCalledTimes(1))
    const rewritten = onReplace.mock.calls[0][0] as StrategyDocument
    // The rewrite dropped the 3 inner nodes and inserted ONE component instance (8 → 6 nodes).
    expect(rewritten.nodes).toHaveLength(6)
    expect(rewritten.nodes.some((n) => 'ref' in n)).toBe(true)
    expect(rewritten.component_refs).toHaveLength(1)
    expect(vi.mocked(saveComponent)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(validateStrategy)).toHaveBeenCalledTimes(1)
    expect(mocks.seed).toHaveBeenCalledTimes(1)
    expect(onExtracted).toHaveBeenCalledTimes(1)
    // The minted instance node's id (a node present in the rewrite but not the original) was reported.
    expect(onExtracted.mock.calls[0][0]).toEqual(expect.any(String))
    expect(onExtracted.mock.calls[0][0]).not.toBe('')
  })

  it('validate ok:false → renders diagnostics and NEVER replaces the document', async () => {
    vi.mocked(validateStrategy).mockResolvedValue({
      ok: false,
      structural: [],
      semantic: [],
      runtime: [{ code: 'component_direct_recursion', message: 'recursion', subject: 'mom', node_path: [] }],
    } as unknown as ValidateResponse)
    const { onReplace, onExtracted } = renderDialog(strategyA(), MOMENTUM)
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))

    // The component was saved (phase 2), then validate rejected → the diagnostic code renders...
    expect(await screen.findByText('component_direct_recursion')).toBeInTheDocument()
    // ...and the document is UNTOUCHED (the two-phase contract).
    expect(onReplace).not.toHaveBeenCalled()
    expect(onExtracted).not.toHaveBeenCalled()
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it('saveComponent throws (ApiClientError) → error shown and the document is NEVER replaced', async () => {
    const { ApiClientError } = await import('../api/client')
    vi.mocked(saveComponent).mockRejectedValue(
      new ApiClientError('component_divergent_version', 'divergent', 409),
    )
    const { onReplace, onExtracted } = renderDialog(strategyA(), MOMENTUM)
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))

    expect(await screen.findByText(/component_divergent_version/)).toBeInTheDocument()
    expect(vi.mocked(validateStrategy)).not.toHaveBeenCalled()
    expect(onReplace).not.toHaveBeenCalled()
    expect(onExtracted).not.toHaveBeenCalled()
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it('disconnected selection → extraction error shown, NO client call, document NEVER replaced', async () => {
    // Two unconnected nodes → `extractComponent` returns {error} at the structural pre-check.
    let doc = newStrategyDocument('t')
    doc = addNode(doc, { typeId: 'transform.rank', typeVersion: '1.0.0', params: {}, position: { x: 0, y: 0 } })
    doc = addNode(doc, {
      typeId: 'transform.trailing_return',
      typeVersion: '1.0.0',
      params: {},
      position: { x: 200, y: 0 },
    })
    const selection = new Set(doc.nodes.map((n) => n.id))
    const { onReplace } = renderDialog(doc, selection)

    // The preview surfaces the structural error and Confirm stays disabled — no network call is possible.
    expect(await screen.findByText(/single connected subgraph/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create component' })).toBeDisabled()
    expect(vi.mocked(saveComponent)).not.toHaveBeenCalled()
    expect(vi.mocked(validateStrategy)).not.toHaveBeenCalled()
    expect(onReplace).not.toHaveBeenCalled()
  })

  it('a valid port rename flows into the real extractComponent call as portNames', async () => {
    renderDialog(strategyA(), MOMENTUM)
    const seriesPort = await screen.findByLabelText('port name series')
    fireEvent.change(screen.getByLabelText('component name'), { target: { value: 'Momentum' } })
    fireEvent.change(seriesPort, { target: { value: 'series_in' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))

    await waitFor(() => expect(vi.mocked(extractComponent).mock.calls.length).toBeGreaterThan(1))
    const lastCall = vi.mocked(extractComponent).mock.calls.at(-1)
    const opts = lastCall?.[4]
    expect(opts?.portNames?.get('series')).toBe('series_in')
  })
})
