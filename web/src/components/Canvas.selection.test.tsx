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
import { ComponentsProvider } from '../components-cache'
import { Canvas } from './Canvas'

const catalog = catalogJson as unknown as NodeCatalogResponse

// The CatalogProvider's fetch resolves to the committed golden (no network). The component cache is
// unused here (the doc has no component_refs), but the module still imports these — stub them.
vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return {
    getNodeCatalog: () => Promise.resolve(json),
    loadComponentVersion: () => Promise.resolve(undefined),
    errorMessage: (e: unknown) => String(e),
  }
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
  MiniMap: () => null,
  Panel: () => null,
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
    replaceIf: vi.fn().mockReturnValue(true),
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
        <ComponentsProvider>
          <Canvas doc={doc} actions={stubActions()} />
        </ComponentsProvider>
      </CatalogProvider>,
    )
    // Once the catalog resolves, the Canvas renders <ReactFlow> and the mock captures its props.
    await waitFor(() => expect(box.props).toBeDefined())
    expect(box.props?.selectionKeyCode).toBeNull()
    expect(box.props?.multiSelectionKeyCode).toBeNull()
  })
})
