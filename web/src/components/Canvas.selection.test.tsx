// Canvas multi-select (M11.9, F6): the editor's selection model is SINGLE-element, and the doc-driven
// re-seed would collapse RF-native multi-selection mid-interaction (a later Delete then hits the wrong
// set). So the Canvas disables RF multi-select by nulling its key codes. We mock `@xyflow/react` to
// capture the props the Canvas passes to `<ReactFlow>` and assert both are null. NO network.
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeCatalogResponse } from '@quantize/quantize-api'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import { addNode, newStrategyDocument } from '../document/store'
import type { StrategyDocumentActions } from '../document/store'
import { CatalogProvider } from '../catalog'
import { Canvas } from './Canvas'

const catalog = catalogJson as unknown as NodeCatalogResponse

// The CatalogProvider's fetch resolves to the committed golden (no network).
vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return { getNodeCatalog: () => Promise.resolve(json) }
})

// Capture the props handed to <ReactFlow>. `vi.hoisted` makes the box available to the hoisted factory.
const box = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    box.props = props
    return null
  },
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  useNodesState: (init: unknown) => [init, () => {}, () => {}],
  useEdgesState: (init: unknown) => [init, () => {}, () => {}],
}))

afterEach(() => {
  box.props = undefined
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

describe('Canvas multi-select', () => {
  it('renders ReactFlow with selection + multi-selection key codes disabled (null)', async () => {
    void catalog // keep the import meaningful even though the mock returns the golden directly
    const doc = addNode(newStrategyDocument('t'), {
      typeId: 'transform.rank',
      typeVersion: '1.0.0',
      params: {},
      position: { x: 0, y: 0 },
    })
    render(
      <CatalogProvider>
        <Canvas doc={doc} actions={stubActions()} />
      </CatalogProvider>,
    )
    // Once the catalog resolves, the Canvas renders <ReactFlow> and the mock captures its props.
    await waitFor(() => expect(box.props).toBeDefined())
    expect(box.props?.selectionKeyCode).toBeNull()
    expect(box.props?.multiSelectionKeyCode).toBeNull()
  })
})
