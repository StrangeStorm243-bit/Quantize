// Canvas component-drop test (M12.3): a drop carrying the component MIME mints a `ComponentRefNode`.
//
// React Flow is mocked so we can (a) capture the `onInit` prop and hand the Canvas a fake instance with
// a deterministic `screenToFlowPosition`, and (b) fire a synthetic drop on the `.canvas` div whose
// `dataTransfer` returns the component payload. We assert the Canvas applies the `addComponentRefNode`
// reducer via `actions.replace`. NO network.
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeCatalogResponse } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import { newStrategyDocument } from '../document/store'
import type { StrategyDocumentActions } from '../document/store'
import { CatalogProvider } from '../catalog'
import { ComponentsProvider } from '../components-cache'
import { Canvas } from './Canvas'
import { COMPONENT_DRAG_MIME } from './Palette'

const catalog = catalogJson as unknown as NodeCatalogResponse

vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return {
    getNodeCatalog: () => Promise.resolve(json),
    loadComponentVersion: () => Promise.resolve(undefined),
    errorMessage: (e: unknown) => String(e),
  }
})

// Capture the props handed to <ReactFlow> (onInit, etc.). onDrop lives on the wrapping .canvas div.
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

describe('Canvas component drop', () => {
  it('mints a ComponentRefNode via replace(addComponentRefNode(...)) on a component-MIME drop', async () => {
    void catalog
    const actions = stubActions()
    const { container } = render(
      <CatalogProvider>
        <ComponentsProvider>
          <Canvas doc={newStrategyDocument('t')} actions={actions} />
        </ComponentsProvider>
      </CatalogProvider>,
    )
    // Wait for the catalog to resolve (ReactFlow mounts → box.props defined → past the loading div).
    await waitFor(() => expect(box.props).toBeDefined())
    // Hand the Canvas a fake RF instance so screenToFlowPosition resolves.
    act(() => {
      ;(box.props?.onInit as (i: unknown) => void)({
        screenToFlowPosition: (p: { x: number; y: number }) => p,
      })
    })

    const canvasDiv = container.querySelector('.canvas')
    expect(canvasDiv).not.toBeNull()
    fireEvent.drop(canvasDiv as Element, {
      clientX: 40,
      clientY: 55,
      dataTransfer: {
        getData: (mime: string) =>
          mime === COMPONENT_DRAG_MIME
            ? JSON.stringify({ component_id: 'c1', version: '2.0.0' })
            : '',
      },
    })

    expect(actions.replace).toHaveBeenCalledTimes(1)
    const nextDoc = (actions.replace as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as StrategyDocument
    const compNode = nextDoc.nodes.find((n) => 'ref' in n)
    expect(compNode).toBeDefined()
    expect(
      nextDoc.component_refs.some((r) => r.component_id === 'c1' && r.version === '2.0.0'),
    ).toBe(true)
  })
})
