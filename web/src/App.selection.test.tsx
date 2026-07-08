// App selection lifecycle (M12.9, A2): a selected node that LEAVES the document (delete/replace/
// extraction rewrite) must clear `selectedNodeId` — otherwise the stale id lingers as the Inspector
// selection AND phantom-seeds the extraction set (an un-toggleable ghost that errors the preview). We
// mock Canvas to expose `selectedNodeId` + the extraction set and to drive add/select/remove through the
// real store; Palette/Inspector/ValidatePanel/ExtractDialog are stubbed so no child hits the network.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StrategyDocument } from '@quantize/quantize-ir'

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

// Canvas mock: expose the single selection + the extraction set, and buttons that add / select / remove
// the first document node through the REAL store actions (so the App's clear-on-removal effect runs).
vi.mock('./components/Canvas', () => ({
  Canvas: (props: {
    doc: StrategyDocument
    actions: {
      addNode: (args: unknown) => void
      removeNode: (id: string) => void
    }
    onNodeClick: (id: string) => void
    selectedNodeId: string | null
    selectedNodeIds?: ReadonlySet<string>
  }) => (
    <div>
      <span data-testid="sel-node">{String(props.selectedNodeId)}</span>
      <span data-testid="ext-count">{props.selectedNodeIds ? props.selectedNodeIds.size : -1}</span>
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
      <button type="button" onClick={() => props.onNodeClick(props.doc.nodes[0]?.id)}>
        select-first
      </button>
      <button type="button" onClick={() => props.actions.removeNode(props.doc.nodes[0]?.id)}>
        remove-first
      </button>
    </div>
  ),
}))

vi.mock('./components/Palette', () => ({ Palette: () => <div /> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div /> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div /> }))
// The app opens on Home (M13.3); a Home stub enters the editor via onNew.
vi.mock('./components/Home', () => ({
  Home: (props: { onNew: (name: string) => void }) => (
    <button type="button" onClick={() => props.onNew('Test')}>
      home-new
    </button>
  ),
}))

// eslint-disable-next-line import/first
import { App } from './App'

function renderEditor(): void {
  render(<App />)
  fireEvent.click(screen.getByText('home-new'))
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('App selection lifecycle (A2)', () => {
  it('clears the selection when the selected node is removed from the document', async () => {
    renderEditor()
    // Add a node and select it → the selection prop reflects its id.
    fireEvent.click(screen.getByText('add-node'))
    fireEvent.click(screen.getByText('select-first'))
    expect(screen.getByTestId('sel-node')).not.toHaveTextContent('null')

    // Remove that node → the App's effect clears the now-dangling selection to null.
    fireEvent.click(screen.getByText('remove-first'))
    expect(screen.getByTestId('sel-node')).toHaveTextContent('null')
    await flush()
  })

  it('seeds an EMPTY extraction set after the selected node was deleted (no phantom)', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('add-node'))
    fireEvent.click(screen.getByText('select-first'))
    fireEvent.click(screen.getByText('remove-first'))
    // The stale selection is gone, so entering extraction mode seeds the set from NOTHING.
    expect(screen.getByTestId('sel-node')).toHaveTextContent('null')

    fireEvent.click(screen.getByRole('button', { name: 'Extract component' }))
    // The banner reports zero selected, and the Canvas extraction set is empty (no phantom member).
    expect(screen.getByText(/Extraction mode — 0 nodes selected/)).toBeInTheDocument()
    expect(screen.getByTestId('ext-count')).toHaveTextContent('0')
    await flush()
  })
})
