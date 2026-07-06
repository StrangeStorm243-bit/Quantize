// ExtractDialog + two-phase commit tests (M12.5, E5/E6). The CRITICAL invariant: the document is NEVER
// mutated on any abort path — proven here by asserting `onReplace` is NOT called whenever extraction,
// save, or validate fails. `saveComponent`/`validateStrategy` are mocked; `extractComponent` is a
// spy-through (real behaviour, recorded calls) so the preview + port-name flow are exercised for real.
// The catalog resolves from the committed golden (no network).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    onCommit: (captured: StrategyDocument, strategy: StrategyDocument, id: string) => boolean
    onCancel: () => void
  }> = {},
): {
  onCommit: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  unmount: () => void
} {
  // Default `onCommit` applies (returns true) — the App-side identity guard is exercised in App.test.tsx.
  const onCommit = vi.fn(overrides.onCommit ?? (() => true))
  const onCancel = vi.fn(overrides.onCancel)
  const { unmount } = render(
    <CatalogProvider>
      <ExtractDialog doc={doc} selection={selection} onCommit={onCommit} onCancel={onCancel} />
    </CatalogProvider>,
  )
  return { onCommit, onCancel, unmount }
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
  it('happy path: extract → save → validate ok → commit(strategy) + seed(def)', async () => {
    const { onCommit } = renderDialog(strategyA(), MOMENTUM)
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    // onCommit(capturedDoc, strategy, mintedId): arg[1] is the rewrite, arg[2] the minted instance id.
    const rewritten = onCommit.mock.calls[0][1] as StrategyDocument
    // The rewrite dropped the 3 inner nodes and inserted ONE component instance (8 → 6 nodes).
    expect(rewritten.nodes).toHaveLength(6)
    expect(rewritten.nodes.some((n) => 'ref' in n)).toBe(true)
    expect(rewritten.component_refs).toHaveLength(1)
    expect(vi.mocked(saveComponent)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(validateStrategy)).toHaveBeenCalledTimes(1)
    // Seed happens ONLY after onCommit applied (returned true).
    expect(mocks.seed).toHaveBeenCalledTimes(1)
    // The minted instance node's id (a node present in the rewrite but not the original) was reported.
    expect(onCommit.mock.calls[0][2]).toEqual(expect.any(String))
    expect(onCommit.mock.calls[0][2]).not.toBe('')
  })

  it('validate ok:false → renders diagnostics and NEVER replaces the document', async () => {
    vi.mocked(validateStrategy).mockResolvedValue({
      ok: false,
      structural: [],
      semantic: [],
      runtime: [{ code: 'component_direct_recursion', message: 'recursion', subject: 'mom', node_path: [] }],
    } as unknown as ValidateResponse)
    const { onCommit } = renderDialog(strategyA(), MOMENTUM)
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))

    // The component was saved (phase 2), then validate rejected → the diagnostic code renders...
    expect(await screen.findByText('component_direct_recursion')).toBeInTheDocument()
    // ...and the document is UNTOUCHED (the two-phase contract): no commit, no cache seed.
    expect(onCommit).not.toHaveBeenCalled()
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it('saveComponent throws (ApiClientError) → error shown and the document is NEVER replaced', async () => {
    const { ApiClientError } = await import('../api/client')
    vi.mocked(saveComponent).mockRejectedValue(
      new ApiClientError('component_divergent_version', 'divergent', 409),
    )
    const { onCommit } = renderDialog(strategyA(), MOMENTUM)
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))

    expect(await screen.findByText(/component_divergent_version/)).toBeInTheDocument()
    expect(vi.mocked(validateStrategy)).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
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
    const { onCommit } = renderDialog(doc, selection)

    // The preview surfaces the structural error and Confirm stays disabled — no network call is possible.
    expect(await screen.findByText(/single connected subgraph/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create component' })).toBeDisabled()
    expect(vi.mocked(saveComponent)).not.toHaveBeenCalled()
    expect(vi.mocked(validateStrategy)).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
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

// M12.9: reuse the previously-saved definition on a semantically-identical extraction retry so a
// validate-rejected / commit-refused attempt does not strand a FRESH orphan in the immutable store on
// every retry. Bound: at most one saved component per DISTINCT content.
describe('ExtractDialog orphan-accumulation bound (M12.9)', () => {
  it('validate ok:false then an unchanged retry re-saves under the SAME component_id (A1)', async () => {
    vi.mocked(validateStrategy).mockResolvedValue({
      ok: false,
      structural: [],
      semantic: [],
      runtime: [{ code: 'component_needs_terminal', message: 'no terminal', subject: 'mom', node_path: [] }],
    } as unknown as ValidateResponse)
    renderDialog(strategyA(), MOMENTUM)
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })

    // First attempt: saves, then validate rejects.
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))
    expect(await screen.findByText('component_needs_terminal')).toBeInTheDocument()
    await waitFor(() => expect(vi.mocked(saveComponent)).toHaveBeenCalledTimes(1))
    const firstDef = vi.mocked(saveComponent).mock.calls[0][0] as { component_id: string }

    // Second attempt with UNCHANGED inputs: reuses the id → same component_id saved, no new orphan.
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))
    await waitFor(() => expect(vi.mocked(saveComponent)).toHaveBeenCalledTimes(2))
    const secondDef = vi.mocked(saveComponent).mock.calls[1][0] as { component_id: string }
    expect(secondDef.component_id).toBe(firstDef.component_id)

    // The strategy handed to validate references that SAME reused component_id.
    const secondStrategy = vi.mocked(validateStrategy).mock.calls[1][0] as StrategyDocument
    expect(secondStrategy.component_refs.some((r) => r.component_id === firstDef.component_id)).toBe(true)
  })

  it('a CHANGED retry (renamed component) saves under a DIFFERENT component_id (genuine new component)', async () => {
    vi.mocked(validateStrategy).mockResolvedValue({
      ok: false,
      structural: [],
      semantic: [],
      runtime: [{ code: 'component_needs_terminal', message: 'no terminal', subject: 'mom', node_path: [] }],
    } as unknown as ValidateResponse)
    renderDialog(strategyA(), MOMENTUM)
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))
    await waitFor(() => expect(vi.mocked(saveComponent)).toHaveBeenCalledTimes(1))
    const firstDef = vi.mocked(saveComponent).mock.calls[0][0] as { component_id: string }

    // Change the NAME → the normalized candidate no longer matches → a genuinely different component.
    fireEvent.change(screen.getByLabelText('component name'), { target: { value: 'Momentum v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))
    await waitFor(() => expect(vi.mocked(saveComponent)).toHaveBeenCalledTimes(2))
    const secondDef = vi.mocked(saveComponent).mock.calls[1][0] as { component_id: string }
    expect(secondDef.component_id).not.toBe(firstDef.component_id)
  })

  it('onCommit refused then an unchanged retry reuses the SAME component_id (A1, commit-refused arm)', async () => {
    // onCommit always refuses (doc changed under us). The component is saved but never applied.
    const { onCommit } = renderDialog(strategyA(), MOMENTUM, { onCommit: () => false })
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(vi.mocked(saveComponent)).toHaveBeenCalledTimes(1))
    const firstDef = vi.mocked(saveComponent).mock.calls[0][0] as { component_id: string }

    // Identical retry → the commit-refused path armed the reuse, so the SAME id is re-saved.
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))
    await waitFor(() => expect(vi.mocked(saveComponent)).toHaveBeenCalledTimes(2))
    const secondDef = vi.mocked(saveComponent).mock.calls[1][0] as { component_id: string }
    expect(secondDef.component_id).toBe(firstDef.component_id)
  })
})

