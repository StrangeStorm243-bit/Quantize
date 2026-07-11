// Canvas selection model (M11.9 → M13.8). M11.9 nulled BOTH RF selection key codes because a doc-driven
// re-seed would collapse a native multi-selection mid-interaction (a later Delete then hits the wrong
// set). M13.8 RESTORES the marquee safely: `selectionKeyCode='Shift'` in the strategy view, and its
// result is mirrored — via `onSelectionEnd` reading the RF instance — into the App-OWNED extraction set,
// which survives every re-seed by construction (auto-entering extraction mode also nulls Delete). A
// read-only component view keeps the marquee OFF (`selectionKeyCode=null`, no `onSelectionEnd`).
// `multiSelectionKeyCode` stays null (Ctrl/Cmd-click multi-select remains out of scope). We mock
// `@xyflow/react` to capture the props the Canvas hands `<ReactFlow>` and the component cache to seed a
// definition for the component-view case. NO network.
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentDefinition } from '@quantize/quantize-ir'
import { addNode, newStrategyDocument } from '../document/store'
import type { StrategyDocumentActions } from '../document/store'
import { componentCacheKey } from '../document/flow'
import type { ComponentTrailEntry } from '../document/flow'
import { CatalogProvider } from '../catalog'
import { Canvas } from './Canvas'

// The CatalogProvider's fetch resolves to the committed golden (no network).
vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return {
    getNodeCatalog: () => Promise.resolve(json),
    loadComponentVersion: () => Promise.resolve(undefined),
    errorMessage: (e: unknown) => String(e),
  }
})

// A controllable component-definition cache (mirrors Canvas.navigation.test): `defs` is the raw map
// `toFlow` reads, `ensure` records the fetches the view requests.
const state = vi.hoisted(() => ({
  defs: new Map<string, ComponentDefinition>(),
  ensure: vi.fn(),
}))
vi.mock('../components-cache', () => ({
  useComponentDefs: () => ({
    defs: state.defs,
    get: (id: string, v: string) => state.defs.get(`${id}@${v}`),
    ensure: state.ensure,
    seed: vi.fn(),
    isLoading: () => false,
    errorOf: () => undefined,
  }),
}))

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
  state.defs = new Map()
  vi.clearAllMocks()
})

const CID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

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

// A minimal `graph`-kind definition so a one-level trail renders a component view.
function makeDef(componentId: string, name: string): ComponentDefinition {
  return {
    schema_version: '0.1.0',
    component_id: componentId,
    version: '1.0.0',
    name,
    description: null,
    component_refs: [],
    implementation: {
      kind: 'graph',
      graph: {
        nodes: [{ id: 'rk', type_id: 'transform.rank', type_version: '1.0.0', params: {} }],
        edges: [],
      },
    },
    exposed_inputs: [],
    exposed_outputs: [],
    exposed_params: [],
    provenance: {
      owner: '22222222-2222-2222-2222-222222222222',
      creator: '22222222-2222-2222-2222-222222222222',
      contributors: [],
      visibility: 'private',
      duplicable: false,
      created_at: '2026-07-06T00:00:00Z',
      forked_from: null,
    },
  }
}

function trailOf(...ids: string[]): ComponentTrailEntry[] {
  return ids.map((componentId) => ({ componentId, version: '1.0.0' }))
}

function renderCanvas(props: Partial<Parameters<typeof Canvas>[0]>): ReturnType<typeof render> {
  const doc = props.doc ?? newStrategyDocument('t')
  return render(
    <CatalogProvider>
      <Canvas doc={doc} actions={props.actions ?? stubActions()} {...props} />
    </CatalogProvider>,
  )
}

describe('Canvas selection key codes', () => {
  it('restores the marquee (selectionKeyCode=Shift) and keeps multi-select off in the strategy view', async () => {
    const doc = addNode(newStrategyDocument('t'), {
      typeId: 'transform.rank',
      typeVersion: '1.0.0',
      params: {},
      position: { x: 0, y: 0 },
    })
    renderCanvas({ doc })
    await waitFor(() => expect(box.props).toBeDefined())
    expect(box.props?.selectionKeyCode).toBe('Shift')
    expect(box.props?.multiSelectionKeyCode).toBeNull()
  })

  it('disables the marquee (selectionKeyCode=null, no onSelectionEnd) in a read-only component view', async () => {
    state.defs = new Map([[componentCacheKey(CID, '1.0.0'), makeDef(CID, 'Momentum')]])
    renderCanvas({ componentTrail: trailOf(CID) })
    await waitFor(() => expect(box.props).toBeDefined())
    expect(box.props?.selectionKeyCode).toBeNull()
    expect(box.props?.multiSelectionKeyCode).toBeNull()
    // A component view mirrors nothing into the extraction set — the marquee mechanism is absent.
    expect(box.props?.onSelectionEnd).toBeUndefined()
  })
})

describe('Canvas marquee mechanics', () => {
  it('reports the RF-selected node ids via onSelectionEnd (reading the instance)', async () => {
    const onMarqueeSelection = vi.fn()
    renderCanvas({ onMarqueeSelection })
    await waitFor(() => expect(box.props).toBeDefined())
    // Hand the Canvas an RF instance whose getNodes returns a mix of selected/unselected nodes; the
    // handler must read the CURRENT selection off the instance (onSelectionEnd gets only a mouse event).
    act(() => {
      ;(box.props?.onInit as (i: unknown) => void)({
        getNodes: () => [
          { id: 'a', selected: true },
          { id: 'b', selected: true },
          { id: 'c', selected: false },
        ],
      })
    })
    // After onInit sets rfInstance, the fresh onSelectionEnd closes over the instance.
    act(() => {
      ;(box.props?.onSelectionEnd as () => void)()
    })
    expect(onMarqueeSelection).toHaveBeenCalledWith(['a', 'b'])
  })

  it('does not report an empty marquee (no node selected)', async () => {
    const onMarqueeSelection = vi.fn()
    renderCanvas({ onMarqueeSelection })
    await waitFor(() => expect(box.props).toBeDefined())
    act(() => {
      ;(box.props?.onInit as (i: unknown) => void)({
        getNodes: () => [{ id: 'a', selected: false }],
      })
    })
    act(() => {
      ;(box.props?.onSelectionEnd as () => void)()
    })
    expect(onMarqueeSelection).not.toHaveBeenCalled()
  })
})
