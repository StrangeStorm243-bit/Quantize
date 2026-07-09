// The React Flow canvas (M11.4): a live, editable view over the canonical document.
//
// The document is the source of truth; React Flow is a derived, disposable view (D4). Every semantic
// change routes through a store dispatcher — the canvas never mutates the document itself. The ONE
// compatibility decision (may this edge be created?) is a DATA LOOKUP against the catalog's allow-set
// via `isAllowed` (D5) — there is NO hand-written type rule here. Rejections surface as a composed
// message built from the two port-type LABELS, never from a bespoke conditional.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { DragEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import type {
  Connection,
  Edge as FlowEdge,
  NodeProps,
  ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { DatasetStored, NodeCatalogResponse, NodeTypeDto } from '@quantize/quantize-api'
import type {
  ComponentDefinition,
  ComponentRefNode,
  RegisteredNode,
  StrategyDocument,
} from '@quantize/quantize-ir'
import {
  buildCompatibilitySet,
  defaultParamsFor,
  isAllowed,
  labelOf,
  nodeTypeById,
  useCatalog,
} from '../catalog'
import type { PortType } from '../catalog'
import { categoryColor, portColor } from '../catalog/colors'
import { addComponentRefNode } from '../document/store'
import type { EdgeSpec, StrategyDocumentActions } from '../document/store'
import { componentPorts, resolveComponentDef, toFlow } from '../document/flow'
import type { NodeValidity, StrategyFlowNode } from '../document/flow'
import { useComponentDefs } from '../components-cache'
import { CategoryIcon } from '../icons/categories'
import { COMPONENT_DRAG_MIME, NODE_DRAG_MIME } from './Palette'
import type { ComponentDragPayload, NodeDragPayload } from './Palette'
import { DataSourceCard } from './DataSourceCard'
import { Legend } from './Legend'
import { QuickAdd } from './QuickAdd'
import { StageStrip } from './StageStrip'
import { ValidityBadge } from './ValidityBadge'

/** The RF node key our single custom node registers under. */
const STRATEGY_NODE_TYPE = 'strategyNode'

/**
 * The dataset binding a `data`-category node's Data Source card needs, threaded through context so the
 * RF-owned node component can read it WITHOUT it riding in the node `data` (which is a pure doc/catalog
 * projection). `resolvable` is false in a read-only component view where the binding lives one level up.
 */
interface CanvasChrome {
  datasetId: string | undefined
  datasetMeta: DatasetStored | undefined
  resolvable: boolean
}
const CanvasChromeContext = createContext<CanvasChrome>({
  datasetId: undefined,
  datasetMeta: undefined,
  resolvable: true,
})

/**
 * The single custom node — now a category-aware CARD (M13.4). Its accent color + icon come from the
 * served `category`; the face shows the display name, a param-summary line and a validity badge. A
 * `data`-category node renders the richer {@link DataSourceCard} body; a ComponentRef renders the
 * composition variant with a version chip. Handles stay on the sides — `id` = PORT NAME (matching
 * `toFlow`) — and are colored by the port type they carry. The card judges nothing (invariant 5).
 */