// M12.5b: guards that prevent a STALE `ok:true` (or a cancel/navigate mid-flight) from clobbering the
// live document, plus the UX/a11y polish. The two-phase ORDER and the ok:true gate are unchanged — these
// only ADD abort conditions.
describe('ExtractDialog clobber guards + polish (M12.5b)', () => {
  it('duplicate effective exposed-port names disable Confirm with an inline note (FIX 2)', async () => {
    renderDialog(strategyA(), MOMENTUM)
    const series = await screen.findByLabelText('port name series')
    const universe = screen.getByLabelText('port name universe')
    fireEvent.change(screen.getByLabelText('component name'), { target: { value: 'Momentum' } })
    const confirm = screen.getByRole('button', { name: 'Create component' })
    expect(confirm).not.toBeDisabled()

    // Two ports renamed to the SAME identifier — valid grammar, but a namespace collision.
    fireEvent.change(series, { target: { value: 'dup' } })
    fireEvent.change(universe, { target: { value: 'dup' } })
    expect(confirm).toBeDisabled()
    expect(screen.getByText(/must be unique/i)).toBeInTheDocument()
  })

  it('abort controls (Cancel / ×) are disabled while a commit is in flight (FIX 1.1)', async () => {
    // saveComponent never resolves → the dialog latches `busy`.
    vi.mocked(saveComponent).mockReturnValue(new Promise<never>(() => {}))
    renderDialog(strategyA(), MOMENTUM)
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'close' })).toBeDisabled()
  })

  it('a late ok:true after unmount does NOT commit or seed (FIX 1.2 mounted guard)', async () => {
    let resolveValidate: (v: ValidateResponse) => void = () => {}
    vi.mocked(validateStrategy).mockReturnValue(
      new Promise<ValidateResponse>((r) => {
        resolveValidate = r
      }),
    )
    const { onCommit, unmount } = renderDialog(strategyA(), MOMENTUM)
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))

    // saveComponent resolved; validate is now pending → unmount the dialog before it settles.
    await waitFor(() => expect(vi.mocked(validateStrategy)).toHaveBeenCalledTimes(1))
    unmount()

    // The stale ok:true resolves AFTER unmount — the mounted guard must swallow it.
    await act(async () => {
      resolveValidate(OK_VERDICT)
      await Promise.resolve()
    })
    expect(onCommit).not.toHaveBeenCalled()
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it('onCommit refuses (doc changed): non-destructive message, cache NOT seeded (FIX 1.3)', async () => {
    // App reports the live doc is no longer the captured object → returns false. Nothing may be seeded.
    const { onCommit } = renderDialog(strategyA(), MOMENTUM, { onCommit: () => false })
    fireEvent.change(await screen.findByLabelText('component name'), { target: { value: 'Momentum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create component' }))

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/document changed during extraction/i)).toBeInTheDocument()
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it('moves focus into the dialog (the name field) on open (FIX 3)', async () => {
    renderDialog(strategyA(), MOMENTUM)
    expect(await screen.findByLabelText('component name')).toHaveFocus()
  })
})
