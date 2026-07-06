// Canvas extraction-mode projection (M12.5, E2): the App-owned `selectedNodeIds` set marks EVERY member
// node RF-`selected` (not just one), and `deleteKeyCode` is nulled while the mode is active so a stray
// Backspace can never delete the highlighted subgraph. We mock `@xyflow/react` to capture the props the
// Canvas hands `<ReactFlow>` and assert the projection + the delete-key gate. NO network.
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { addNode, newStrategyDocument } from '../document/store'
import type { StrategyDocumentActions } from '../document/store'
import { CatalogProvider } from '../catalog'
import { ComponentsProvider } from '../components-cache'
import { Canvas } from './Canvas'

vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return {
    getNodeCatalog: () => Promise.resolve(json),
    loadComponentVersion: () => Promise.resolve(undefined),
    errorMessage: (e: unknown) => String(e),
  }
})

// Capture the props the Canvas passes to <ReactFlow>, plus the node array it hands to `setRfNodes` (the
// projection). The mocked `useNodesState` setter is a no-op that never re-renders, so `<ReactFlow nodes>`
// stays at the empty seed — we instead record the argument Canvas passes to the setter in its re-seed
// effect, which is exactly the projected `{selected}` node list under test.
const box = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
  nodes: undefined as { id: string; selected: boolean }[] | undefined,
}))
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    box.props = props
    return null
  },
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  useNodesState: () => [
    [],
    (v: unknown) => {
      box.nodes = v as { id: string; selected: boolean }[]
    },
    () => {},
  ],
  useEdgesState: () => [[], () => {}, () => {}],
}))

afterEach(() => {
  box.props = undefined
  box.nodes = undefined
  vi.clearAllMocks()
})

function stubActions(): StrategyDocumentActions {
  return {
    addNode: vi.fn(),
    removeNode: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    setParams: vi.fn(),
    setNodeUi: vi.fn(),
    replace: vi.fn(),
  }
}

// A two-node document (ids minted by addNode → read back).
function buildTwoNodeDoc(): { doc: StrategyDocument; aId: string; bId: string } {
  let doc = newStrategyDocument('t')
  doc = addNode(doc, { typeId: 'transform.rank', typeVersion: '1.0.0', params: {}, position: { x: 0, y: 0 } })
  doc = addNode(doc, {
    typeId: 'transform.trailing_return',
    typeVersion: '1.0.0',
    params: {},
    position: { x: 200, y: 0 },
  })
  const [a, b] = doc.nodes
  return { doc, aId: a.id, bId: b.id }
}

describe('Canvas extraction projection', () => {
  it('marks every node in `selectedNodeIds` as RF-selected', async () => {
    const { doc, aId, bId } = buildTwoNodeDoc()
    render(
      <CatalogProvider>
        <ComponentsProvider>
          <Canvas
            doc={doc}
            actions={stubActions()}
            extractionMode
            selectedNodeIds={new Set([aId, bId])}
          />
        </ComponentsProvider>
      </CatalogProvider>,
    )
    await waitFor(() => expect(box.nodes).toBeDefined())
    const nodes = box.nodes as { id: string; selected: boolean }[]
    expect(nodes.find((n) => n.id === aId)?.selected).toBe(true)
    expect(nodes.find((n) => n.id === bId)?.selected).toBe(true)
  })

  it('selects only the set member, not the single `selectedNodeId`, when a set is present', async () => {
    const { doc, aId, bId } = buildTwoNodeDoc()
    render(
      <CatalogProvider>
        <ComponentsProvider>
          <Canvas
            doc={doc}
            actions={stubActions()}
            extractionMode
            selectedNodeId={bId}
            selectedNodeIds={new Set([aId])}
          />
        </ComponentsProvider>
      </CatalogProvider>,
    )
    await waitFor(() => expect(box.nodes).toBeDefined())
    const nodes = box.nodes as { id: string; selected: boolean }[]
    expect(nodes.find((n) => n.id === aId)?.selected).toBe(true)
    expect(nodes.find((n) => n.id === bId)?.selected).toBe(false)
  })

  it('nulls `deleteKeyCode` while extraction mode is active', async () => {
    const { doc } = buildTwoNodeDoc()
    render(
      <CatalogProvider>
        <ComponentsProvider>
          <Canvas doc={doc} actions={stubActions()} extractionMode selectedNodeIds={new Set()} />
        </ComponentsProvider>
      </CatalogProvider>,
    )
    await waitFor(() => expect(box.props).toBeDefined())
    expect(box.props?.deleteKeyCode).toBeNull()
  })

  it('leaves `deleteKeyCode` at RF default (undefined) when extraction mode is off', async () => {
    const { doc } = buildTwoNodeDoc()
    render(
      <CatalogProvider>
        <ComponentsProvider>
          <Canvas doc={doc} actions={stubActions()} />
        </ComponentsProvider>
      </CatalogProvider>,
    )
    await waitFor(() => expect(box.props).toBeDefined())
    expect(box.props?.deleteKeyCode).toBeUndefined()
  })
})
