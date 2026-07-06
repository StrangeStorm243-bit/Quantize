// ComponentDrawer — read-only internal-graph view (M12.4, E11). The drawer renders a component's
// `implementation.graph` through the SAME `toFlow`, into a SECOND ReactFlow that mutates NOTHING: no
// dispatch handlers, and the non-interactive props set. We mock `@xyflow/react` (capturing the props
// handed to `<ReactFlow>`, like Canvas.selection.test) and the catalog + component cache. NO network.
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentDefinition } from '@quantize/quantize-ir'

const state = vi.hoisted(() => ({
  def: undefined as ComponentDefinition | undefined,
  ensure: vi.fn(),
}))
// Capture the props handed to <ReactFlow> so we can assert it is structurally read-only.
const box = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }))

vi.mock('../catalog', () => ({
  useCatalog: () => ({
    catalog: {
      node_types: [{ type_id: 'transform.rank', display_name: 'Rank', inputs: [], outputs: [] }],
    },
    loading: false,
    error: undefined,
  }),
}))
vi.mock('../components-cache', () => ({
  useComponentDefs: () => ({
    defs: new Map(),
    get: () => state.def,
    ensure: state.ensure,
    seed: vi.fn(),
    isLoading: () => false,
    errorOf: () => undefined,
  }),
}))
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    box.props = props
    const nodes = (props.nodes as { id: string; data: { displayName?: string; typeId: string } }[]) ?? []
    return (
      <div data-testid="rf">
        {nodes.map((n) => (
          <span key={n.id}>{n.data.displayName ?? n.data.typeId}</span>
        ))}
      </div>
    )
  },
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
}))

// eslint-disable-next-line import/first
import { ComponentDrawer } from './ComponentDrawer'

const CID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

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

afterEach(() => {
  box.props = undefined
  state.def = undefined
  vi.clearAllMocks()
})

describe('ComponentDrawer', () => {
  it('renders the internal graph read-only with node display names and a non-interactive ReactFlow', () => {
    state.def = makeDef()
    render(<ComponentDrawer componentId={CID} version="1.0.0" onClose={vi.fn()} />)

    // The internal node's display name (enriched from the catalog) appears.
    expect(screen.getByText('Rank')).toBeInTheDocument()
    // Non-interactive props.
    expect(box.props?.nodesDraggable).toBe(false)
    expect(box.props?.nodesConnectable).toBe(false)
    expect(box.props?.elementsSelectable).toBe(false)
    expect(box.props?.deleteKeyCode).toBeNull()
    // Structurally read-only: it can mutate NOTHING — no dispatch handlers are passed.
    expect(box.props?.onNodesChange).toBeUndefined()
    expect(box.props?.onEdgesChange).toBeUndefined()
    expect(box.props?.onConnect).toBeUndefined()
    expect(box.props?.onNodesDelete).toBeUndefined()
    expect(box.props?.onEdgesDelete).toBeUndefined()
    expect(box.props?.onNodeDragStop).toBeUndefined()
    expect(box.props?.onNodeClick).toBeUndefined()
    expect(box.props?.onDrop).toBeUndefined()
  })

  it('shows a not-viewable message for a non-graph implementation kind (the future-kinds seam)', () => {
    const base = makeDef()
    // Construct a hypothetical future implementation kind via a cast — the drawer must gate on it.
    state.def = { ...base, implementation: { kind: 'sandboxed' } } as unknown as ComponentDefinition
    render(<ComponentDrawer componentId={CID} version="1.0.0" onClose={vi.fn()} />)

    expect(screen.getByText(/not viewable/i)).toBeInTheDocument()
    // No graph is rendered → no ReactFlow instance.
    expect(box.props).toBeUndefined()
  })

  it('shows a loading state and ensures the definition on a cache miss', () => {
    state.def = undefined
    render(<ComponentDrawer componentId={CID} version="1.0.0" onClose={vi.fn()} />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    expect(state.ensure).toHaveBeenCalledWith(CID, '1.0.0')
  })

  it('calls onClose from the close button', () => {
    state.def = makeDef()
    const onClose = vi.fn()
    render(<ComponentDrawer componentId={CID} version="1.0.0" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
