// Canvas component-view mode (M13.8): a non-empty `componentTrail` projects the trail tip's
// `ComponentDefinition.implementation.graph` through the SAME `toFlow` and renders it STRUCTURALLY
// read-only (no dispatch handlers passed), with the Breadcrumb in the StageStrip's slot. This is the
// modal ComponentDrawer's guarantee, ported into the one canvas. We mock `@xyflow/react` to capture the
// props handed `<ReactFlow>` (like Canvas.extraction.test) and the component cache (like the deleted
// ComponentDrawer.test) so we can seed/omit definitions. Real catalog via CatalogProvider. NO network.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentDefinition, StrategyDocument } from '@quantize/quantize-ir'
import { addComponentRefNode, newStrategyDocument } from '../document/store'
import type { StrategyDocumentActions } from '../document/store'
import { componentCacheKey } from '../document/flow'
import type { ComponentTrailEntry } from '../document/flow'
import { CatalogProvider } from '../catalog'
import { Canvas } from './Canvas'
import { COMPONENT_DRAG_MIME } from './Palette'

// The real catalog fetch resolves to the committed golden (transform.rank → "Rank"). No component
// fetches happen: the cache is mocked below, so `loadComponentVersion` is never exercised here.
vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return {
    getNodeCatalog: () => Promise.resolve(json),
    loadComponentVersion: () => Promise.resolve(undefined),
    errorMessage: (e: unknown) => String(e),
  }
})

// A controllable component-definition cache: `defs` is the raw `id@version → def` map `toFlow` reads,
// and `ensure` records the fetches the view requests (per trail level + nested refs).
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