function StrategyNode({ data, selected }: NodeProps<StrategyFlowNode>): ReactElement {
  const chrome = useContext(CanvasChromeContext)
  // The served catalog resolves each port's human type LABEL for its hover tooltip (PX-3) — the same
  // `labelOf` the Legend and rejection banners use, never a hardcoded string (invariant 5). Absent
  // while the catalog is still loading → the tooltip degrades to just the port name.
  const { catalog } = useCatalog()
  const portTitle = (name: string, portType: PortType): string =>
    catalog === undefined ? name : `${name} · ${labelOf(catalog, portType)}`
  const inputs = data.inputs ?? []
  const outputs = data.outputs ?? []
  const category = data.category
  const isData = category === 'data'
  const accent = data.isComponent
    ? 'var(--component-accent)'
    : categoryColor(category ?? '__unknown__')

  const classes = [
    'snode',
    category ? `snode--cat-${category}` : 'snode--cat-unknown',
    data.isComponent ? 'snode--component' : '',
    isData ? 'snode--data' : '',
    selected ? 'snode--selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} title={data.description} style={{ ['--node-accent' as string]: accent }}>
      <div className="snode__frame">
        <div className="snode__col snode__col--in">
          {inputs.map((port) => (
            <div
              key={port.name}
              className="snode__port snode__port--in"
              title={portTitle(port.name, port.port_type)}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={port.name}
                style={{ background: portColor(port.port_type) }}
              />
              <span className="snode__portlabel">
                {port.name}
                {port.required ? (
                  <span className="snode__req" title="required">
                    {' *'}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>

        <div className="snode__main">
          {isData ? (
            <DataSourceCard
              displayName={data.displayName ?? data.typeId}
              datasetId={chrome.datasetId}
              datasetMeta={chrome.datasetMeta}
              universeTickers={data.universeTickers}
              resolvable={chrome.resolvable}
              validity={data.validity}
            />
          ) : (
            <>
              <div className="snode__title">
                <CategoryIcon category={category ?? '__unknown__'} className="snode__icon" />
                <span className="snode__name">{data.displayName ?? data.typeId}</span>
                {data.isComponent && data.version !== undefined ? (
                  <span className="snode__vchip">v{data.version}</span>
                ) : null}
                <ValidityBadge validity={data.validity} />
              </div>
              {data.paramSummary !== undefined ? (
                <div className="snode__summary">{data.paramSummary}</div>
              ) : null}
            </>
          )}
        </div>

        <div className="snode__col snode__col--out">
          {outputs.map((port) => (
            <div
              key={port.name}
              className="snode__port snode__port--out"
              title={portTitle(port.name, port.port_type)}
            >
              <span className="snode__portlabel">{port.name}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.name}
                style={{ background: portColor(port.port_type) }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The outcome of the connect gate: an allowed edge to append, or a human rejection reason. */
export type ConnectionDecision =
  | { allowed: true; edge: EdgeSpec }
  | { allowed: false; reason: string }

// Resolve ONE endpoint's port type. A registered node resolves via the catalog (`type_id` → node type
// → port); a `ComponentRefNode` resolves via its pinned definition in the cache through the SAME
// `componentPorts` helper `toFlow` uses — so a component instance's ports come from ONE place, never a
// second resolution path. Returns the port TYPE (data, copied — never compared here) or a graceful
// reason: an unknown/future node type, a definition not yet loaded, or an unknown port.
function resolveEndpointPortType(
  catalog: NodeCatalogResponse,
  doc: StrategyDocument,
  components: ReadonlyMap<string, ComponentDefinition> | undefined,
  node: RegisteredNode | ComponentRefNode,
  handle: string,
  direction: 'output' | 'input',
): { portType: PortType } | { reason: string } {
  if ('ref' in node) {
    const def = resolveComponentDef(doc.component_refs, node.ref, components)
    if (def === undefined) {
      return { reason: 'Component definition is not loaded (or the ref is unknown).' }
    }
    const ports = componentPorts(def)
    const port =
      direction === 'output'
        ? ports.outputs.find((p) => p.name === handle)
        : ports.inputs.find((p) => p.name === handle)
    if (port === undefined) {
      return { reason: 'Connection references an unknown port.' }
    }
    return { portType: port.port_type }
  }
  const nodeType = nodeTypeById(catalog, node.type_id)
  if (nodeType === undefined) {
    return { reason: `Unknown node type "${node.type_id}".` }
  }
  const port =
    direction === 'output'
      ? nodeType.outputs.find((p) => p.name === handle)
      : nodeType.inputs.find((p) => p.name === handle)
  if (port === undefined) {
    return { reason: 'Connection references an unknown port.' }
  }
  return { portType: port.port_type }
}

/**
 * Decide whether a candidate React Flow connection may become an IR edge — the CORE gate.
 *
 * Resolves the source node's OUTPUT port type and the target node's INPUT port type (a registered node
 * via the catalog, a component instance via the cached definition — one resolution path), then defers
 * the verdict entirely to the allow-set lookup `isAllowed`. There is no conditional over `kind`/`dtype`
 * here. Anything that fails to resolve (missing endpoint/handle, unknown node type, a component
 * definition not yet loaded, unknown port) rejects gracefully with a clear reason rather than crashing.
 * A candidate that duplicates an existing `(from, to)` edge is also rejected — the canvas is the dedupe
 * layer, which is what `store.connect` relies on.
 *
 * The compatibility allow-set is passed in (memoized by the caller) so it is not rebuilt per attempt;
 * this function stays pure over its arguments. `components` is optional — when absent, a component
 * endpoint simply rejects as "not loaded" (the same graceful degradation as a cache miss).
 */
export function decideConnection(
  catalog: NodeCatalogResponse,
  compatSet: Set<string>,
  doc: StrategyDocument,
  connection: Connection,
  components?: ReadonlyMap<string, ComponentDefinition>,
): ConnectionDecision {
  const { source, target, sourceHandle, targetHandle } = connection
  if (!source || !target || !sourceHandle || !targetHandle) {
    return { allowed: false, reason: 'Incomplete connection (missing endpoint or port).' }
  }
  const sourceNode = doc.nodes.find((n) => n.id === source)
  const targetNode = doc.nodes.find((n) => n.id === target)
  if (sourceNode === undefined || targetNode === undefined) {
    return { allowed: false, reason: 'Connection references an unknown node.' }
  }
  const out = resolveEndpointPortType(catalog, doc, components, sourceNode, sourceHandle, 'output')
  if ('reason' in out) {
    return { allowed: false, reason: out.reason }
  }
  const inp = resolveEndpointPortType(catalog, doc, components, targetNode, targetHandle, 'input')
  if ('reason' in inp) {
    return { allowed: false, reason: inp.reason }
  }
  // Reject a structurally identical repeat: the same `(from, to)` handle tuple already exists. Doing
  // this here — not in `store.connect` — is what makes the store's "the canvas prevents duplicates"
  // contract true (a naive dedupe in the reducer could silently swallow an intended action).
  const isDuplicate = doc.edges.some(
    (e) =>
      e.from[0] === source &&
      e.from[1] === sourceHandle &&
      e.to[0] === target &&
      e.to[1] === targetHandle,
  )
  if (isDuplicate) {
    return {
      allowed: false,
      reason: `${labelOf(catalog, out.portType)} → ${labelOf(catalog, inp.portType)} is already connected`,
    }
  }
  if (isAllowed(compatSet, out.portType, inp.portType)) {
    return {
      allowed: true,
      edge: { from: [source, sourceHandle], to: [target, targetHandle] },
    }
  }
  return {
    allowed: false,
    reason: `${labelOf(catalog, out.portType)} → ${labelOf(catalog, inp.portType)} is not an allowed connection`,
  }
}

/** Props: the canonical document and the store dispatchers (the canvas owns no document state). */
export interface CanvasProps {
  doc: StrategyDocument
  actions: StrategyDocumentActions
  /**
   * Notify the App that a node was clicked (M11.5). Selection is App-level state — NOT React Flow's
   * transient selection, which the doc re-seed would drop. Optional so M11.4 tests keep passing.
   */
  onNodeClick?: (nodeId: string) => void
  /** The App-selected node id: marks that RF node `selected` so the canvas shows the selection. */
  selectedNodeId?: string | null
  /**
   * The App-owned EXTRACTION selection set (M12.5, E2). When present it drives `selected` on every RF
   * node (`selectedNodeIds.has(id)`) INSTEAD of the single `selectedNodeId`, so the whole subgraph the
   * user is picking highlights at once. Absent (extraction mode off) → single-select as before.
   */
  selectedNodeIds?: ReadonlySet<string> | undefined
  /**
   * True while extraction mode is active (M12.5). It flips two behaviours: a node click TOGGLES set
   * membership (via `onToggleExtractionNode`) instead of single-selecting, and RF's Delete/Backspace is
   * disabled (`deleteKeyCode={null}`) so a stray keypress can never delete the highlighted subgraph.
   */
  extractionMode?: boolean
  /** Toggle a node in/out of the extraction selection set (called on a node click while in mode). */
  onToggleExtractionNode?: (nodeId: string) => void
  /** A validate-highlighted edge INDEX (into `doc.edges`); marks the matching RF edge `selected`. */
  highlightedEdgeIndex?: number | null
  /** The active dataset binding (M13.4) — feeds the Data Source card via context. */
  datasetId?: string | undefined
  /** Served introspection for the active dataset — calendar bounds + fingerprint on the card. */
  datasetMeta?: DatasetStored | undefined
  /**
   * Per-node validity from the LATEST validation (D-7), keyed by node id. Overlaid onto the projected
   * node data so cards badge server diagnostics — the App clears it on any semantic doc mutation.
   */
  nodeValidity?: ReadonlyMap<string, NodeValidity> | undefined
  /**
   * Click on the stage strip's Engine chip (PX-2). The engine is drawn OUTSIDE the graph (invariant 2),
   * so the canvas has no dock channel of its own — the App wires this to switch the bottom dock toward
   * Results/Trace (or Runs when no run is selected). Optional so the canvas renders standalone.
   */
  onEngineClick?: () => void
  /**
   * An external "center this node" request (trace→canvas, M13.7): the App bumps the nonce per trace-row
   * click so re-clicking the same node re-centers. The Canvas fitView-focuses the single node; selection
   * itself already flows through `selectedNodeId`. Optional so the canvas renders standalone.
   */
  focusRequest?: { nodeId: string; nonce: number } | null
}

export function Canvas({
  doc,
  actions,
  onNodeClick,
  selectedNodeId,
  selectedNodeIds,
  extractionMode,
  onToggleExtractionNode,
  highlightedEdgeIndex,
  datasetId,
  datasetMeta,
  nodeValidity,
  onEngineClick,
  focusRequest,
}: CanvasProps): ReactElement {
  const { catalog, loading, error } = useCatalog()
  const { defs: componentDefs, ensure: ensureComponent } = useComponentDefs()
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance<StrategyFlowNode, FlowEdge> | null>(
    null,
  )
  const [rejection, setRejection] = useState<string | undefined>(undefined)
  // A stage-strip segment click highlights that segment's nodes on canvas (purely visual RF selection,
  // cleared by any node click). Kept local — it selects among existing nodes, never mutates the doc.
  const [stageHighlight, setStageHighlight] = useState<ReadonlySet<string> | null>(null)
  // The double-click quick-add menu: its screen anchor while open, or null when closed.
  const [quickAdd, setQuickAdd] = useState<{ x: number; y: number } | null>(null)

  // Fill the component-definition cache for every pinned ref in the document so a loaded componentized
  // strategy renders NAMED component nodes (`toFlow` degrades to a bare node until each arrives). `ensure`
  // is cache-forever and idempotent per key, so re-running on every doc change costs nothing after the
  // first fetch.
  useEffect(() => {
    for (const ref of doc.component_refs) {
      ensureComponent(ref.component_id, ref.version)
    }
  }, [doc.component_refs, ensureComponent])

  // Project the document into the RF node/edge shapes, tagging each node with our custom type so
  // React Flow renders `StrategyNode`. `catalog`/`componentDefs` may be sparse early — `toFlow` handles
  // a missing catalog and a component cache miss (bare node) without crashing.
  const project = useCallback((): { nodes: StrategyFlowNode[]; edges: FlowEdge[] } => {
    const flow = toFlow(doc, catalog, componentDefs)
    return {
      // Mark the selected node(s): the extraction SET (when present) marks every member; otherwise the
      // single App-selected node. A stage-strip highlight ADDS to whatever is selected. Overlay the
      // latest validity (D-7) onto the node data so cards badge server diagnostics.
      nodes: flow.nodes.map((n) => {
        const baseSelected = selectedNodeIds ? selectedNodeIds.has(n.id) : n.id === selectedNodeId
        const validity = nodeValidity?.get(n.id)
        return {
          ...n,
          type: STRATEGY_NODE_TYPE,
          selected: baseSelected || (stageHighlight?.has(n.id) ?? false),
          data: validity === undefined ? n.data : { ...n.data, validity },
        }
      }),
      // `toFlow` maps `doc.edges` in order, so flow index === doc-edge index — the highlight target.
      edges: flow.edges.map((e, i) => (i === highlightedEdgeIndex ? { ...e, selected: true } : e)),
    }
  }, [
    doc,
    catalog,
    componentDefs,
    selectedNodeId,
    selectedNodeIds,
    highlightedEdgeIndex,
    stageHighlight,
    nodeValidity,
  ])

  // React Flow owns LOCAL node/edge state so it can move nodes and draw edges interactively; the
  // document remains the source of truth. We re-seed that local state from the document whenever the
  // document (or catalog) changes — a live edit becomes a doc mutation via a dispatcher, and the doc
  // then flows back here. Positions round-trip through `ui.position`, so the re-seed is a no-op fight.
  // Seed empty and let the re-seed effect below be the ONLY projection: it runs on mount (`project`'s
  // identity differs from any mount value) and on every subsequent change, so `toFlow` runs once per
  // mutation. (A prior `useMemo(project, [project])` seed re-ran `toFlow` and discarded it — dead work.)
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<StrategyFlowNode>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<FlowEdge>([])
  useEffect(() => {
    const flow = project()
    setRfNodes(flow.nodes)
    setRfEdges(flow.edges)
  }, [project, setRfNodes, setRfEdges])

  // Center on an external focus request (trace→canvas, M13.7). The App bumps the nonce per trace-row
  // click, so this re-runs — and re-centers — even when the same node is clicked twice. fitView on a
  // single node id pans/zooms it into view; selection is already handled via `selectedNodeId`.
  useEffect(() => {
    if (focusRequest == null || rfInstance === null) return
    void rfInstance.fitView({ nodes: [{ id: focusRequest.nodeId }], duration: 300, maxZoom: 1.2 })
  }, [focusRequest, rfInstance])

  const nodeTypes = useMemo(() => ({ [STRATEGY_NODE_TYPE]: StrategyNode }), [])

  // The stage strip reads each node's served category (+ whether it is a component) from the projected
  // RF nodes — the SAME category `toFlow` resolved, so the strip's rollup never re-derives stage
  // semantics client-side. Recomputed only when the projected nodes change.
  const stripNodes = useMemo(
    () =>
      rfNodes.map((n) => ({ id: n.id, category: n.data.category, isComponent: n.data.isComponent })),
    [rfNodes],
  )

  // Build the compatibility allow-set once per catalog (not per connection attempt). An empty set
  // while the catalog is still loading is harmless — `onConnect` bails out when `catalog` is absent.
  const compatSet = useMemo(
    () => (catalog === undefined ? new Set<string>() : buildCompatibilitySet(catalog)),
    [catalog],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (catalog === undefined) {
        return
      }
      const decision = decideConnection(catalog, compatSet, doc, connection, componentDefs)
      if (decision.allowed) {
        actions.connect(decision.edge)
        setRejection(undefined)
      } else {
        setRejection(decision.reason)
      }
    },
    [catalog, compatSet, doc, componentDefs, actions],
  )

  const onNodesDelete = useCallback(
    (deleted: StrategyFlowNode[]) => {
      for (const node of deleted) {
        actions.removeNode(node.id)
      }
    },
    [actions],
  )

  const onEdgesDelete = useCallback(
    (deleted: FlowEdge[]) => {
      for (const edge of deleted) {
        if (edge.sourceHandle && edge.targetHandle) {
          actions.disconnect({
            from: [edge.source, edge.sourceHandle],
            to: [edge.target, edge.targetHandle],
          })
        }
      }
    },
    [actions],
  )

  const onNodeDragStop = useCallback(
    (_event: unknown, node: StrategyFlowNode) => {
      actions.setNodeUi(node.id, { position: { x: node.position.x, y: node.position.y } })
    },
    [actions],
  )

  const onNodeClickHandler = useCallback(
    (_event: unknown, node: StrategyFlowNode) => {
      setStageHighlight(null) // a node click supersedes a stage-strip highlight
      // In extraction mode a click TOGGLES set membership; otherwise it single-selects (unchanged).
      if (extractionMode) {
        onToggleExtractionNode?.(node.id)
      } else {
        onNodeClick?.(node.id)
      }
    },
    [extractionMode, onToggleExtractionNode, onNodeClick],
  )

  // A double-click on the empty pane opens the quick-add menu at the pointer. Guard on the pane class
  // so double-clicking a node (or a control) never triggers it. The menu converts screen → flow
  // coordinates through the RF instance on add, so the node lands where the user clicked.
  const onCanvasDoubleClick = useCallback((event: ReactMouseEvent) => {
    if ((event.target as HTMLElement).classList.contains('react-flow__pane')) {
      setQuickAdd({ x: event.clientX, y: event.clientY })
    }
  }, [])

  const onQuickAdd = useCallback(
    (nodeType: NodeTypeDto) => {
      const anchor = quickAdd
      setQuickAdd(null)
      if (rfInstance === null || anchor === null) {
        return
      }
      const position = rfInstance.screenToFlowPosition({ x: anchor.x, y: anchor.y })
      actions.addNode({
        typeId: nodeType.type_id,
        typeVersion: nodeType.type_version,
        params: defaultParamsFor(nodeType),
        position,
      })
    },
    [quickAdd, rfInstance, actions],
  )

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      if (rfInstance === null) {
        return
      }
      // A dragged COMPONENT: mint a `ComponentRefNode` (no catalog needed — components resolve from the
      // definition cache, not the node catalog). Applying the existing pure reducer via `replace` keeps
      // the verbatim-preservation law and needs no new dispatcher.
      const componentRaw = event.dataTransfer.getData(COMPONENT_DRAG_MIME)
      if (componentRaw !== '') {
        let componentPayload: ComponentDragPayload
        try {
          componentPayload = JSON.parse(componentRaw) as ComponentDragPayload
        } catch {
          return
        }
        const position = rfInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
        actions.replace(
          addComponentRefNode(doc, {
            componentId: componentPayload.component_id,
            version: componentPayload.version,
            position,
          }),
        )
        return
      }
      if (catalog === undefined) {
        return
      }
      const raw = event.dataTransfer.getData(NODE_DRAG_MIME)
      if (raw === '') {
        return
      }
      let payload: NodeDragPayload
      try {
        payload = JSON.parse(raw) as NodeDragPayload
      } catch {
        return
      }
      const nodeType = nodeTypeById(catalog, payload.type_id)
      if (nodeType === undefined) {
        return
      }
      const position = rfInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      actions.addNode({
        typeId: payload.type_id,
        typeVersion: payload.type_version,
        params: defaultParamsFor(nodeType),
        position,
      })
    },
    [catalog, rfInstance, doc, actions],
  )

  if (loading) {
    return <div className="canvas canvas--status">Loading node catalog…</div>
  }
  if (error !== undefined) {
    return <div className="canvas canvas--error">Failed to load catalog: {error}</div>
  }
  if (catalog === undefined) {
    return <div className="canvas canvas--status">No catalog available.</div>
  }

  return (
    <CanvasChromeContext.Provider value={{ datasetId, datasetMeta, resolvable: true }}>
      {/* Capture-phase double-click so it fires BEFORE React Flow's own pane dblclick (which zooms and
          stops propagation); RF's zoom-on-double-click is disabled below so the two never fight. */}
      <div
        className="canvas"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDoubleClickCapture={onCanvasDoubleClick}
      >
        {/* The pipeline stage strip — the "you are looking at a strategy machine" device. Above the
            canvas; a segment click highlights its nodes. */}
        <StageStrip
          nodes={stripNodes}
          onSelectSegment={(ids) => setStageHighlight(new Set(ids))}
          onEngineClick={onEngineClick}
        />

        {rejection !== undefined ? (
          <div className="canvas__banner" role="alert">
            {rejection}
            <button
              type="button"
              className="canvas__banner-dismiss"
              onClick={() => setRejection(undefined)}
              aria-label="dismiss"
            >
              ×
            </button>
          </div>
        ) : null}
        <ReactFlow<StrategyFlowNode, FlowEdge>
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          // The editor's selection model is SINGLE-element (App.selectedNodeId; one node/edge deleted at
          // a time). RF's native multi-select (Shift box-select, Ctrl/Cmd multi-click — both on by
          // default) would be collapsed by the doc-driven re-seed mid-interaction, so a later Delete
          // could hit the wrong set. Disable both by nulling their key codes.
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          // While extraction mode is active, disable Delete/Backspace: the App-owned selection set is
          // highlighted via RF `selected`, and a stray keypress must NOT delete the picked subgraph.
          // Off-mode the prop is OMITTED (spread), leaving RF's default delete keys in place.
          {...(extractionMode ? { deleteKeyCode: null } : {})}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={setRfInstance}
          onConnect={onConnect}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClickHandler}
          zoomOnDoubleClick={false}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
          {/* The on-canvas port-type legend — data-driven from the catalog's lattice. A RF Panel
              places it top-right so it never collides with Controls (bottom-left) / MiniMap. */}
          <Panel position="top-right">
            <Legend catalog={catalog} />
          </Panel>
        </ReactFlow>

        {/* The double-click quick-add menu (fuzzy catalog search), anchored at the click. */}
        {quickAdd !== null ? (
          <QuickAdd
            catalog={catalog}
            position={quickAdd}
            onAdd={onQuickAdd}
            onClose={() => setQuickAdd(null)}
          />
        ) : null}
      </div>
    </CanvasChromeContext.Provider>
  )
}
