// App coordination (M11.9, F1): the positional edge highlight is an INDEX into `doc.edges`, so it
// must be cleared on ANY document change — otherwise a stale index mis-highlights (and, being
// RF-`selected`, is Backspace-deletable). We mock Canvas (to observe the `highlightedEdgeIndex` prop
// and to trigger a doc mutation) and ValidatePanel (to trigger an edge highlight), and stub the api
// client so no child does real network. NO network.
import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { newStrategyDocument } from './document/store'

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
    // The real Palette now fetches the saved-component list (M12.3) — resolve it empty (no network).
    listComponents: vi.fn().mockResolvedValue({ components: [] }),
    // Per-test controllable: the App's lifted record fetch (M11.9 F7) is driven through this.
    getRun: vi.fn(),
  }
})

// Mock Canvas: expose the highlightedEdgeIndex prop, a button that mutates the doc via `actions`, and a
// button that toggles an extraction-selection node (so the extraction flow can be driven without RF).
vi.mock('./components/Canvas', () => ({
  Canvas: (props: {
    highlightedEdgeIndex?: number | null
    actions: { addNode: (args: unknown) => void }
    onToggleExtractionNode?: (id: string) => void
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
      <button type="button" onClick={() => props.onToggleExtractionNode?.('n-1')}>
        toggle-extract-node
      </button>
    </div>
  ),
}))

// Mock ExtractDialog: instead of the real two-phase commit, it CAPTURES the doc identity at first mount
// (mirroring `onConfirm`'s captured-doc) and exposes a button that hands that captured doc back to the
// App's `onCommit`. This exercises the App-owned live-document IDENTITY guard end-to-end: if the live
// doc changed since the dialog opened, `onCommit` must refuse (return false) and NOT replace.
vi.mock('./components/ExtractDialog', () => ({
  ExtractDialog: (props: {
    doc: unknown
    onCommit: (captured: unknown, strategy: unknown, id: string) => boolean
  }) => {
    const captured = useRef(props.doc)
    return (
      <button
        type="button"
        onClick={() => props.onCommit(captured.current, newStrategyDocument('Extracted'), 'n-new')}
      >
        commit-captured
      </button>
    )
  },
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

// Mock Home (M13.3): the app now opens on Home. A stub exposes a button that enters the editor via
// onNew, so these editor-focused tests reach the editor without the real Home's dataset network.
vi.mock('./components/Home', () => ({
  Home: (props: { onNew: (name: string) => void }) => (
    <button type="button" onClick={() => props.onNew('Test')}>
      home-new
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

// Render the app and enter the editor (M13.3: the app opens on Home; the mocked Home's button opens
// a fresh document named "Test").
function renderEditor(): void {
  render(<App />)
  fireEvent.click(screen.getByText('home-new'))
}

describe('App edge-highlight lifecycle', () => {
  it('clears a stale positional edge highlight when the document changes', async () => {
    renderEditor()
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
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
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
      // `valuations`/`evaluations` are present (empty) because the App now reads them to seed the
      // session cursor + its evaluated-session markers (M13.7).
      resolveGetRun({
        record: { run_id: 'run-1', valuations: [], evaluations: [] },
        replay_verifiable: true,
      } as unknown as GetRunResult)
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

describe('App extraction commit guard (M12.5b)', () => {
  // Drive the mocked Canvas + the real toolbar to open the (mocked) ExtractDialog with one node selected.
  async function openExtractDialog(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'Extract component' }))
    fireEvent.click(screen.getByText('toggle-extract-node'))
    fireEvent.click(screen.getByRole('button', { name: /Create component/ }))
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('applies the extraction when the live doc is unchanged since the commit started', async () => {
    renderEditor()
    await openExtractDialog()
    // captured === live → the App-owned guard passes → the doc is replaced with the extraction result.
    fireEvent.click(screen.getByText('commit-captured'))
    // The strategy bar now shows the extracted document's name (M13.3: name/version are separate spans).
    expect(screen.getByText('Extracted')).toBeInTheDocument()
    // The applied path closes the dialog (onExtracted).
    expect(screen.queryByText('commit-captured')).not.toBeInTheDocument()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('refuses to clobber the live doc when it changed mid-flight (an edit during the commit)', async () => {
    renderEditor()
    await openExtractDialog()
    // Mutate the live document via the canvas AFTER the dialog captured the doc — a real mid-flight
    // change. The store returns a NEW object, so the replaceIf compare-and-swap sees a different live
    // doc than the one captured at Confirm and refuses.
    fireEvent.click(screen.getByText('mutate-doc'))

    // Commit the STALE captured doc → the identity guard must refuse; nothing is replaced.
    fireEvent.click(screen.getByText('commit-captured'))
    expect(screen.getByText('Test')).toBeInTheDocument() // still the original document
    expect(screen.queryByText('Extracted')).not.toBeInTheDocument()
    // The dialog stays open (onExtracted never fired) — the commit was rejected, not applied.
    expect(screen.getByText('commit-captured')).toBeInTheDocument()
    await act(async () => {
      await Promise.resolve()
    })
  })
})
