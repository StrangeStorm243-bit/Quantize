// App extraction-mode orchestration (M12.5, E2/E5). The App owns `extractionMode` + an
// `extractionSelection` set: entering the mode seeds/clears it, a node click toggles membership, Cancel
// clears + exits, and a blessed extraction (dialog `onExtracted`) exits + bumps the palette refresh
// nonce. We mock Canvas (to observe `selectedNodeIds`/`extractionMode` and drive toggles), ExtractDialog
// (to observe its selection + fire onExtracted/onCancel), and Palette (to observe the refresh nonce).
// The api client is stubbed so no child hits the network. NO network.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { newStrategyDocument } from './document/store'

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
  }
})

// Canvas mock: expose the extraction props and buttons that toggle nodes into/out of the set.
vi.mock('./components/Canvas', () => ({
  Canvas: (props: {
    selectedNodeIds?: ReadonlySet<string>
    extractionMode?: boolean
    onToggleExtractionNode?: (id: string) => void
  }) => (
    <div>
      <span data-testid="ext-mode">{String(props.extractionMode)}</span>
      <span data-testid="sel-count">{props.selectedNodeIds ? props.selectedNodeIds.size : -1}</span>
      <span data-testid="sel-ids">
        {props.selectedNodeIds === undefined ? 'off' : [...props.selectedNodeIds].sort().join(',')}
      </span>
      <button type="button" onClick={() => props.onToggleExtractionNode?.('n1')}>
        toggle-n1
      </button>
      <button type="button" onClick={() => props.onToggleExtractionNode?.('n2')}>
        toggle-n2
      </button>
    </div>
  ),
}))

// ExtractDialog mock: expose its selection and buttons to simulate a blessed extraction / a cancel. A
// blessed extraction now goes through `onCommit(capturedDoc, strategy, id)`; passing the LIVE `doc`
// (unchanged) makes the App-owned identity guard apply it (replace + onExtracted internally).
vi.mock('./components/ExtractDialog', () => ({
  ExtractDialog: (props: {
    doc: unknown
    selection: ReadonlySet<string>
    onCommit: (captured: unknown, strategy: unknown, id: string) => boolean
    onCancel: () => void
  }) => (
    <div data-testid="extract-dialog">
      <span data-testid="dlg-selection">{[...props.selection].sort().join(',')}</span>
      <button
        type="button"
        onClick={() => props.onCommit(props.doc, newStrategyDocument('Extracted'), 'newnode')}
      >
        simulate-extracted
      </button>
      <button type="button" onClick={props.onCancel}>
        dlg-cancel
      </button>
    </div>
  ),
}))

// Palette mock: render the refresh nonce so the increment on extraction success is observable.
vi.mock('./components/Palette', () => ({
  Palette: (props: { refreshKey?: number }) => (
    <div data-testid="palette-refresh">{String(props.refreshKey)}</div>
  ),
}))

// eslint-disable-next-line import/first
import { App } from './App'

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('App extraction mode', () => {
  it('enters mode, toggles node membership, and reflects the count', async () => {
    render(<App />)
    // Not in mode initially; the entry affordance is visible.
    expect(screen.getByTestId('ext-mode')).toHaveTextContent('false')
    fireEvent.click(screen.getByRole('button', { name: 'Extract component' }))
    expect(screen.getByTestId('ext-mode')).toHaveTextContent('true')
    expect(screen.getByTestId('sel-count')).toHaveTextContent('0')

    // Toggling accumulates and removes set members.
    fireEvent.click(screen.getByText('toggle-n1'))
    expect(screen.getByTestId('sel-ids')).toHaveTextContent('n1')
    fireEvent.click(screen.getByText('toggle-n2'))
    expect(screen.getByTestId('sel-ids')).toHaveTextContent('n1,n2')
    fireEvent.click(screen.getByText('toggle-n1'))
    expect(screen.getByTestId('sel-ids')).toHaveTextContent('n2')
    expect(screen.getByTestId('sel-count')).toHaveTextContent('1')
    await flush()
  })

  it('Cancel clears the set and exits the mode', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Extract component' }))
    fireEvent.click(screen.getByText('toggle-n1'))
    expect(screen.getByTestId('sel-ids')).toHaveTextContent('n1')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('ext-mode')).toHaveTextContent('false')
    expect(screen.getByTestId('sel-ids')).toHaveTextContent('off')
    // Re-entering shows an empty set (it was cleared).
    fireEvent.click(screen.getByRole('button', { name: 'Extract component' }))
    expect(screen.getByTestId('sel-count')).toHaveTextContent('0')
    await flush()
  })

  it('opens the dialog with the selection and, on success, exits the mode + bumps the palette', async () => {
    render(<App />)
    expect(screen.getByTestId('palette-refresh')).toHaveTextContent('0')
    fireEvent.click(screen.getByRole('button', { name: 'Extract component' }))
    fireEvent.click(screen.getByText('toggle-n1'))
    fireEvent.click(screen.getByText('toggle-n2'))

    // "Create component…" opens the dialog with the current selection.
    fireEvent.click(screen.getByRole('button', { name: 'Create component…' }))
    expect(screen.getByTestId('extract-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('dlg-selection')).toHaveTextContent('n1,n2')

    // A blessed extraction exits the mode, closes the dialog, and increments the palette refresh nonce.
    fireEvent.click(screen.getByText('simulate-extracted'))
    expect(screen.getByTestId('ext-mode')).toHaveTextContent('false')
    expect(screen.queryByTestId('extract-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('palette-refresh')).toHaveTextContent('1')
    await flush()
  })

  it('"Create component…" is disabled with an empty selection', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Extract component' }))
    expect(screen.getByRole('button', { name: 'Create component…' })).toBeDisabled()
    await flush()
  })
})
