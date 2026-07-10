// Canvas focus request is ONE-SHOT (M13.7 trace→canvas, hardened in M13.8). A focus request centers its
// node exactly once per nonce. The focus effect must depend on rfNodes/rfInstance so it can apply once
// the instance is ready (onInit) and once the target is present in the projection — but those same
// dependencies mean an UNRELATED re-seed (a plain node selection, a validity overlay, a stage highlight)
// re-runs it. Without one-shot consumption that replays the last fitView and yanks the viewport back to
// the stale focused node (the Codex P2 finding). These tests pin: applied once, NOT replayed on an
// unrelated re-seed, and re-applied when a genuinely new request (bumped nonce) arrives.
//
// We mock @xyflow/react to capture the props handed <ReactFlow> and to hand the Canvas a fake instance
// whose `fitView` we spy; node/edge state is real useState so the Canvas re-seed effect's projected
// nodes flow into rfNodes (and the focus guard can match the target). NO network.
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { newStrategyDocument } from '../document/store'
import type { StrategyDocumentActions } from '../document/store'
import { CatalogProvider } from '../catalog'
import { Canvas } from './Canvas'

// The CatalogProvider's fetch resolves to the committed golden (transform.rank is a real descriptor).
vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return {
    getNodeCatalog: () => Promise.resolve(json),
    loadComponentVersion: () => Promise.resolve(undefined),
    errorMessage: (e: unknown) => String(e),
  }
})

// The strategy view needs no component definitions here — an empty cache is enough. The `defs` map must
// be a STABLE reference across renders (hoisted): a fresh Map each call would change `project`'s identity
// every render and spin the re-seed effect into an infinite loop.
const cache = vi.hoisted(() => ({ defs: new Map(), ensure: vi.fn() }))
vi.mock('../components-cache', () => ({
  useComponentDefs: () => ({
    defs: cache.defs,
    get: () => undefined,
    ensure: cache.ensure,
    seed: vi.fn(),
    isLoading: () => false,
    errorOf: () => undefined,
  }),
}))

// Capture the props handed to <ReactFlow>; back node/edge state with real useState so the re-seed
// effect's projected nodes flow into props.nodes (mirroring rfNodes, which the focus guard reads).
const box = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }))
vi.mock('@xyflow/react', async () => {
  const { useState } = await import('react')
  return {
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
    useNodesState: (init: unknown) => {
      const [s, setS] = useState(init)
      return [s, setS, () => {}]
    },
    useEdgesState: (init: unknown) => {
      const [s, setS] = useState(init)
      return [s, setS, () => {}]
    },
  }
})

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

// A two-node strategy document with explicit ids so a focus request can target 'sel'.
function twoNodeDoc(): StrategyDocument {
  return {
    ...newStrategyDocument('Focus'),
    nodes: [
      { id: 'n1', type_id: 'transform.rank', type_version: '1.0.0', params: {}, ui: { position: { x: 0, y: 0 } } },
      { id: 'sel', type_id: 'transform.rank', type_version: '1.0.0', params: {}, ui: { position: { x: 200, y: 0 } } },
    ],
  }
}

async function nodesSeeded(): Promise<void> {
  await waitFor(() =>
    expect((box.props?.nodes as { id: string }[] | undefined)?.some((n) => n.id === 'sel')).toBe(true),
  )
}

describe('Canvas focus request (one-shot)', () => {
  it('centers the focused node once and does NOT replay it on an unrelated re-seed', async () => {
    const fitView = vi.fn()
    const doc = twoNodeDoc()
    const actions = stubActions()
    const { rerender } = render(
      <CatalogProvider>
        <Canvas doc={doc} actions={actions} selectedNodeId={null} focusRequest={{ nodeId: 'sel', nonce: 1 }} />
      </CatalogProvider>,
    )
    await nodesSeeded()
    // onInit supplies the RF instance → the focus effect applies fitView on 'sel' exactly once.
    act(() => {
      ;(box.props?.onInit as (i: unknown) => void)({ fitView, getNodes: () => [] })
    })
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'sel' }] }))

    // Selecting another node re-seeds rfNodes but leaves focusRequest unchanged — the viewport must NOT
    // jump back to the stale focused node (this is the Codex P2 scenario).
    rerender(
      <CatalogProvider>
        <Canvas doc={doc} actions={actions} selectedNodeId={'n1'} focusRequest={{ nodeId: 'sel', nonce: 1 }} />
      </CatalogProvider>,
    )
    expect(fitView).toHaveBeenCalledTimes(1)
  })

  it('re-centers when a new focus request (bumped nonce) arrives', async () => {
    const fitView = vi.fn()
    const doc = twoNodeDoc()
    const actions = stubActions()
    const { rerender } = render(
      <CatalogProvider>
        <Canvas doc={doc} actions={actions} selectedNodeId={null} focusRequest={{ nodeId: 'sel', nonce: 1 }} />
      </CatalogProvider>,
    )
    await nodesSeeded()
    act(() => {
      ;(box.props?.onInit as (i: unknown) => void)({ fitView, getNodes: () => [] })
    })
    expect(fitView).toHaveBeenCalledTimes(1)
    // Re-clicking the same trace row bumps the nonce → a genuinely new request re-centers.
    rerender(
      <CatalogProvider>
        <Canvas doc={doc} actions={actions} selectedNodeId={null} focusRequest={{ nodeId: 'sel', nonce: 2 }} />
      </CatalogProvider>,
    )
    expect(fitView).toHaveBeenCalledTimes(2)
  })
})
