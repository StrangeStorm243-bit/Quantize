// ValidatePanel renders per-layer diagnostics and computes STRUCTURED highlight targets from
// loc/node_path (never from the message). The api client is mocked (no network); ApiClientError is
// the real class so `instanceof` in the panel works.
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValidateResponse } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { ApiClientError } from '../api/client'
import { newStrategyDocument } from '../document/store'
import { ValidatePanel } from './ValidatePanel'
import type { HighlightTarget } from './ValidatePanel'

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
})
