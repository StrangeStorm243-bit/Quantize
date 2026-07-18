// Canvas edge-hover value-readout WIRING (M14.3, Task 4). The Canvas owns the hover/pin STATE (on the
// outer component so it survives the inner `<ReactFlow key={viewKey}>` remounts), gates it on the
// originating `trailKey` (Fact 9), and hands a render-gated address + pin flag to <FlowReadout> — which
// owns the dwell/fetch/lifetime (tested in FlowReadout.test.tsx). These tests pin the wiring only.
//
// RF-in-jsdom substrate (plan Task-4 amendment, 2026-07-17): React Flow v12 renders NO edge DOM under
// jsdom (nodes never `measured` without the d3-zoom pan-zoom `domNode` init), so — exactly like
// Canvas.focus.test.tsx — we MOCK '@xyflow/react': props are captured into `box`, `Panel` renders its
// children (so the recording FlowReadout stub runs), and the mock renders each `props.edges` entry as a
// `.react-flow__edge[data-id]` `<g>` MIRRORING RF's real EdgeWrapper contract (dist/esm/index.mjs:2897:
// `className "react-flow__edge"`, `data-id={id}`, `tabIndex={0}`, `role`). Hover/click/pane run through
// the captured props; the REAL capture-phase keyboard handler runs against those hand-built edge <g>s
// via genuine jsdom event dispatch. The real-RF `data-id` half is completed by the Task-8 live
// walkthrough (Tab+Enter / Tab+Space in both views). NO network.
import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Edge as FlowEdge } from '@xyflow/react'
import type { ComponentDefinition, StrategyDocument } from '@quantize/quantize-ir'
import { newStrategyDocument } from '../document/store'
import type { StrategyDocumentActions } from '../document/store'
import { componentCacheKey } from '../document/flow'
import type { ComponentTrailEntry } from '../document/flow'
import { CatalogProvider } from '../catalog'
import { Canvas, effectiveAddress } from './Canvas'
import type { FlowAddress, FlowProbe } from './FlowReadout'

const CID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

// The CatalogProvider fetch resolves to the committed golden (transform.rank / transform.trailing_return
// are real descriptors). getNodeValue is stubbed but never invoked here — the FlowReadout stub replaces
// the real fetching component, so a probe-present render provably fires zero requests through the Canvas.
const getNodeValueMock = vi.hoisted(() => vi.fn())
vi.mock('../api/client', async () => {
  const json = (await import('../../../tests/goldens/node_catalog.json')).default
  return {
    getNodeCatalog: () => Promise.resolve(json),
    loadComponentVersion: () => Promise.resolve(undefined),
    errorMessage: (e: unknown) => String(e),
    getNodeValue: getNodeValueMock,
  }
})

// A STABLE component-def cache (hoisted): a fresh Map each render would spin the re-seed effect. Tests
// set `cache.defs` entries for component-view projections.
const cache = vi.hoisted(() => ({ defs: new Map<string, ComponentDefinition>() }))
vi.mock('../components-cache', () => ({
  useComponentDefs: () => ({
    defs: cache.defs,
    get: () => undefined,
    ensure: vi.fn(),
    seed: vi.fn(),
    isLoading: () => false,
    errorOf: () => undefined,
  }),
}))

