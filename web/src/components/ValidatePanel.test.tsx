// ValidatePanel renders per-layer diagnostics and computes STRUCTURED highlight targets from
// loc/node_path (never from the message). The api client is mocked (no network); ApiClientError is
// the real class so `instanceof` in the panel works.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValidateResponse } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { ApiClientError } from '../api/client'
import { addNode, newStrategyDocument, setNodeUi, setParams } from '../document/store'
import { ValidatePanel } from './ValidatePanel'
import type { HighlightTarget } from '../validation/targets'

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, validateStrategy: vi.fn() }
})

// eslint-disable-next-line import/first
import { validateStrategy } from '../api/client'

const mockValidate = vi.mocked(validateStrategy)

const DOC: StrategyDocument = newStrategyDocument('t')

beforeEach(() => {
  mockValidate.mockReset()
})

describe('ValidatePanel', () => {
  it('shows a never-validated hint before any validation has run', () => {
    render(<ValidatePanel doc={DOC} onHighlight={vi.fn()} />)
    expect(screen.getByText(/no diagnostics yet/i)).toBeInTheDocument()
  })

  it('renders per-layer diagnostics and highlights via the structured mapping (never the message)', async () => {
    const verdict: ValidateResponse = {
      ok: false,
      structural: [{ code: 'edge_bad', message: 'edge broken', loc: ['edges', 0], subject: 'e0' }],
      semantic: [{ code: 'node_bad', message: 'node invalid', loc: ['nodes', 1, 'params'], subject: 'n1' }],
      runtime: [{ code: 'rt_bad', message: 'wiring fault', node_path: ['nX'], subject: 'nX' }],
    }
    mockValidate.mockResolvedValue(verdict)
    const targets: HighlightTarget[] = []
    render(<ValidatePanel doc={DOC} onHighlight={(t) => targets.push(t)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))

    // Codes + subjects render.
    expect(await screen.findByText('edge_bad')).toBeInTheDocument()
    expect(screen.getByText('node_bad')).toBeInTheDocument()
    expect(screen.getByText('rt_bad')).toBeInTheDocument()
    expect(screen.getByText('e0')).toBeInTheDocument()

    // Clicking each diagnostic yields the correct computed target.
    fireEvent.click(screen.getByText('edge_bad'))
    fireEvent.click(screen.getByText('node_bad'))
    fireEvent.click(screen.getByText('rt_bad'))
    expect(targets).toEqual([
      { kind: 'edgeIndex', index: 0 },
      { kind: 'nodeIndex', index: 1 },
      { kind: 'nodeId', nodeId: 'nX' },
    ])
  })

  it('shows a success state with warmup_sessions when ok', async () => {
    const verdict: ValidateResponse = { ok: true, structural: [], semantic: [], runtime: [], warmup_sessions: 20 }
    mockValidate.mockResolvedValue(verdict)
    render(<ValidatePanel doc={DOC} onHighlight={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))

    expect(await screen.findByText(/Valid\./)).toBeInTheDocument()
    expect(screen.getByText(/20 sessions/)).toBeInTheDocument()
  })

  it('renders a request-level ApiClientError distinctly (400/422), not as a diagnostic', async () => {
    mockValidate.mockRejectedValue(new ApiClientError('unsupported_schema_version', 'bad version', 422))
    render(<ValidatePanel doc={DOC} onHighlight={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))

    expect(await screen.findByText('unsupported_schema_version')).toBeInTheDocument()
    expect(screen.getByText('bad version')).toBeInTheDocument()
  })

  it('surfaces a non-ApiClientError failure as a request error (no unhandled rejection)', async () => {
    // A raw network TypeError (not an ApiClientError) must be shown, not re-thrown into the voided
    // promise where it would become an unhandled rejection with nothing rendered.
    mockValidate.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<ValidatePanel doc={DOC} onHighlight={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))

    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument()
  })

  it('clears stale diagnostics when the validated document changes', async () => {
    const verdict: ValidateResponse = {
      ok: false,
      structural: [{ code: 'edge_bad', message: 'edge broken', loc: ['edges', 0], subject: 'e0' }],
      semantic: [],
      runtime: [],
    }
    mockValidate.mockResolvedValue(verdict)
    const { rerender } = render(<ValidatePanel doc={DOC} onHighlight={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    expect(await screen.findByText('edge_bad')).toBeInTheDocument()

    // Editing the graph yields a NEW doc value; the stored result now indexes a mutated array, so the
    // panel drops it. The user re-validates the new document to get correctly-indexed diagnostics.
    rerender(<ValidatePanel doc={newStrategyDocument('t2')} onHighlight={vi.fn()} />)
    expect(screen.queryByText('edge_bad')).not.toBeInTheDocument()
  })

  // A doc with a node so a pure ui-move / a semantic param edit can be exercised.
  function docWithNode(): { doc: StrategyDocument; nodeId: string } {
    const doc = addNode(newStrategyDocument('t'), {
      typeId: 'transform.trailing_return',
      typeVersion: '1.0.0',
      params: { lookback_sessions: 63 },
      position: { x: 0, y: 0 },
    })
    return { doc, nodeId: doc.nodes[0].id }
  }

  it('DISCARDS an in-flight verdict that resolves after a semantic edit (never a stale green, D-7)', async () => {
    const { doc, nodeId } = docWithNode()
    let resolveValidate!: (v: ValidateResponse) => void
    mockValidate.mockReturnValue(
      new Promise<ValidateResponse>((r) => {
        resolveValidate = r
      }),
    )
    const onResult = vi.fn()
    const { rerender } = render(
      <ValidatePanel doc={doc} onHighlight={vi.fn()} onResult={onResult} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))

    // The user edits the graph (a real semantic change) while the request is still in flight.
    const edited = setParams(doc, nodeId, { lookback_sessions: 21 })
    rerender(<ValidatePanel doc={edited} onHighlight={vi.fn()} onResult={onResult} />)

    // The stale request now resolves ok:true — it must NOT be published against the edited doc.
    await act(async () => {
      resolveValidate({ ok: true, structural: [], semantic: [], runtime: [], warmup_sessions: 5 })
      await Promise.resolve()
    })

    expect(screen.queryByText(/Valid\./)).not.toBeInTheDocument()
    expect(onResult).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  // Two SAME-KEY validations (fired via the external `validateNonce`, which — unlike the panel button —
  // is not gated by `loading`) can be in flight at once. Request identity (a monotonic ticket), not just
  // the semantic key, decides which one may publish: only the latest ticket wins, regardless of the
  // order the network resolves in. Without the ticket, both requests share the key and both publish.
  function deferredValidations(): Array<(v: ValidateResponse) => void> {
    const resolvers: Array<(v: ValidateResponse) => void> = []
    mockValidate.mockImplementation(
      () =>
        new Promise<ValidateResponse>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    return resolvers
  }
  const diag = (code: string): ValidateResponse => ({
    ok: false,
    structural: [{ code, message: 'm', loc: ['nodes', 0], subject: null }],
    semantic: [],
    runtime: [],
  })
  const okVerdict: ValidateResponse = { ok: true, structural: [], semantic: [], runtime: [], warmup_sessions: 4 }

  it('publishes only the NEWER of two same-key validations when they resolve in REVERSE order', async () => {
    const resolvers = deferredValidations()
    const onResult = vi.fn()
    const { rerender } = render(
      <ValidatePanel doc={DOC} onHighlight={vi.fn()} onResult={onResult} validateNonce={1} />,
    )
    // A second validation of the SAME document (identical semantic key) fires before the first resolves.
    rerender(<ValidatePanel doc={DOC} onHighlight={vi.fn()} onResult={onResult} validateNonce={2} />)
    expect(resolvers).toHaveLength(2)

    // The NEWER request resolves first, then the older one — the older must never overwrite it.
    await act(async () => {
      resolvers[1](diag('newer'))
      await Promise.resolve()
    })
    await act(async () => {
      resolvers[0](diag('older'))
      await Promise.resolve()
    })

    expect(screen.getByText('newer')).toBeInTheDocument()
    expect(screen.queryByText('older')).not.toBeInTheDocument()
  })

  it('a stale older request does NOT clear loading while the newer request is still pending', async () => {
    const resolvers = deferredValidations()
    const { rerender } = render(<ValidatePanel doc={DOC} onHighlight={vi.fn()} validateNonce={1} />)
    rerender(<ValidatePanel doc={DOC} onHighlight={vi.fn()} validateNonce={2} />)
    expect(resolvers).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Validating…' })).toBeInTheDocument()

    // The OLDER request resolves first; the newer is still pending, so the spinner must NOT clear.
    await act(async () => {
      resolvers[0](okVerdict)
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Validating…' })).toBeInTheDocument()

    // The newer request resolves → loading clears.
    await act(async () => {
      resolvers[1](okVerdict)
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument()
  })

  it('a stale older error does NOT overwrite the newer success', async () => {
    const rejecters: Array<(e: unknown) => void> = []
    const resolvers: Array<(v: ValidateResponse) => void> = []
    mockValidate
      .mockImplementationOnce(() => new Promise<ValidateResponse>((_res, rej) => rejecters.push(rej)))
      .mockImplementationOnce(() => new Promise<ValidateResponse>((res) => resolvers.push(res)))
    const { rerender } = render(<ValidatePanel doc={DOC} onHighlight={vi.fn()} validateNonce={1} />)
    rerender(<ValidatePanel doc={DOC} onHighlight={vi.fn()} validateNonce={2} />)

    // The newer request resolves success first.
    await act(async () => {
      resolvers[0](okVerdict)
      await Promise.resolve()
    })
    expect(screen.getByText(/Valid\./)).toBeInTheDocument()

    // The older request rejects LATER — it must not surface an error over the newer success.
    await act(async () => {
      rejecters[0](new TypeError('older network fail'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByText('older network fail')).not.toBeInTheDocument()
    expect(screen.getByText(/Valid\./)).toBeInTheDocument()
  })

  // The dock mounts only the ACTIVE panel, so switching tabs unmounts this panel and switching back
  // remounts it — with the SAME semantic key. The panel must NOT clear the App's mirrored verdict on
  // its own lifecycle: badges clear on a semantic MUTATION, not on dock navigation (M13.4, D-7). The
  // App owns clearing on a real key change; the panel keeps only its local display state.
  it('does NOT clear the mirrored verdict on mount (dock navigation must not wipe badges)', () => {
    const onResult = vi.fn()
    render(<ValidatePanel doc={DOC} onHighlight={vi.fn()} onResult={onResult} />)
    expect(onResult).not.toHaveBeenCalled()
  })

  it('does NOT clear the mirrored verdict when unmounted and remounted with the same doc (tab switch)', () => {
    const onResult = vi.fn()
    const { unmount } = render(<ValidatePanel doc={DOC} onHighlight={vi.fn()} onResult={onResult} />)
    // Switch away from the Problems tab: the dock unmounts the panel.
    unmount()
    // Switch back: the dock remounts it against the unchanged document. No verdict clear may fire.
    render(<ValidatePanel doc={DOC} onHighlight={vi.fn()} onResult={onResult} />)
    expect(onResult).not.toHaveBeenCalled()
  })

  it('does NOT get stuck in Validating… when a semantic edit lands mid-flight', async () => {
    const { doc, nodeId } = docWithNode()
    let resolveValidate!: (v: ValidateResponse) => void
    mockValidate.mockReturnValue(
      new Promise<ValidateResponse>((r) => {
        resolveValidate = r
      }),
    )
    const { rerender } = render(<ValidatePanel doc={doc} onHighlight={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    expect(screen.getByRole('button', { name: 'Validating…' })).toBeInTheDocument()

    // A real semantic edit while the request is in flight changes the key — the in-flight request is
    // now stale and will never publish. The spinner must not stay stuck on the superseded request.
    const edited = setParams(doc, nodeId, { lookback_sessions: 21 })
    rerender(<ValidatePanel doc={edited} onHighlight={vi.fn()} />)

    // The stale request settles; the button must be back to Validate (loading cleared by the edit).
    await act(async () => {
      resolveValidate({ ok: true, structural: [], semantic: [], runtime: [], warmup_sessions: 5 })
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument()
  })

  it('KEEPS the verdict across a pure ui-move (drag) — ui.* is excluded from semantics (D-7)', async () => {
    const { doc, nodeId } = docWithNode()
    const verdict: ValidateResponse = {
      ok: false,
      structural: [{ code: 'edge_bad', message: 'edge broken', loc: ['edges', 0], subject: 'e0' }],
      semantic: [],
      runtime: [],
    }
    mockValidate.mockResolvedValue(verdict)
    const onResult = vi.fn()
    const { rerender } = render(
      <ValidatePanel doc={doc} onHighlight={vi.fn()} onResult={onResult} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    expect(await screen.findByText('edge_bad')).toBeInTheDocument()
    onResult.mockClear()

    // Dragging the node produces a new doc object that differs ONLY in ui.position.
    const moved = setNodeUi(doc, nodeId, { position: { x: 500, y: 500 } })
    rerender(<ValidatePanel doc={moved} onHighlight={vi.fn()} onResult={onResult} />)

    // The diagnostics must persist and the verdict must NOT be cleared by a pure move.
    expect(screen.getByText('edge_bad')).toBeInTheDocument()
    expect(onResult).not.toHaveBeenCalled()
  })
})
