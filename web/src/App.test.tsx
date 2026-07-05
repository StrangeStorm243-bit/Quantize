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

// eslint-disable-next-line import/first
import { App } from './App'

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