// Capture the props handed to <ReactFlow>. The mock renders each node as a button so display names are
// assertable and `onNodeDoubleClick` is fireable; `useNodesState`/`useEdgesState` are backed by real
// `useState` so the Canvas re-seed effect's projected nodes flow back through `props.nodes`.
const box = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }))
vi.mock('@xyflow/react', async () => {
  const { useState } = await import('react')
  return {
    ReactFlow: (props: Record<string, unknown>) => {
      box.props = props
      const nodes =
        (props.nodes as { id: string; data: { displayName?: string; typeId: string } }[]) ?? []
      const onDbl = props.onNodeDoubleClick as ((e: unknown, n: unknown) => void) | undefined
      const onClk = props.onNodeClick as ((e: unknown, n: unknown) => void) | undefined
      return (
        <div data-testid="rf">
          {/* A stand-in for RF's own pane element: a pane double-click is what the Canvas quick-add
              affordance keys on (`event.target.classList.contains('react-flow__pane')`). */}
          <div className="react-flow__pane" data-testid="pane" />
          {nodes.map((n) => (
            <button
              key={n.id}
              data-testid={`node-${n.id}`}
              onClick={() => onClk?.({}, n)}
              onDoubleClick={() => onDbl?.({}, n)}
            >
              {n.data.displayName ?? n.data.typeId}
            </button>
          ))}
        </div>
      )
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

const CID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SUB_CID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

// A minimal `graph`-kind definition with one internal registered node (its display name is enriched
// from the golden catalog so it is assertable through the mocked ReactFlow).
function makeDef(
  componentId: string,
  name: string,
  nodeId: string,
): ComponentDefinition {
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
        nodes: [{ id: nodeId, type_id: 'transform.rank', type_version: '1.0.0', params: {} }],
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

// A parent `graph` definition whose body holds a nested ComponentRefNode pointing at SUB_CID. The
// nested ref resolves against the DEFINITION's own `component_refs`, not the inner graph.
function makeParentWithNestedRef(): ComponentDefinition {
  return {
    ...makeDef(CID, 'Momentum', 'unused'),
    component_refs: [{ id: 'subref', component_id: SUB_CID, version: '1.0.0' }],
    implementation: {
      kind: 'graph',
      graph: {
        nodes: [{ id: 'sub', type_id: 'component', ref: 'subref', params: {} }],
        edges: [],
      },
    },
  }
}

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

function seedDefs(...defs: ComponentDefinition[]): void {
  state.defs = new Map(defs.map((d) => [componentCacheKey(d.component_id, d.version), d]))
}

function trailOf(...ids: string[]): ComponentTrailEntry[] {
  return ids.map((componentId) => ({ componentId, version: '1.0.0' }))
}

function renderCanvas(props: Partial<Parameters<typeof Canvas>[0]>): ReturnType<typeof render> {
  const doc = (props.doc as StrategyDocument | undefined) ?? newStrategyDocument('My Strategy')
  return render(
    <CatalogProvider>
      <Canvas doc={doc} actions={props.actions ?? stubActions()} {...props} />
    </CatalogProvider>,
  )
}

afterEach(() => {
  box.props = undefined
  state.defs = new Map()
  vi.clearAllMocks()
})

describe('Canvas component-view mode', () => {
  // 1
  it('projects the tip definition graph and renders the breadcrumb for a one-level trail', async () => {
    seedDefs(makeDef(CID, 'Momentum', 'rk'))
    renderCanvas({ componentTrail: trailOf(CID) })

    // The internal node's catalog-enriched display name appears (projected through toFlow).
    expect(await screen.findByText('Rank')).toBeInTheDocument()
    // Breadcrumb: strategy root crumb + the tip crumb `Name v1.0.0`.
    expect(screen.getByRole('button', { name: 'My Strategy' })).toBeInTheDocument()
    expect(screen.getByText('Momentum v1.0.0')).toBeInTheDocument()
  })

  // 2
  it('renders the DEEPEST definition for a nested trail with a crumb per level', async () => {
    seedDefs(makeDef(CID, 'Momentum', 'rk'), makeDef(SUB_CID, 'SubComponent', 'rk2'))
    renderCanvas({ componentTrail: trailOf(CID, SUB_CID) })

    // The deepest (tip) definition's node is what renders.
    expect(await screen.findByTestId('node-rk2')).toBeInTheDocument()
    expect(screen.queryByTestId('node-rk')).not.toBeInTheDocument()
    // Two trail crumbs, deepest last.
    expect(screen.getByText('Momentum v1.0.0')).toBeInTheDocument()
    expect(screen.getByText('SubComponent v1.0.0')).toBeInTheDocument()
  })

  // 3
  it('is structurally read-only: no dispatch handlers and the non-interactive props set', async () => {
    seedDefs(makeDef(CID, 'Momentum', 'rk'))
    renderCanvas({ componentTrail: trailOf(CID) })
    await waitFor(() => expect(box.props).toBeDefined())

    expect(box.props?.nodesDraggable).toBe(false)
    expect(box.props?.nodesConnectable).toBe(false)
    expect(box.props?.elementsSelectable).toBe(false)
    expect(box.props?.deleteKeyCode).toBeNull()
    // The mutation dispatchers are ABSENT (not no-ops) — the view can change nothing.
    expect(box.props?.onConnect).toBeUndefined()
    expect(box.props?.onNodesDelete).toBeUndefined()
    expect(box.props?.onEdgesDelete).toBeUndefined()
    expect(box.props?.onNodeDragStop).toBeUndefined()
  })

  // 4a
  it('shows a loading state and ensures every trail level when the tip is not cached', async () => {
    state.defs = new Map()
    renderCanvas({ componentTrail: trailOf(CID, SUB_CID) })
    expect(await screen.findByText(/loading component/i)).toBeInTheDocument()
    expect(state.ensure).toHaveBeenCalledWith(CID, '1.0.0')
    expect(state.ensure).toHaveBeenCalledWith(SUB_CID, '1.0.0')
  })

  // 4b
  it('ensures the tip definition nested refs once the tip has loaded', async () => {
    seedDefs(makeParentWithNestedRef())
    renderCanvas({ componentTrail: trailOf(CID) })
    await waitFor(() => expect(state.ensure).toHaveBeenCalledWith(SUB_CID, '1.0.0'))
  })

  // 5
  it('shows the not-viewable notice for a non-graph implementation kind (the preserved gate)', async () => {
    const nonGraph = {
      ...makeDef(CID, 'Momentum', 'rk'),
      implementation: { kind: 'sandboxed' },
    } as unknown as ComponentDefinition
    seedDefs(nonGraph)
    renderCanvas({ componentTrail: trailOf(CID) })

    expect(await screen.findByText(/not viewable/i)).toBeInTheDocument()
    // No internal graph → no ReactFlow instance rendered.
    expect(box.props).toBeUndefined()
  })

  // 6
  it('routes crumb clicks and Escape through onNavigateToDepth (component view only)', async () => {
    seedDefs(makeDef(CID, 'Momentum', 'rk'), makeDef(SUB_CID, 'SubComponent', 'rk2'))
    const onNavigateToDepth = vi.fn()
    const { unmount } = renderCanvas({
      componentTrail: trailOf(CID, SUB_CID),
      onNavigateToDepth,
    })
    await screen.findByText('SubComponent v1.0.0')

    // Root crumb → depth 0.
    fireEvent.click(screen.getByRole('button', { name: 'My Strategy' }))
    expect(onNavigateToDepth).toHaveBeenCalledWith(0)
    // Escape pops one level → depth trail.length - 1 = 1.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onNavigateToDepth).toHaveBeenCalledWith(1)
    unmount()

    // In the strategy view (no trail) Escape does nothing — the window listener is not installed.
    onNavigateToDepth.mockClear()
    renderCanvas({ onNavigateToDepth })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onNavigateToDepth).not.toHaveBeenCalled()
  })

  // 7
  it('replaces the StageStrip with the Breadcrumb and makes drop/quick-add inert', async () => {
    seedDefs(makeDef(CID, 'Momentum', 'rk'))
    const actions = stubActions()
    const { container } = renderCanvas({ componentTrail: trailOf(CID), actions })
    await screen.findByText('Rank')

    // The Breadcrumb occupies the strip slot; the StageStrip's segments are gone.
    expect(screen.getByRole('navigation', { name: 'component breadcrumb' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Rank & Select/i })).not.toBeInTheDocument()

    // Hand the Canvas a WORKING RF instance so `onDrop` would proceed if the read-only guard were
    // absent — then fire a REAL component-drag payload. The guard (not a null instance) is what makes
    // the drop inert: no ComponentRefNode is minted.
    act(() => {
      ;(box.props?.onInit as (i: unknown) => void)({
        screenToFlowPosition: (p: { x: number; y: number }) => p,
      })
    })
    const canvas = container.querySelector('.canvas') as HTMLElement
    fireEvent.drop(canvas, {
      clientX: 20,
      clientY: 20,
      dataTransfer: {
        getData: (mime: string) =>
          mime === COMPONENT_DRAG_MIME ? JSON.stringify({ component_id: CID, version: '1.0.0' }) : '',
      },
    })
    expect(actions.replace).not.toHaveBeenCalled()

    // A pane double-click does not open the quick-add menu in a read-only view.
    fireEvent.doubleClick(screen.getByTestId('pane'))
    expect(screen.queryByLabelText('quick add search')).not.toBeInTheDocument()
  })

  // 7b — the same pane double-click DOES open quick-add in the strategy view, so the assertion above
  // reflects the read-only guard, not a broken affordance.
  it('opens the quick-add menu on a pane double-click in the strategy view', async () => {
    renderCanvas({})
    await screen.findByRole('button', { name: /Rank & Select/i })
    fireEvent.doubleClick(screen.getByTestId('pane'))
    expect(screen.getByLabelText('quick add search')).toBeInTheDocument()
  })

  // 8
  it('double-clicks a ComponentRef node → onEnterComponent with its pinned ref (strategy + component view; not in extraction)', async () => {
    // Strategy view: the doc holds a ComponentRefNode pinned to CID.
    let doc = newStrategyDocument('My Strategy')
    doc = addComponentRefNode(doc, { componentId: CID, version: '1.0.0', position: { x: 0, y: 0 } })
    const compNodeId = doc.nodes[doc.nodes.length - 1].id
    const onEnterComponent = vi.fn()
    const { unmount } = renderCanvas({ doc, onEnterComponent })
    fireEvent.doubleClick(await screen.findByTestId(`node-${compNodeId}`))
    expect(onEnterComponent).toHaveBeenCalledWith({ componentId: CID, version: '1.0.0' })
    unmount()

    // Extraction mode: entering is disabled.
    onEnterComponent.mockClear()
    const ex = renderCanvas({ doc, onEnterComponent, extractionMode: true })
    fireEvent.doubleClick(await screen.findByTestId(`node-${compNodeId}`))
    expect(onEnterComponent).not.toHaveBeenCalled()
    ex.unmount()

    // Component view: a nested ref resolves against the CURRENT tip definition's `component_refs`.
    onEnterComponent.mockClear()
    seedDefs(makeParentWithNestedRef())
    renderCanvas({ componentTrail: trailOf(CID), onEnterComponent })
    fireEvent.doubleClick(await screen.findByTestId('node-sub'))
    expect(onEnterComponent).toHaveBeenCalledWith({ componentId: SUB_CID, version: '1.0.0' })
  })

  // 9
  it('marks componentSelectedNodeId selected in the component-view projection', async () => {
    seedDefs(makeDef(CID, 'Momentum', 'rk'))
    renderCanvas({ componentTrail: trailOf(CID), componentSelectedNodeId: 'rk' })
    await waitFor(() => {
      const nodes = (box.props?.nodes as { id: string; selected?: boolean }[] | undefined) ?? []
      expect(nodes.find((n) => n.id === 'rk')?.selected).toBe(true)
    })
  })

  // 9b (M13.9 O3): a single click on an inner node routes through onComponentNodeClick so the App can
  // select it for the read-only Inspector — WITHOUT enabling any editing affordance. Double-click still
  // enters (tested in #8); the two are independent.
  it('routes a single inner-node click through onComponentNodeClick in the component view', async () => {
    seedDefs(makeDef(CID, 'Momentum', 'rk'))
    const onComponentNodeClick = vi.fn()
    renderCanvas({ componentTrail: trailOf(CID), onComponentNodeClick })
    fireEvent.click(await screen.findByTestId('node-rk'))
    expect(onComponentNodeClick).toHaveBeenCalledWith('rk')
  })

  // 9c: in the STRATEGY view a single click does NOT route to onComponentNodeClick — it is the
  // strategy-editing single-select (onNodeClick), so the component-inspect hook stays component-only.
  it('does not call onComponentNodeClick for a single click in the strategy view', async () => {
    const onComponentNodeClick = vi.fn()
    const onNodeClick = vi.fn()
    let doc = newStrategyDocument('My Strategy')
    doc = addComponentRefNode(doc, { componentId: CID, version: '1.0.0', position: { x: 0, y: 0 } })
    const compNodeId = doc.nodes[doc.nodes.length - 1].id
    renderCanvas({ doc, onComponentNodeClick, onNodeClick })
    fireEvent.click(await screen.findByTestId(`node-${compNodeId}`))
    expect(onComponentNodeClick).not.toHaveBeenCalled()
    expect(onNodeClick).toHaveBeenCalledWith(compNodeId)
  })

  // 10 (empty trail = normal editing view) is covered by the existing Canvas.*.test suites, which
  // render without `componentTrail` and must stay green untouched.
  it('renders the normal StageStrip editing view when the trail is empty', async () => {
    renderCanvas({})
    // The StageStrip (not the Breadcrumb) is present in the strip slot.
    expect(await screen.findByRole('button', { name: /Rank & Select/i })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'component breadcrumb' })).not.toBeInTheDocument()
  })

  // C1 regression: the interactivity flags are EXPLICIT booleans that toggle across a view transition.
  // If they were merely omitted in the strategy view (the original bug), RF v12's store — which skips
  // `undefined` updates — would latch the component view's `false` and never restore draggability on
  // exit. The per-view `key` remount makes the explicit value take effect; here we assert the value.
  it('passes explicit interactivity booleans that toggle when entering and leaving a component view', async () => {
    seedDefs(makeDef(CID, 'Momentum', 'rk'))
    const doc = newStrategyDocument('My Strategy')
    const actions = stubActions()
    const props = { doc, actions }
    const { rerender } = render(
      <CatalogProvider>
        <Canvas {...props} />
      </CatalogProvider>,
    )
    // Strategy editor: draggable/connectable/selectable.
    await waitFor(() => expect(box.props?.nodesDraggable).toBe(true))
    expect(box.props?.nodesConnectable).toBe(true)
    expect(box.props?.elementsSelectable).toBe(true)

    // Enter a component view: explicitly non-interactive.
    rerender(
      <CatalogProvider>
        <Canvas {...props} componentTrail={trailOf(CID)} />
      </CatalogProvider>,
    )
    await waitFor(() => expect(box.props?.nodesDraggable).toBe(false))
    expect(box.props?.nodesConnectable).toBe(false)
    expect(box.props?.elementsSelectable).toBe(false)

    // Exit back to the editor: interactivity restored (would stay false if the prop were omitted/latched).
    rerender(
      <CatalogProvider>
        <Canvas {...props} componentTrail={[]} />
      </CatalogProvider>,
    )
    await waitFor(() => expect(box.props?.nodesDraggable).toBe(true))
  })
})
