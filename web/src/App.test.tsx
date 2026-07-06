// App coordination (M11.9, F1): the positional edge highlight is an INDEX into `doc.edges`, so it
// must be cleared on ANY document change — otherwise a stale index mis-highlights (and, being
// RF-`selected`, is Backspace-deletable). We mock Canvas (to observe the `highlightedEdgeIndex` prop
// and to trigger a doc mutation) and ValidatePanel (to trigger an edge highlight), and stub the api
// client so no child does real network. NO network.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Stub the api client so CatalogProvider / StrategyPanel / useSchemaVersionCheck don't hit the network.
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
    // Per-test controllable: the App's lifted record fetch (M11.9 F7) is driven through this.
    getRun: vi.fn(),
  }
})

// Mock Canvas: expose the highlightedEdgeIndex prop and a button that mutates the doc via `actions`.
vi.mock('./components/Canvas', () => ({
  Canvas: (props: {
    highlightedEdgeIndex?: number | null
    actions: { addNode: (args: unknown) => void }
  }) => (
    <div>
      <span data-testid="edge-highlight">{String(props.highlightedEdgeIndex)}</span>
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
        mutate-doc
      </button>
    </div>
  ),
}))

// Mock ValidatePanel: a button that dispatches an edge-index highlight (as a real edge diagnostic would).
vi.mock('./components/ValidatePanel', () => ({
  ValidatePanel: (props: { onHighlight: (t: { kind: 'edgeIndex'; index: number }) => void }) => (
    <button type="button" onClick={() => props.onHighlight({ kind: 'edgeIndex', index: 1 })}>
      highlight-edge
    </button>
  ),
}))

// Mock RunPanel: a button that selects a run (drives the App's lifted record fetch, F7).
vi.mock('./components/RunPanel', () => ({
  RunPanel: (props: { onSelectRun: (runId: string) => void }) => (
    <button type="button" onClick={() => props.onSelectRun('run-1')}>
      select-run
    </button>
  ),
}))

// Mock ResultsView: expose the App-owned record props so the fetch orchestration is observable.
vi.mock('./components/ResultsView', () => ({
  ResultsView: (props: {
    runId?: string
    record?: { record: { run_id: string } }
    loading: boolean
    error?: string
  }) => (
    <div>
      <span data-testid="rv-run">{String(props.runId)}</span>
      <span data-testid="rv-loading">{String(props.loading)}</span>
      <span data-testid="rv-record">{String(props.record?.record.run_id)}</span>
      <span data-testid="rv-error">{String(props.error)}</span>
    </div>
  ),
}))

// eslint-disable-next-line import/first
import { App } from './App'
// eslint-disable-next-line import/first
import { getRun } from './api/client'

describe('App edge-highlight lifecycle', () => {
  it('clears a stale positional edge highlight when the document changes', async () => {
    render(<App />)
    expect(screen.getByTestId('edge-highlight')).toHaveTextContent('null')

    // A validate edge highlight sets the positional index.
    fireEvent.click(screen.getByText('highlight-edge'))
    expect(screen.getByTestId('edge-highlight')).toHaveTextContent('1')

    // Any document mutation must clear it (the index would otherwise point at a different edge).
    fireEvent.click(screen.getByText('mutate-doc'))
    expect(screen.getByTestId('edge-highlight')).toHaveTextContent('null')

    // Flush the boot-time catalog/meta fetches so their state updates are wrapped in act.
    await act(async () => {
      await Promise.resolve()
    })
  })
})

describe('App run-record fetch (the F7 lift)', () => {
  // Selecting a run switches to the results tab; the App fetches the record ONCE and passes it to
  // ResultsView (mocked here to expose the props). These pin the loading → record and error paths
  // of the orchestration that moved out of the panels in M11.9.
  async function selectRun(): Promise<void> {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'runs' }))
    fireEvent.click(screen.getByText('select-run'))
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('fetches the record on run selection: loading, then the record, for the selected run', async () => {
    type GetRunResult = Awaited<ReturnType<typeof getRun>>
    let resolveGetRun: (value: GetRunResult) => void = () => {}
    vi.mocked(getRun).mockReturnValue(
      new Promise<GetRunResult>((resolve) => {
        resolveGetRun = resolve
      }),
    )
    await selectRun()
    expect(screen.getByTestId('rv-run')).toHaveTextContent('run-1')
    expect(screen.getByTestId('rv-loading')).toHaveTextContent('true')
    expect(screen.getByTestId('rv-record')).toHaveTextContent('undefined')

    await act(async () => {
      // A minimal record shape — the mocked ResultsView reads only record.run_id (test fixture cast).
      resolveGetRun({ record: { run_id: 'run-1' }, replay_verifiable: true } as GetRunResult)
      await Promise.resolve()
    })
    expect(screen.getByTestId('rv-loading')).toHaveTextContent('false')
    expect(screen.getByTestId('rv-record')).toHaveTextContent('run-1')
    expect(vi.mocked(getRun)).toHaveBeenCalledTimes(1)
  })

  it('surfaces a record-fetch failure as the error prop (loading cleared)', async () => {
    vi.mocked(getRun).mockRejectedValue(new Error('record unavailable'))
    await selectRun()
    expect(screen.getByTestId('rv-error')).toHaveTextContent('record unavailable')
    expect(screen.getByTestId('rv-loading')).toHaveTextContent('false')
    expect(screen.getByTestId('rv-record')).toHaveTextContent('undefined')
  })
})
