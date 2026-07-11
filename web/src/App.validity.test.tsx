// App-level node-validity lifecycle (M13.4, D-7). Unlike App.test.tsx, this file uses the REAL
// ValidatePanel and the REAL Dock, because the bug it guards is a DOCK LIFECYCLE bug: the dock mounts
// only the active panel, so switching tabs unmounts/remounts ValidatePanel. Node badges must survive
// that navigation (no semantic change) and clear only on a real semantic mutation. Canvas is mocked to
// expose `nodeValidity` (the badge map) and to add a node; the api client is stubbed (NO network).
import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
vi.mock('./api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/client')>()
  return {
    ...actual,
    getMeta: vi
      .fn()
      .mockResolvedValue({ api_version: 'v1', schema_version: '0.1.0', record_format: 1, trace_format: 1 }),
    getNodeCatalog: vi.fn().mockResolvedValue({
      api_version: 'v1',
      schema_version: '0.1.0',
      catalog_digest: '0'.repeat(64),
      port_types: [],
      compatibility: [],
      node_types: [],
    }),
    listStrategies: vi.fn().mockResolvedValue({ strategies: [] }),
    listComponents: vi.fn().mockResolvedValue({ components: [] }),
    getRun: vi.fn(),
    // The real ValidatePanel calls this; an ok verdict badges every node valid.
    validateStrategy: vi
      .fn()
      .mockResolvedValue({ ok: true, structural: [], semantic: [], runtime: [], warmup_sessions: 3 }),
  }
})

// Mock Canvas to expose the badge map (`nodeValidity`) and a button that adds a node via the store
// actions (a real semantic mutation). We render the count of nodes badged 'valid'.
vi.mock('./components/Canvas', () => ({
  Canvas: (props: {
    nodeValidity?: Map<string, string>
    actions: { addNode: (args: unknown) => void }
  }) => (
    <div>
      <span data-testid="valid-count">
        {props.nodeValidity
          ? [...props.nodeValidity.values()].filter((v) => v === 'valid').length
          : 0}
      </span>
      <button
        type="button"
        onClick={() =>
          props.actions.addNode({
            typeId: 'x.y',
            typeVersion: '1.0.0',
            params: {},
            position: { x: 0, y: 0 },
          })
        }
      >
        add-node
      </button>
    </div>
  ),
}))

// Stub the other dock panels / heavy children so only the badge path is under test (no network).
vi.mock('./components/RunPanel', () => ({ RunPanel: () => <div>runs-panel</div> }))
vi.mock('./components/Palette', () => ({ Palette: () => <div>palette</div> }))
vi.mock('./components/Home', () => ({
  DEMO_NAME: /momentum/i,
  Home: (props: { onNew: (name: string) => void }) => (
    <button type="button" onClick={() => props.onNew('Test')}>
      home-new
    </button>
  ),
}))

// eslint-disable-next-line import/first
import { App } from './App'

const validCount = (): string => screen.getByTestId('valid-count').textContent ?? ''

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('App node-validity across dock navigation (D-7)', () => {
  it('keeps badges when switching dock tabs, and clears them only on a semantic mutation', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('home-new')) // enter the editor
    await flush() // boot-time catalog/meta fetches

    // Add a node, then validate it. An ok verdict badges the node valid → the badge map has one entry.
    fireEvent.click(screen.getByText('add-node'))
    const validateButtons = screen.getAllByRole('button', { name: 'Validate' })
    fireEvent.click(validateButtons[validateButtons.length - 1]) // the panel's own Validate button
    await flush()
    expect(validCount()).toBe('1')

    // Switch AWAY from Problems (dock unmounts ValidatePanel) and BACK (remounts it). No semantic
    // change occurred — the badge must survive the navigation. This is the reported bug.
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    expect(screen.getByText('runs-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Problems' }))
    await flush()
    expect(validCount()).toBe('1')

    // A real semantic mutation (adding another node) MUST clear the badge — the prior verdict no longer
    // describes the current graph.
    fireEvent.click(screen.getByText('add-node'))
    await flush()
    expect(validCount()).toBe('0')
  })

  it('does NOT replay an already-consumed StrategyBar validation on Problems remount', async () => {
    // The StrategyBar Validate button drives validation via a nonce (external trigger), NOT the panel's
    // own button. Once consumed, remounting the panel (dock navigation) must NOT re-fire it. We make any
    // SECOND validation error, so a spurious replay would call onResult(undefined) and wipe the badge.
    const { validateStrategy } = await import('./api/client')
    const mockValidate = vi.mocked(validateStrategy)
    mockValidate.mockReset()
    mockValidate
      .mockResolvedValueOnce({ ok: true, structural: [], semantic: [], runtime: [], warmup_sessions: 3 })
      .mockRejectedValue(new TypeError('replayed validation must never happen'))

    render(<App />)
    fireEvent.click(screen.getByText('home-new'))
    await flush()

    fireEvent.click(screen.getByText('add-node'))
    // The StrategyBar Validate button is the FIRST 'Validate' in the tree (before the dock panel's).
    fireEvent.click(screen.getAllByRole('button', { name: 'Validate' })[0])
    await flush()
    expect(validCount()).toBe('1')
    expect(mockValidate).toHaveBeenCalledTimes(1)

    // Navigate away and back: the panel remounts with the same (already-consumed) nonce. It must be
    // inert — no second validation, so the badge survives and the erroring mock is never reached.
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Problems' }))
    await flush()
    expect(mockValidate).toHaveBeenCalledTimes(1)
    expect(validCount()).toBe('1')
  })

  it('issues exactly one validation for one StrategyBar click under StrictMode (mount-with-nonce)', async () => {
    // The REAL dev entry (main.tsx) wraps <App/> in StrictMode, which double-invokes mount effects.
    // Clicking StrategyBar Validate from the Runs tab (Problems NOT mounted) mounts ValidatePanel WITH a
    // positive nonce, so its mount effect runs twice before any parent re-render lands. An App-owned
    // SYNCHRONOUS consume guard must ensure exactly one request — an async nonce reset cannot, as it
    // hasn't landed by the second invocation.
    const { validateStrategy } = await import('./api/client')
    const mockValidate = vi.mocked(validateStrategy)
    mockValidate.mockReset()
    mockValidate.mockResolvedValue({ ok: true, structural: [], semantic: [], runtime: [], warmup_sessions: 3 })

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    fireEvent.click(screen.getByText('home-new'))
    await flush()

    // Start on Runs: ValidatePanel (Problems) is not mounted.
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
    expect(screen.getByText('runs-panel')).toBeInTheDocument()

    // One top-bar Validate click → dock switches to Problems, ValidatePanel mounts with the nonce.
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await flush()
    expect(mockValidate).toHaveBeenCalledTimes(1)
  })
})