// Capture <ReactFlow>'s props into `box`; back node/edge state with real useState so the re-seed effect's
// projection flows into `props.edges`. Render each edge as a `.react-flow__edge[data-id]` <g> (the real
// EdgeWrapper DOM contract) INSIDE the Canvas wrapper so the capture keyboard handler has a faithful
// target, and render `props.children` so the bottom-center FlowReadout Panel mounts.
const box = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }))
vi.mock('@xyflow/react', async () => {
  const { useState } = await import('react')
  return {
    ReactFlow: (props: Record<string, unknown>) => {
      box.props = props
      const edges = (props.edges as Array<{ id: string }> | undefined) ?? []
      return (
        <div data-testid="rf-mock">
          {/* Mirrors @xyflow/react dist/esm/index.mjs:2897 (EdgeWrapper). */}
          <svg className="react-flow__edges">
            {edges.map((e) => (
              <g key={e.id} className="react-flow__edge" data-id={e.id} tabIndex={0} role="group" />
            ))}
          </svg>
          {props.children as ReactNode}
        </div>
      )
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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

// Record EVERY FlowReadout render's (address, pinned) — the render-recorded technique that catches a
// one-commit leak an ordinary post-action assertion (which flushes effects inside act) would miss.
const rec = vi.hoisted(() => ({
  renders: [] as Array<{ address: FlowAddress | null; pinned: boolean }>,
}))
vi.mock('./FlowReadout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./FlowReadout')>()
  return {
    ...actual,
    FlowReadout: (props: { address: FlowAddress | null; pinned: boolean }) => {
      rec.renders.push({ address: props.address, pinned: props.pinned })
      return <div data-testid="flow-readout" data-nodeid={props.address?.nodeId ?? '∅'} />
    },
  }
})

afterEach(() => {
  box.props = undefined
  cache.defs = new Map()
  rec.renders = []
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

function probe(overrides: Partial<FlowProbe> = {}): FlowProbe {
  return { runId: 'run-1', cursor: '2026-05-15', evaluated: true, scheduleKind: undefined, ...overrides }
}

// Strategy doc with one edge: trailing_return(out "values") → rank(in "values").
function edgeDoc(): StrategyDocument {
  return {
    ...newStrategyDocument('Probe'),
    nodes: [
      { id: 'ret', type_id: 'transform.trailing_return', type_version: '1.0.0', params: {}, ui: { position: { x: 0, y: 0 } } },
      { id: 'rank', type_id: 'transform.rank', type_version: '1.0.0', params: {}, ui: { position: { x: 200, y: 0 } } },
    ],
    edges: [{ from: ['ret', 'values'], to: ['rank', 'values'] }],
  }
}

// Strategy doc whose edge SOURCE is a ComponentRef instance 'mom' (exposed output "assets"): the address
// must tap `(mom, [], assets)` — instance id as nodeId, EMPTY component_path (Fact 4).
function componentSourceDoc(): StrategyDocument {
  return {
    ...newStrategyDocument('Probe'),
    component_refs: [{ id: 'r1', component_id: CID, version: '1.0.0' }],
    nodes: [
      { id: 'mom', type_id: 'component', ref: 'r1', params: {}, ui: { position: { x: 0, y: 0 } } } as never,
      { id: 'sink', type_id: 'transform.rank', type_version: '1.0.0', params: {}, ui: { position: { x: 200, y: 0 } } },
    ],
    edges: [{ from: ['mom', 'assets'], to: ['sink', 'values'] }],
  }
}

// A single-instance shell doc for entering a component view (the strategy graph is irrelevant — the view
// projects the tip DEFINITION's internal graph).
function shellDoc(): StrategyDocument {
  return {
    ...newStrategyDocument('Probe'),
    component_refs: [{ id: 'r1', component_id: CID, version: '1.0.0' }],
    nodes: [{ id: 'mom', type_id: 'component', ref: 'r1', params: {}, ui: { position: { x: 0, y: 0 } } } as never],
  }
}

// A graph-kind def with an INTERNAL edge inner_ret→inner_rank (component-view tap) and an exposed output.
function makeDef(): ComponentDefinition {
  return {
    schema_version: '0.1.0',
    component_id: CID,
    version: '1.0.0',
    name: 'Momentum',
    description: null,
    component_refs: [],
    implementation: {
      kind: 'graph',
      graph: {
        nodes: [
          { id: 'inner_ret', type_id: 'transform.trailing_return', type_version: '1.0.0', params: {} },
          { id: 'inner_rank', type_id: 'transform.rank', type_version: '1.0.0', params: {} },
        ],
        edges: [{ from: ['inner_ret', 'values'], to: ['inner_rank', 'values'] }],
      },
    },
    exposed_inputs: [],
    exposed_outputs: [{ name: 'assets', maps_to: ['inner_rank', 'values'], type: { kind: 'AssetSet' } }],
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

function trailEntry(instanceId: string): ComponentTrailEntry {
  return { componentId: CID, version: '1.0.0', instanceId }
}

// Wait until the re-seed effect has projected at least one edge into <ReactFlow>'s props.
async function edgesSeeded(): Promise<void> {
  await waitFor(() =>
    expect((box.props?.edges as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(0),
    { timeout: 5000 },
  )
}

function firstEdge(): FlowEdge {
  return (box.props!.edges as FlowEdge[])[0]
}

function callProp(name: string, ...args: unknown[]): void {
  act(() => {
    ;(box.props![name] as (...a: unknown[]) => void)(...args)
  })
}

function renderCanvas(ui: ReactNode, strict = false): ReturnType<typeof render> {
  const tree = <CatalogProvider>{ui}</CatalogProvider>
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

// ── effectiveAddress: the pure render-phase trail gate (Fact 9) ──────────────────────────────────────
describe('effectiveAddress', () => {
  const addr: FlowAddress = { nodeId: 'ret', componentPath: [], outputPort: 'values', sourceLabel: 'Trailing Return' }

  it('returns the address when the trail key matches', () => {
    expect(effectiveAddress({ address: addr, trailKey: 'mom' }, 'mom')).toBe(addr)
    expect(effectiveAddress({ address: addr, trailKey: '' }, '')).toBe(addr)
  })

  it('returns null when the trail key differs (a same-definition instance switch)', () => {
    expect(effectiveAddress({ address: addr, trailKey: 'momA' }, 'momB')).toBeNull()
  })

  it('returns null for a null entry', () => {
    expect(effectiveAddress(null, 'mom')).toBeNull()
  })
})

// ── Cycle 1: dormant without a probe ─────────────────────────────────────────────────────────────────
describe('Canvas edge-hover — dormant without a probe', () => {
  it('wires no edge handlers, renders no readout Panel, and never fetches', async () => {
    renderCanvas(<Canvas doc={edgeDoc()} actions={stubActions()} />)
    await edgesSeeded()
    // None of the edge-hover / pane handlers are passed to <ReactFlow>.
    expect(box.props!.onEdgeMouseEnter).toBeUndefined()
    expect(box.props!.onEdgeMouseLeave).toBeUndefined()
    expect(box.props!.onEdgeClick).toBeUndefined()
    expect(box.props!.onPaneClick).toBeUndefined()
    // No FlowReadout was rendered (no bottom-center Panel), and no value fetch fired.
    expect(rec.renders).toHaveLength(0)
    expect(getNodeValueMock).not.toHaveBeenCalled()
  })
})

// ── Cycle 4 (data-id first): the one library-DOM assumption, mirrored from source ────────────────────
describe('Canvas edge-hover — rendered edge DOM carries data-id', () => {
  it('renders `.react-flow__edge` with `data-id` equal to the edge id (EdgeWrapper contract)', async () => {
    const { container } = renderCanvas(<Canvas doc={edgeDoc()} actions={stubActions()} valueProbe={probe()} />)
    await edgesSeeded()
    const el = container.querySelector('.react-flow__edge')
    expect(el).not.toBeNull()
    expect(el?.getAttribute('data-id')).toBe(firstEdge().id)
  })
})

// ── Cycle 2 & 3: hover and mouse-pin ─────────────────────────────────────────────────────────────────
describe('Canvas edge-hover — hover and mouse pin', () => {
  it('hover hands the edge address to FlowReadout; leave clears it', async () => {
    renderCanvas(<Canvas doc={edgeDoc()} actions={stubActions()} valueProbe={probe()} />)
    await edgesSeeded()
    const edge = firstEdge()
    callProp('onEdgeMouseEnter', {}, edge)
    expect(rec.renders.at(-1)?.address).toEqual({
      nodeId: 'ret',
      componentPath: [],
      outputPort: 'values',
      sourceLabel: 'Trailing Return',
    })
    expect(rec.renders.at(-1)?.pinned).toBe(false)
    callProp('onEdgeMouseLeave')
    expect(rec.renders.at(-1)?.address).toBeNull()
  })

  it('a click pins the address so it survives mouse-leave', async () => {
    renderCanvas(<Canvas doc={edgeDoc()} actions={stubActions()} valueProbe={probe()} />)
    await edgesSeeded()
    const edge = firstEdge()
    callProp('onEdgeClick', {}, edge)
    expect(rec.renders.at(-1)?.address).toMatchObject({ nodeId: 'ret', outputPort: 'values' })
    expect(rec.renders.at(-1)?.pinned).toBe(true)
    // Leaving the edge does NOT clear a pinned readout.
    callProp('onEdgeMouseLeave')
    expect(rec.renders.at(-1)?.address).toMatchObject({ nodeId: 'ret', outputPort: 'values' })
    expect(rec.renders.at(-1)?.pinned).toBe(true)
  })
})

// ── Cycle 9: address derivation in both scopes ───────────────────────────────────────────────────────
describe('Canvas edge-hover — address scope', () => {
  it('a strategy edge from a ComponentRef instance taps (instanceId, [], exposedPort)', async () => {
    cache.defs.set(componentCacheKey(CID, '1.0.0'), makeDef())
    renderCanvas(<Canvas doc={componentSourceDoc()} actions={stubActions()} valueProbe={probe()} />)
    await edgesSeeded()
    callProp('onEdgeMouseEnter', {}, firstEdge())
    expect(rec.renders.at(-1)?.address).toMatchObject({
      nodeId: 'mom',
      componentPath: [],
      outputPort: 'assets',
    })
  })

  it('a component-view internal edge taps (innerId, trail component_path, port)', async () => {
    cache.defs.set(componentCacheKey(CID, '1.0.0'), makeDef())
    renderCanvas(
      <Canvas doc={shellDoc()} actions={stubActions()} valueProbe={probe()} componentTrail={[trailEntry('mom')]} />,
    )
    await edgesSeeded()
    callProp('onEdgeMouseEnter', {}, firstEdge())
    expect(rec.renders.at(-1)?.address).toMatchObject({
      nodeId: 'inner_ret',
      componentPath: ['mom'],
      outputPort: 'values',
    })
  })
})

// ── Cycle 8: the one-frame trail gate (same definition, instance switch) ─────────────────────────────
describe('Canvas edge-hover — trail gating (render-phase)', () => {
  it('a same-definition instance switch never shows the old instance address for one commit (StrictMode)', async () => {
    cache.defs.set(componentCacheKey(CID, '1.0.0'), makeDef())
    const actions = stubActions()
    const { rerender } = renderCanvas(
      <Canvas doc={shellDoc()} actions={actions} valueProbe={probe()} componentTrail={[trailEntry('momA')]} />,
      true,
    )
    await edgesSeeded()
    // Pin the internal edge while inside instance momA.
    callProp('onEdgeClick', {}, firstEdge())
    expect(rec.renders.at(-1)?.address).toMatchObject({ componentPath: ['momA'] })
    // Switch to a DIFFERENT instance of the SAME definition — viewKey is unchanged, so <ReactFlow> does
    // NOT remount. From here on, no render may carry momA's address.
    const fromIdx = rec.renders.length
    rerender(
      <StrictMode>
        <CatalogProvider>
          <Canvas doc={shellDoc()} actions={actions} valueProbe={probe()} componentTrail={[trailEntry('momB')]} />
        </CatalogProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(box.props).toBeDefined())
    const after = rec.renders.slice(fromIdx)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((r) => r.address === null || !r.address.componentPath.includes('momA'))).toBe(true)
  })
})

// ── Cycle 6 (first): read-only edges gain `focusable` only with a probe ──────────────────────────────
describe('Canvas edge-hover — read-only view edges', () => {
  it('component-view edges carry focusable:true with a probe, and untouched without one', async () => {
    cache.defs.set(componentCacheKey(CID, '1.0.0'), makeDef())
    const { rerender } = renderCanvas(
      <Canvas doc={shellDoc()} actions={stubActions()} valueProbe={probe()} componentTrail={[trailEntry('mom')]} />,
    )
    await edgesSeeded()
    expect((box.props!.edges as FlowEdge[]).every((e) => e.focusable === true)).toBe(true)
    // Nodes remain structurally read-only: NOT draggable/connectable/selectable, no mutation handlers.
    expect(box.props!.nodesDraggable).toBe(false)
    expect(box.props!.nodesConnectable).toBe(false)
    expect(box.props!.elementsSelectable).toBe(false)
    expect(box.props!.onNodesDelete).toBeUndefined()
    expect(box.props!.onEdgesDelete).toBeUndefined()
    expect(box.props!.onConnect).toBeUndefined()

    // Without a probe the focusable override is absent.
    rerender(
      <CatalogProvider>
        <Canvas doc={shellDoc()} actions={stubActions()} componentTrail={[trailEntry('mom')]} />
      </CatalogProvider>,
    )
    await waitFor(() =>
      expect((box.props!.edges as FlowEdge[]).some((e) => e.focusable === true)).toBe(false),
    )
  })
})

// ── Cycle 5 & 6: keyboard pin via the REAL capture handler, both keys, both views ────────────────────
describe.each([['Enter'], [' ']])('Canvas edge-hover — keyboard pin (key=%j)', (key) => {
  it('pins the focused edge in the strategy view', async () => {
    const { container } = renderCanvas(<Canvas doc={edgeDoc()} actions={stubActions()} valueProbe={probe()} />)
    await edgesSeeded()
    const el = container.querySelector('.react-flow__edge') as Element
    fireEvent.keyDown(el, { key })
    expect(rec.renders.at(-1)?.address).toMatchObject({ nodeId: 'ret', outputPort: 'values' })
    expect(rec.renders.at(-1)?.pinned).toBe(true)
  })

  it('pins the focused internal edge in a component view (trail component_path)', async () => {
    cache.defs.set(componentCacheKey(CID, '1.0.0'), makeDef())
    const { container } = renderCanvas(
      <Canvas doc={shellDoc()} actions={stubActions()} valueProbe={probe()} componentTrail={[trailEntry('mom')]} />,
    )
    await edgesSeeded()
    const el = container.querySelector('.react-flow__edge') as Element
    fireEvent.keyDown(el, { key })
    expect(rec.renders.at(-1)?.address).toMatchObject({ nodeId: 'inner_ret', componentPath: ['mom'] })
    expect(rec.renders.at(-1)?.pinned).toBe(true)
  })

  it('pins even a VALIDATION-HIGHLIGHTED edge (selection never consulted); highlight alone never pins', async () => {
    // highlightedEdgeIndex seeds `selected: true` on the edge — the pin path must ignore selection.
    const { container } = renderCanvas(
      <Canvas doc={edgeDoc()} actions={stubActions()} valueProbe={probe()} highlightedEdgeIndex={0} />,
    )
    await edgesSeeded()
    // The highlight alone (no key/click) has pinned nothing.
    expect(rec.renders.every((r) => r.pinned === false)).toBe(true)
    const el = container.querySelector('.react-flow__edge') as Element
    fireEvent.keyDown(el, { key })
    expect(rec.renders.at(-1)?.pinned).toBe(true)
  })

  it('an edge-hit key press stops propagation AND prevents default; a miss does neither and does not pin', async () => {
    const { container } = renderCanvas(<Canvas doc={edgeDoc()} actions={stubActions()} valueProbe={probe()} />)
    await edgesSeeded()
    const winSpy = vi.fn()
    window.addEventListener('keydown', winSpy)
    try {
      // HIT: the window bubble listener never receives the event (stopPropagation), and dispatchEvent
      // returns false (preventDefault was called).
      const el = container.querySelector('.react-flow__edge') as Element
      const notPreventedOnHit = fireEvent.keyDown(el, { key })
      expect(winSpy).not.toHaveBeenCalled()
      expect(notPreventedOnHit).toBe(false)

      // MISS: a key press with focus OUTSIDE any edge (the wrapper itself) — the handler does nothing:
      // the window listener receives it and we did not prevent default (RF's own behavior is mocked away
      // and never asserted against). And nothing was pinned by the miss.
      rec.renders = []
      const wrapper = container.querySelector('.canvas') as Element
      const notPreventedOnMiss = fireEvent.keyDown(wrapper, { key })
      expect(winSpy).toHaveBeenCalledTimes(1)
      expect(notPreventedOnMiss).toBe(true)
      expect(rec.renders.every((r) => r.pinned === false)).toBe(true)
    } finally {
      window.removeEventListener('keydown', winSpy)
    }
  })
})

// ── Cycle 7 & 8: unpin / clear paths ─────────────────────────────────────────────────────────────────
describe('Canvas edge-hover — unpin & clear paths', () => {
  it('a pane click releases a pin', async () => {
    renderCanvas(<Canvas doc={edgeDoc()} actions={stubActions()} valueProbe={probe()} />)
    await edgesSeeded()
    callProp('onEdgeClick', {}, firstEdge())
    expect(rec.renders.at(-1)?.pinned).toBe(true)
    callProp('onPaneClick')
    expect(rec.renders.at(-1)?.address).toBeNull()
    expect(rec.renders.at(-1)?.pinned).toBe(false)
  })

  it('losing the probe removes the readout entirely', async () => {
    const { rerender } = renderCanvas(<Canvas doc={edgeDoc()} actions={stubActions()} valueProbe={probe()} />)
    await edgesSeeded()
    callProp('onEdgeClick', {}, firstEdge())
    expect(rec.renders.at(-1)?.pinned).toBe(true)
    rec.renders = []
    rerender(
      <CatalogProvider>
        <Canvas doc={edgeDoc()} actions={stubActions()} />
      </CatalogProvider>,
    )
    // No FlowReadout renders once the probe is gone (Panel unmounted).
    await waitFor(() => expect(box.props!.onEdgeClick).toBeUndefined())
    expect(rec.renders).toHaveLength(0)
  })
})

// ── Cycle 9: Escape priority (editable guard → unpin → breadcrumb pop) ────────────────────────────────
describe('Canvas edge-hover — Escape priority', () => {
  it('a strategy-view pin releases on Escape', async () => {
    renderCanvas(<Canvas doc={edgeDoc()} actions={stubActions()} valueProbe={probe()} />)
    await edgesSeeded()
    callProp('onEdgeClick', {}, firstEdge())
    expect(rec.renders.at(-1)?.pinned).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(rec.renders.at(-1)?.address).toBeNull())
  })

  it('a pin is NOT released when Escape fires inside an editable control', async () => {
    const { container } = renderCanvas(
      <Canvas doc={edgeDoc()} actions={stubActions()} valueProbe={probe()} />,
    )
    await edgesSeeded()
    callProp('onEdgeClick', {}, firstEdge())
    // An input focused somewhere in the workspace: Escape there must NOT release the pin (guard first).
    const input = document.createElement('input')
    container.appendChild(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(rec.renders.at(-1)?.pinned).toBe(true)
    container.removeChild(input)
  })

  it('in a component view, first Escape unpins (trail intact), second Escape pops one level', async () => {
    cache.defs.set(componentCacheKey(CID, '1.0.0'), makeDef())
    const onNavigateToDepth = vi.fn()
    renderCanvas(
      <Canvas
        doc={shellDoc()}
        actions={stubActions()}
        valueProbe={probe()}
        componentTrail={[trailEntry('mom')]}
        onNavigateToDepth={onNavigateToDepth}
      />,
    )
    await edgesSeeded()
    callProp('onEdgeClick', {}, firstEdge())
    expect(rec.renders.at(-1)?.pinned).toBe(true)
    // First Escape: unpin only — the trail is NOT popped.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(rec.renders.at(-1)?.address).toBeNull())
    expect(onNavigateToDepth).not.toHaveBeenCalled()
    // Second Escape: now unpinned, the existing breadcrumb pop fires (keep the first trail.length-1).
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onNavigateToDepth).toHaveBeenCalledWith(0)
  })

  it('a component view with NO pin pops on the first Escape (existing behavior preserved)', async () => {
    cache.defs.set(componentCacheKey(CID, '1.0.0'), makeDef())
    const onNavigateToDepth = vi.fn()
    renderCanvas(
      <Canvas
        doc={shellDoc()}
        actions={stubActions()}
        valueProbe={probe()}
        componentTrail={[trailEntry('mom')]}
        onNavigateToDepth={onNavigateToDepth}
      />,
    )
    await edgesSeeded()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onNavigateToDepth).toHaveBeenCalledWith(0)
  })
})
