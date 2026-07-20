// The React Flow canvas (M11.4): a live, editable view over the canonical document.
//
// The document is the source of truth; React Flow is a derived, disposable view (D4). Every semantic
// change routes through a store dispatcher — the canvas never mutates the document itself. The ONE
// compatibility decision (may this edge be created?) is a DATA LOOKUP against the catalog's allow-set
// via `isAllowed` (D5) — there is NO hand-written type rule here. Rejections surface as a composed
// message built from the two port-type LABELS, never from a bespoke conditional.
//
// It has a SECOND mode (M13.8): a non-empty `componentTrail` puts it in a structurally read-only
// component view that projects the trail tip's `ComponentDefinition.implementation.graph` through the
// SAME `toFlow`, mutating nothing (this replaced the modal drawer). The two modes render one ReactFlow
// under a per-view `key` so React remounts on every transition and RF's store never latches a mode's
// props (draggable/handlers/deleteKeyCode) into the other mode.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from 'react'
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
import {
  componentCacheKey,
  componentPorts,
  edgeAddress,
  edgeSignatureOf,
  findComponentRef,
  flowEdgeSignature,
  resolveComponentDef,
  toFlow,
} from '../document/flow'
import type { ComponentTrailEntry, NodeValidity, StrategyFlowNode } from '../document/flow'
import { FlowReadout } from './FlowReadout'
import type { FlowAddress, FlowProbe } from './FlowReadout'
import { useComponentDefs } from '../components-cache'
import { CategoryIcon } from '../icons/categories'
import { Breadcrumb } from './Breadcrumb'
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
  /**
   * Output-port-row hover channel (M14.3, D-36). The card publishes ONLY what it knows — its node id +
   * the row's output port name — and the Canvas composes the full {@link FlowAddress} (trail-derived
   * `component_path` + the card's display label) and feeds the SAME `hovered` state the edge-hover path
   * uses (one readout, one mechanism). `null` clears. Present ONLY with a value probe; ABSENT ⇒ the
   * feature is dormant and the card's output rows wire no hover handlers (DOM-identical to pre-feature).
   */
  onPortHover?: ((address: { nodeId: string; outputPort: string } | null) => void) | undefined
}
export const CanvasChromeContext = createContext<CanvasChrome>({
  datasetId: undefined,
  datasetMeta: undefined,
  resolvable: true,
  onPortHover: undefined,
})

/**
 * The single custom node — now a category-aware CARD (M13.4). Its accent color + icon come from the
 * served `category`; the face shows the display name, a param-summary line and a validity badge. A
 * `data`-category node renders the richer {@link DataSourceCard} body; a ComponentRef renders the
 * composition variant with a version chip. Handles stay on the sides — `id` = PORT NAME (matching
 * `toFlow`) — and are colored by the port type they carry. The card judges nothing (invariant 5).
 */
export function StrategyNode({ id, data, selected }: NodeProps<StrategyFlowNode>): ReactElement {
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
              // Output-port-row hover (M14.3, D-36): publish the value-tap the row carries — the card
              // knows only its node id + this port's name; the Canvas composes the full FlowAddress and
              // feeds the SAME edge-hover readout. Wired ONLY with a probe (onPortHover present); dormant
              // otherwise, so the row renders exactly as before. INPUT rows stay inert (the value belongs
              // to the SOURCE end — an input row would misattribute).
              onMouseEnter={
                chrome.onPortHover
                  ? () => chrome.onPortHover?.({ nodeId: id, outputPort: port.name })
                  : undefined
              }
              onMouseLeave={chrome.onPortHover ? () => chrome.onPortHover?.(null) : undefined}
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

/**
 * A captured edge hover or pin (M14.3): the value-tap {@link FlowAddress} the edge carries, the
 * `trailKey` of the VIEW it was taken in (`componentTrail` instance ids joined), and the ORIGIN it was
 * derived from (post-merge review F1) — the edge signature or node id whose continued existence the
 * readout's honesty depends on. The key + origin are what let {@link effectiveAddress} reject a stale
 * entry after a same-definition instance switch OR after the origin is edited out of the document.
 */
interface FlowEntry {
  address: FlowAddress
  trailKey: string
  // Edge origins key on the index-free endpoint SIGNATURE, never the RF id (post-#30 review): the
  // id embeds the doc array index, which shifts when `disconnect`/`removeNode` filter `doc.edges` —
  // an id-keyed pin falsely died whenever an UNRELATED earlier edge or node was deleted.
  origin: { kind: 'edge'; signature: string } | { kind: 'port'; nodeId: string }
}

/** The projection-existence context {@link effectiveAddress} validates an entry's origin against. */
export interface FlowPresence {
  edgeSignatures: ReadonlySet<string>
  nodeIds: ReadonlySet<string>
}

/**
 * The render-phase gate (M14.3 Fact 9 + post-merge review F1). A hover/pin {@link FlowEntry} renders
 * ONLY while (a) its `trailKey` still matches the view being rendered NOW, and (b) its ORIGIN still
 * exists in the current projection — a deleted edge (click-pin → Backspace) or a deleted node must
 * never leave a readout describing a connection that is no longer on the canvas, and a NEW edge drawn
 * nearby must never inherit a stale pinned value's apparent meaning. Running this in RENDER (not an
 * effect) is the whole point: neither an instance switch (viewKey unchanged, no remount) nor a doc
 * re-seed fires any reset, yet the stale address must not show for even one commit. A lazy effect may
 * GC mismatched entries, but this gate — not the GC — is load-bearing for the one-frame promise.
 */
export function effectiveAddress(
  entry: FlowEntry | null,
  currentTrailKey: string,
  present: FlowPresence,
): FlowAddress | null {
  if (entry === null || entry.trailKey !== currentTrailKey) {
    return null
  }
  const originExists =
    entry.origin.kind === 'edge'
      ? present.edgeSignatures.has(entry.origin.signature)
      : present.nodeIds.has(entry.origin.nodeId)
  return originExists ? entry.address : null
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
  /**
   * A completed marquee (Shift+drag box) in the strategy view reported its enclosed node ids (M13.8). The
   * App mirrors them into its own extraction set — outside extraction mode it auto-enters the mode seeded
   * with the box (design W5's "direct manipulation instead of click-toggling in a mode"), in the mode it
   * unions. Fired via RF's `onSelectionEnd`; never in a read-only component view (nothing to extract).
   */
  onMarqueeSelection?: (nodeIds: string[]) => void
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
  /**
   * The component-navigation trail (M13.8). Empty/absent = the normal strategy editing view. A non-empty
   * trail flips the canvas into a STRUCTURALLY read-only component-view mode: it projects the trail
   * tip's `ComponentDefinition.implementation.graph` through the SAME `toFlow`, drops every dispatch
   * handler, and puts the {@link Breadcrumb} in the StageStrip's slot. This replaced the modal drawer.
   */
  componentTrail?: ComponentTrailEntry[]
  /**
   * Push one level deeper: fired on a double-click of a ComponentRef card with that instance's pinned
   * `(componentId, version)`. Gated off while `extractionMode` is active (nothing to enter mid-extract).
   */
  onEnterComponent?: (entry: ComponentTrailEntry) => void
  /**
   * Jump the trail to a depth (0 = strategy view, i = keep the first i entries). Breadcrumb crumb clicks
   * route here; Escape routes here with `trail.length - 1` (a one-level pop). Component view only.
   */
  onNavigateToDepth?: (depth: number) => void
  /**
   * Visual emphasis for a node INSIDE a component view (trace→breadcrumb, M13.7 hook): marks that
   * projected node RF-`selected`. Distinct from `selectedNodeId`, which references strategy-doc nodes.
   */
  componentSelectedNodeId?: string | null
  /**
   * A single click on a node INSIDE a read-only component view (M13.9 O3): reports the clicked node id
   * so the App can select it for the read-only Inspector. Wired ONLY in the component view — the
   * strategy view uses {@link onNodeClick}. Selecting changes nothing (the definition is immutable);
   * double-click still enters a nested ComponentRef ({@link onEnterComponent}).
   */
  onComponentNodeClick?: (nodeId: string) => void
  /**
   * The run/cursor half of the edge-hover value readout (M14.3). Present ⇒ hovering or keyboard-pinning
   * an edge shows the served value flowing across it at the cursor session; ABSENT ⇒ the whole feature
   * is dormant: no edge handlers are wired, no readout Panel renders, and not a single fetch fires. The
   * App memoizes it from `atSession` (Task 5); the Canvas stays pure presentation over it.
   */
  valueProbe?: FlowProbe | undefined
}

export function Canvas({
  doc,
  actions,
  onNodeClick,
  selectedNodeId,
  selectedNodeIds,
  extractionMode,
  onToggleExtractionNode,
  onMarqueeSelection,
  highlightedEdgeIndex,
  datasetId,
  datasetMeta,
  nodeValidity,
  onEngineClick,
  focusRequest,
  componentTrail,
  onEnterComponent,
  onNavigateToDepth,
  componentSelectedNodeId,
  onComponentNodeClick,
  valueProbe,
}: CanvasProps): ReactElement {
  const { catalog, loading, error } = useCatalog()
  const { defs: componentDefs, ensure: ensureComponent } = useComponentDefs()

  // Component-view mode (M13.8): a non-empty trail projects the trail TIP's definition graph read-only.
  // `readOnly` gates every editing affordance below; `tip`/`tipDef` are the deepest entry and its cached
  // (immutable) definition — `undefined` while it is still being fetched, the only "loading" degradation.
  const trail = componentTrail ?? []
  const readOnly = trail.length > 0
  // The edge-hover value readout (M14.3) is entirely gated on a probe: no probe ⇒ nothing wired, no
  // Panel, zero fetches. `currentTrailKey` identifies the view a hover/pin was captured in — the
  // outermost-first ComponentRef instance ids, exactly the value tap's `component_path` (envelope
  // convention) — so {@link effectiveAddress} can reject an entry after a same-definition instance switch.
  const probeActive = valueProbe !== undefined
  const currentTrailKey = trail.map((e) => e.instanceId).join('/')
  const tip = readOnly ? trail[trail.length - 1] : undefined
  const tipDef =
    tip === undefined ? undefined : componentDefs.get(componentCacheKey(tip.componentId, tip.version))
  // Whether the ReactFlow surface renders at all: the strategy editor always, a component view only
  // once its tip definition has loaded as a viewable `graph` (otherwise the body shows loading/notice).
  const showFlow = !readOnly || (tipDef !== undefined && tipDef.implementation.kind === 'graph')
  // The per-view `<ReactFlow>` key (below): a strategy↔component (or crumb-jump) transition changes it and
  // REMOUNTS the surface, yielding a fresh instance via `onInit`.
  const viewKey = readOnly ? `component:${tip?.componentId}@${tip?.version}` : 'strategy'
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance<StrategyFlowNode, FlowEdge> | null>(
    null,
  )
  // Drop the captured instance the INSTANT the view key changes — during render, before the focus effect
  // runs in the transition commit — so a pending focus request can never apply (and consume its nonce)
  // against the OUTGOING instance/projection. Without this, a view-changing trace-row click whose target
  // id collides with a node in the old view would fire the wrong pan there and then be skipped on the
  // incoming instance (the one-shot nonce already consumed). Setting state during render makes React
  // re-run this component with the null instance before committing — the canonical "reset state on a
  // changed input" path (React docs) — and the incoming `onInit` re-registers the fresh instance.
  //
  // The previous view key is STATE, not a ref: under StrictMode an update render is replayed, and a ref
  // mutation would PERSIST across the replay (marking the change "handled") while the paired render-phase
  // `setRfInstance(null)` is discarded — committing the stale instance. State is discarded/replayed
  // together with the instance reset, so the two stay consistent.
  const [prevViewKey, setPrevViewKey] = useState(viewKey)
  if (prevViewKey !== viewKey) {
    setPrevViewKey(viewKey)
    setRfInstance(null)
  }
  const [rejection, setRejection] = useState<string | undefined>(undefined)
  // A stage-strip segment click highlights that segment's nodes on canvas (purely visual RF selection,
  // cleared by any node click). Kept local — it selects among existing nodes, never mutates the doc.
  const [stageHighlight, setStageHighlight] = useState<ReadonlySet<string> | null>(null)
  // The double-click quick-add menu: its screen anchor while open, or null when closed.
  const [quickAdd, setQuickAdd] = useState<{ x: number; y: number } | null>(null)
  // Edge-hover value readout state (M14.3), on the OUTER Canvas so it SURVIVES the inner `<ReactFlow key=
  // {viewKey}>` remounts. Each entry carries the `trailKey` of the view it was captured in (Fact 9). A
  // pin OUTRANKS a hover; both are render-gated through `effectiveAddress` below.
  const [hovered, setHovered] = useState<FlowEntry | null>(null)
  const [pinnedAddr, setPinnedAddr] = useState<FlowEntry | null>(null)

  // Fill the component-definition cache for every pinned ref in the document so a loaded componentized
  // strategy renders NAMED component nodes (`toFlow` degrades to a bare node until each arrives). `ensure`
  // is cache-forever and idempotent per key, so re-running on every doc change costs nothing after the
  // first fetch.
  useEffect(() => {
    for (const ref of doc.component_refs) {
      ensureComponent(ref.component_id, ref.version)
    }
  }, [doc.component_refs, ensureComponent])

  // Component-view fetches (M13.8), generalizing the old drawer's on-demand fetch effect over the
  // whole trail: ensure EVERY level (so intermediate crumbs resolve their names and the walk
  // can descend), and — once the tip's own definition has loaded as a `graph` — ensure each of its
  // nested `component_refs` so an inner ComponentRefNode resolves to its name/ports rather than a bare
  // box. `ensure` is idempotent/cache-forever, so re-running on every render is free after the first fetch.
  useEffect(() => {
    if (componentTrail === undefined) return
    for (const entry of componentTrail) {
      ensureComponent(entry.componentId, entry.version)
    }
    if (tipDef !== undefined && tipDef.implementation.kind === 'graph') {
      for (const ref of tipDef.component_refs) {
        ensureComponent(ref.component_id, ref.version)
      }
    }
  }, [componentTrail, tipDef, ensureComponent])

  // Project the document into the RF node/edge shapes, tagging each node with our custom type so
  // React Flow renders `StrategyNode`. `catalog`/`componentDefs` may be sparse early — `toFlow` handles
  // a missing catalog and a component cache miss (bare node) without crashing.
  const project = useCallback((): { nodes: StrategyFlowNode[]; edges: FlowEdge[] } => {
    // Component-view projection (M13.8): the trail tip's internal graph through the SAME `toFlow`. A
    // component `Graph` carries no `component_refs`, so splice the definition's onto the widened first
    // arg (as the drawer did) or every nested ref would degrade to a bare box. No validity overlay and
    // no stage highlight here — those are strategy-editing concerns; the only mark is the trace emphasis.
    if (readOnly) {
      if (tipDef === undefined || tipDef.implementation.kind !== 'graph') {
        return { nodes: [], edges: [] }
      }
      const flow = toFlow(
        { ...tipDef.implementation.graph, component_refs: tipDef.component_refs },
        catalog,
        componentDefs,
      )
      return {
        nodes: flow.nodes.map((n) => ({
          ...n,
          type: STRATEGY_NODE_TYPE,
          selected: n.id === componentSelectedNodeId,
        })),
        // A read-only component view sets `elementsSelectable={false}`, which ALSO strips edge
        // focusability — so keyboard Tab can't reach an edge to pin it. When a probe is present, restore
        // ONLY edge focusability per-element (D-39: element-level overrides the global); node
        // interactivity and `elementsSelectable` stay untouched. Dormant without a probe.
        edges: probeActive ? flow.edges.map((e) => ({ ...e, focusable: true })) : flow.edges,
      }
    }
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
    readOnly,
    tipDef,
    componentSelectedNodeId,
    probeActive,
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
  //
  // A focus request is ONE-SHOT: apply each distinct nonce exactly once. The effect must also depend on
  // `rfNodes`/`rfInstance` — so a request whose target isn't in the projection yet applies once it
  // arrives, and a post-mount request applies once `onInit` supplies the instance — but those same
  // dependencies would otherwise REPLAY the last fitView on every UNRELATED re-seed (a plain node
  // selection, a validity overlay, a stage highlight), yanking the viewport back to a stale
  // trace-focused node. Tracking the applied nonce makes those re-seeds idempotent; a genuinely new
  // request (a re-click bumps the nonce) still re-centers. The ref lives on the Canvas (which does not
  // remount on a view switch — only the inner `<ReactFlow>` does), so a consumed nonce is remembered
  // across mode changes too.
  const appliedFocusNonceRef = useRef<number | null>(null)
  useEffect(() => {
    if (focusRequest == null || rfInstance === null) return
    if (appliedFocusNonceRef.current === focusRequest.nonce) return // already applied this request
    // Guard against a node id not in the CURRENT projection: RF's `fitView` with a zero-match node set
    // computes a zero-rect and pans to the origin. A focus request that references a node absent from
    // this view (a stale request across a mode switch) must be a no-op, not a jump to (0,0). We do NOT
    // mark the nonce applied here, so the request still fires if its target arrives on a later re-seed.
    if (!rfNodes.some((n) => n.id === focusRequest.nodeId)) return
    appliedFocusNonceRef.current = focusRequest.nonce
    void rfInstance.fitView({ nodes: [{ id: focusRequest.nodeId }], duration: 300, maxZoom: 1.2 })
  }, [focusRequest, rfInstance, rfNodes])

  // Drop the RF instance when the surface unmounts (a component view's loading/notice body renders no
  // ReactFlow): a stale instance would otherwise let a drop/focus reach a disposed view. The per-view
  // `key` remounts a fresh instance (re-firing `onInit`) whenever the surface returns.
  useEffect(() => {
    if (!showFlow) {
      setRfInstance(null)
    }
  }, [showFlow])

  // Escape (M13.8 breadcrumb pop + M14.3 Fact 10 pin release): ONE window listener, mounted when a
  // component view is open OR a value readout is pinned. The body order is load-bearing:
  //   (1) NEVER hijack Escape from an editable control (an Inspector param field cancelling an edit) —
  //       this guard stays FIRST and unchanged.
  //   (2) A pinned readout releases first and CONSUMES the key (so a component-view Esc unpins before it
  //       would pop a level — two Escapes: release, then pop).
  //   (3) Otherwise, in a component view only, pop one navigation level. `trail.length - 1` keeps the
  //       first (length-1) entries: one level up (0 → the strategy view).
  useEffect(() => {
    if (!readOnly && pinnedAddr === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (
        target !== null &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return
      }
      if (pinnedAddr !== null) {
        setPinnedAddr(null)
        return
      }
      if (readOnly) {
        onNavigateToDepth?.(trail.length - 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [readOnly, pinnedAddr, trail.length, onNavigateToDepth])

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

  // A single click in the READ-ONLY component view (M13.9 O3): report the node id so the App can select
  // it for the read-only Inspector. It mutates nothing — a component definition is immutable — so this is
  // the only node handler the component view wires (double-click still enters a nested ref, below).
  const onComponentNodeClickHandler = useCallback(
    (_event: unknown, node: StrategyFlowNode) => {
      onComponentNodeClick?.(node.id)
    },
    [onComponentNodeClick],
  )

  // A completed marquee (Shift+drag box) in the strategy view (M13.8): read the CURRENT RF selection off
  // the instance and report the enclosed node ids so the App can mirror them into its extraction set. We
  // use RF's `onSelectionEnd` and read `getNodes()` — NOT `onSelectionChange`, which would ALSO fire for
  // the doc re-seed's programmatic `selected: true` marks (see `project`) and echo them back as a phantom
  // marquee. Report only a non-empty box: an empty drag is a deselect, never an extraction seed.
  const onSelectionEnd = useCallback(() => {
    if (rfInstance === null || onMarqueeSelection === undefined) {
      return
    }
    const ids = rfInstance
      .getNodes()
      .filter((n) => n.selected)
      .map((n) => n.id)
    if (ids.length > 0) {
      onMarqueeSelection(ids)
    }
  }, [rfInstance, onMarqueeSelection])

  // ── Edge-hover value readout wiring (M14.3) ───────────────────────────────────────────────────────
  // Build the value-tap address an edge carries, enriched with the SOURCE node's display label. The
  // label is read off the already-projected `rfNodes` (`displayName ?? typeId` — the exact string the
  // card header shows) rather than re-derived from the catalog, so there is one label source. Null when
  // the edge lacks a source handle (edgeAddress's own guard — a malformed edge never builds a request).
  const addressOfEdge = useCallback(
    (edge: Pick<FlowEdge, 'source' | 'sourceHandle'>): FlowAddress | null => {
      const base = edgeAddress(edge, trail)
      if (base === null) {
        return null
      }
      const node = rfNodes.find((n) => n.id === base.nodeId)
      return { ...base, sourceLabel: node?.data.displayName ?? node?.data.typeId ?? base.nodeId }
    },
    [trail, rfNodes],
  )

  // Hover: a 200 ms dwell before the readout fetches lives in FlowReadout; the Canvas only tracks WHICH
  // edge the pointer is over. Each hover records the current view's `trailKey` so a mid-hover view switch
  // render-gates the stale address away (Fact 9). Leaving an edge clears the hover.
  const onEdgeMouseEnter = useCallback(
    (_event: unknown, edge: FlowEdge) => {
      const address = addressOfEdge(edge)
      const signature = flowEdgeSignature(edge)
      setHovered(
        address === null || signature === null
          ? null
          : { address, trailKey: currentTrailKey, origin: { kind: 'edge', signature } },
      )
    },
    [addressOfEdge, currentTrailKey],
  )
  const onEdgeMouseLeave = useCallback(() => setHovered(null), [])

  // Pin path 1 (mouse): a click on an edge pins its address so the readout survives mouse-leave. RF
  // selection is NEVER consulted (Fact 8): pinning is a distinct intent from selecting, and a validation
  // highlight already seeds `selected: true` on an edge — reading selection here would conflate the two.
  const onEdgeClick = useCallback(
    (_event: unknown, edge: FlowEdge) => {
      const address = addressOfEdge(edge)
      const signature = flowEdgeSignature(edge)
      if (address !== null && signature !== null) {
        setPinnedAddr({ address, trailKey: currentTrailKey, origin: { kind: 'edge', signature } })
      }
    },
    [addressOfEdge, currentTrailKey],
  )

  // A pane click (empty canvas) releases a pin — the "click away to dismiss" convention.
  const onPaneClick = useCallback(() => setPinnedAddr(null), [])

  // Output-port-row hover (M14.3, D-36): a node card publishes only the `{nodeId, outputPort}` it knows;
  // here we compose the SAME FlowAddress the edge path builds — trail-derived `component_path` + the
  // card's display label, both via `addressOfEdge` (an output port IS an edge's source end) — and feed
  // the SAME `hovered` state (one readout, one mechanism). `null` clears. Handed to the card through the
  // chrome context ONLY with a probe (see the provider), so the feature is dormant without one.
  const onPortHover = useCallback(
    (port: { nodeId: string; outputPort: string } | null) => {
      if (port === null) {
        setHovered(null)
        return
      }
      const address = addressOfEdge({ source: port.nodeId, sourceHandle: port.outputPort })
      setHovered(
        address === null
          ? null
          : // Origin = the NODE (F1): a port exists as long as its node does — a deleted node's row
            // never fires mouseleave, so existence-gating is the only thing that can clear this.
            { address, trailKey: currentTrailKey, origin: { kind: 'port', nodeId: port.nodeId } },
      )
    },
    [addressOfEdge, currentTrailKey],
  )

  // Pin path 2 (keyboard, Fact 8 + post-merge review F2): Enter/Space over a FOCUSED edge pins it.
  // A CAPTURE-phase handler on the canvas wrapper; the facts below are load-bearing:
  //  • RF selection is never CONSULTED — we read the focused edge's id straight from the rendered DOM
  //    (`.react-flow__edge[data-id]`, the EdgeWrapper contract at @xyflow/react dist/esm/index.mjs:2897)
  //    and act only when it resolves to a CURRENT edge.
  //  • SPACE is fully suppressed on a hit (`preventDefault` stops page scroll; `stopPropagation` stops
  //    RF's window-level pan-activation listener, which still receives bubbling default-prevented
  //    events — a capture-phase element handler runs first, so stopping HERE is sufficient).
  //  • ENTER is pinned AND propagated (F2): RF's own EdgeWrapper keydown then selects the edge too,
  //    preserving the pre-existing keyboard editing flow Tab → Enter (select) → Backspace (delete)
  //    that a blanket stopPropagation had silently broken whenever a run was selected. Coexisting
  //    with selection is not consulting it. (Space cannot get the same treatment — its propagation
  //    IS the pan activation — so Space pins without selecting; Enter is the full-fidelity path.)
  //  • On a MISS (no edge under focus) the handler does nothing at all — RF's own keyboard behavior
  //    (including its intentional Space preventDefault for panning) proceeds untouched.
  // `' '` is the browser's actual KeyboardEvent.key for Space, matching RF's `elementSelectionKeys`.
  const onWrapperKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      const target = event.target as Element | null
      const edgeId = target?.closest('.react-flow__edge')?.getAttribute('data-id')
      if (edgeId == null) {
        return
      }
      const edge = rfEdges.find((e) => e.id === edgeId)
      if (edge === undefined) {
        return
      }
      // Space must be fully suppressed (preventDefault: page scroll; stopPropagation: RF's
      // window-level pan-activation listener still receives bubbling default-prevented events).
      // Enter is deliberately let through (post-merge review F2): RF's own EdgeWrapper handler
      // then ALSO selects the edge, preserving the pre-existing keyboard flow
      // Tab → Enter (select) → Backspace (delete) that a blanket stopPropagation had broken.
      // Pinning still never READS selection — coexisting with it is not consulting it (Fact 8).
      if (event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
      }
      const address = addressOfEdge(edge)
      const signature = flowEdgeSignature(edge)
      if (address !== null && signature !== null) {
        setPinnedAddr({ address, trailKey: currentTrailKey, origin: { kind: 'edge', signature } })
      }
    },
    [rfEdges, addressOfEdge, currentTrailKey],
  )

  // Probe loss (D-34): when the run/cursor probe goes away, the readout can't render and no handler is
  // wired — drop any hover/pin so a probe that later returns never resurrects a stale one.
  useEffect(() => {
    if (valueProbe === undefined) {
      setHovered(null)
      setPinnedAddr(null)
    }
  }, [valueProbe])

  // The address handed to the readout: a pin outranks a hover, each render-gated through the trail
  // check AND the origin-existence check (F1) — an entry whose edge/node was edited out of the
  // document renders nothing from the very commit the DOC changed. Presence derives from the doc
  // (or the tip definition's graph in a component view), NOT from rfNodes/rfEdges: the projection
  // state reseeds in a post-commit effect, so gating on it would leak the stale address for one
  // commit — the exact effect-timing class the trail gate (Fact 9) exists to prevent. Edges key on
  // `edgeSignatureOf` (index-free) — never the RF id, whose index suffix shifts on unrelated
  // deletions. `pinnedAddr !== null` remains the pin STATE (drives the Escape mount + GC trigger)
  // independent of whether the current entry renders; the pinned LABEL, though, gates on the pin
  // actually supplying the rendered address (`pinnedEffective`, below) — not on the state.
  const present: FlowPresence = useMemo(() => {
    const graph =
      readOnly && tipDef !== undefined && tipDef.implementation.kind === 'graph'
        ? tipDef.implementation.graph
        : readOnly
          ? { nodes: [], edges: [] }
          : doc
    return {
      edgeSignatures: new Set(graph.edges.map(edgeSignatureOf)),
      nodeIds: new Set(graph.nodes.map((n) => n.id)),
    }
  }, [doc, readOnly, tipDef])

  // Lazy GC of entries `effectiveAddress` can no longer render — trail-stale (Fact 9) OR origin-dead
  // (post-#30 review: the deleted-origin axis was missed, leaving a "zombie pin" that presented the
  // NEXT hover as pinned and silently ate the next Escape). The render gate — not this effect — is
  // load-bearing for the one-frame guarantee; this only tidies state so `pinnedAddr !== null` (which
  // still mounts the Escape listener) stays honest, and so a re-drawn identical connection can never
  // resurrect a pin that visibly died with its edge. The "Esc to release" hint itself is NOT gated on
  // this effect flushing — it reads `pinnedEffective` (the render-gated pin), so a hover under a
  // just-orphaned pin is never mislabeled in the commit before the GC runs.
  useEffect(() => {
    if (hovered !== null && effectiveAddress(hovered, currentTrailKey, present) === null) {
      setHovered(null)
    }
    if (pinnedAddr !== null && effectiveAddress(pinnedAddr, currentTrailKey, present) === null) {
      setPinnedAddr(null)
    }
  }, [currentTrailKey, present, hovered, pinnedAddr])

  // Hoist the pin's render-gated result into ONE binding: it drives both the pin-over-hover fallback
  // AND the `pinned` label (below). `pinnedAddr !== null` is the raw pin STATE (still the Escape-listener
  // mount + GC trigger), but it can outlive its origin by the one commit before the lazy GC effect
  // flushes — so labeling on the state would present a concurrent hover on ANOTHER edge as pinned for
  // that frame. Gating the label on `pinnedEffective` (the pin ACTUALLY supplying the address) closes it.
  const pinnedEffective = effectiveAddress(pinnedAddr, currentTrailKey, present)
  const effectiveAddr = pinnedEffective ?? effectiveAddress(hovered, currentTrailKey, present)

  // The chrome the node cards consume, memoized on its actual inputs (see the provider note — F4).
  // `onPortHover` is a stable useCallback, so hover-driven Canvas renders reuse this identity.
  const chromeValue = useMemo(
    () => ({
      datasetId,
      datasetMeta,
      resolvable: !readOnly,
      // The output-port-row hover channel (D-36) is live ONLY with a probe — dormant otherwise, so
      // the cards wire no hover handlers and render exactly as before.
      onPortHover: probeActive ? onPortHover : undefined,
    }),
    [datasetId, datasetMeta, readOnly, probeActive, onPortHover],
  )

  // Enter a ComponentRef card's internals on double-click (M13.8): resolve the double-clicked instance's
  // pinned `(componentId, version)` in the CURRENT view's scope — the strategy doc, or the tip
  // definition's own graph/refs inside a component view — and push it onto the trail. Disabled while
  // extraction mode is active (nothing to enter mid-extract) and for non-component nodes.
  const onNodeDoubleClickHandler = useCallback(
    (_event: unknown, node: StrategyFlowNode) => {
      if (extractionMode || onEnterComponent === undefined || !node.data.isComponent) {
        return
      }
      const scopeNodes =
        readOnly && tipDef !== undefined && tipDef.implementation.kind === 'graph'
          ? tipDef.implementation.graph.nodes
          : doc.nodes
      const scopeRefs = readOnly ? tipDef?.component_refs : doc.component_refs
      const irNode = scopeNodes.find((n) => n.id === node.id)
      if (irNode === undefined || !('ref' in irNode)) {
        return
      }
      const ref = findComponentRef(scopeRefs, irNode.ref)
      if (ref === undefined) {
        return
      }
      onEnterComponent({ componentId: ref.component_id, version: ref.version, instanceId: node.id })
    },
    [extractionMode, onEnterComponent, readOnly, tipDef, doc],
  )

  // A double-click on the empty pane opens the quick-add menu at the pointer. Guard on the pane class
  // so double-clicking a node (or a control) never triggers it. Inert in a read-only component view.
  // The menu converts screen → flow coordinates through the RF instance on add.
  const onCanvasDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (readOnly) {
        return
      }
      if ((event.target as HTMLElement).classList.contains('react-flow__pane')) {
        setQuickAdd({ x: event.clientX, y: event.clientY })
      }
    },
    [readOnly],
  )

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
      // A read-only component view accepts no drops — definitions are immutable (invariant 8).
      if (readOnly || rfInstance === null) {
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
    [catalog, rfInstance, doc, actions, readOnly],
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
    <CanvasChromeContext.Provider
      // MEMOIZED (post-merge review F4): the Canvas re-renders on every hover transition
      // (`setHovered` in the edge/port handlers), and an inline value literal would mint a new
      // context identity each time — re-rendering EVERY node card per pointer enter/leave, linearly
      // with node count, on the mousemove hot path. Hover/pin state is deliberately NOT part of the
      // context, so this value is stable across hover renders and the cards bail out.
      value={chromeValue}
    >
      {/* Capture-phase double-click so it fires BEFORE React Flow's own pane dblclick (which zooms and
          stops propagation); RF's zoom-on-double-click is disabled below so the two never fight. */}
      <div
        className="canvas"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDoubleClickCapture={onCanvasDoubleClick}
        // Capture-phase keyboard PIN (M14.3 Fact 8): reads the focused edge off the DOM and, on an edge
        // hit, stops the event before RF's window-level pan listener sees it. Wired ONLY with a probe —
        // absent, the feature is dormant and RF's own keyboard behavior is entirely untouched.
        onKeyDownCapture={probeActive ? onWrapperKeyDownCapture : undefined}
      >
        {/* The strip slot: in a component view the Breadcrumb REPLACES the stage strip (M13.8); in the
            strategy view the pipeline stage strip is the "you are looking at a strategy machine" device
            (a segment click highlights its nodes). */}
        {readOnly ? (
          <Breadcrumb
            strategyName={doc.strategy.name}
            trail={trail}
            labels={trail.map(
              (entry) => componentDefs.get(componentCacheKey(entry.componentId, entry.version))?.name,
            )}
            onNavigate={(depth) => onNavigateToDepth?.(depth)}
          />
        ) : (
          <StageStrip
            nodes={stripNodes}
            onSelectSegment={(ids) => setStageHighlight(new Set(ids))}
            onEngineClick={onEngineClick}
          />
        )}

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
        {/* Component-view body states (M13.8), ported from the drawer: a cache miss shows a loading
            status, a non-`graph` implementation kind shows the honest "not viewable" notice (the
            future-kinds seam), and only a loaded `graph` renders the projected internal graph. */}
        {readOnly && tipDef === undefined ? (
          <div className="canvas__status">Loading component…</div>
        ) : readOnly && tipDef !== undefined && tipDef.implementation.kind !== 'graph' ? (
          <div className="canvas__status">
            This component&apos;s implementation (kind: {tipDef.implementation.kind}) is not viewable.
          </div>
        ) : (
          <ReactFlow<StrategyFlowNode, FlowEdge>
            // A per-view key so React REMOUNTS the surface on every strategy↔component (and crumb-jump)
            // transition. RF v12's store skips `undefined` prop updates and never resets prior values, so
            // without a remount the read-only view's latched flags/handlers would bleed into the editor
            // (and vice versa). The remount also re-fires `onInit` (fresh instance) and re-runs `fitView`.
            key={viewKey}
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            // Marquee (Shift+box) select is RESTORED in the strategy view (M13.8), OFF in a read-only
            // component view. 'Shift' is RF's default selection key, stated explicitly for the reader. The
            // M11.9 hazard — a doc re-seed collapsing a native multi-selection so a later Delete hits the
            // wrong set — is CLOSED, not ignored: `onSelectionEnd` mirrors the box into the App-OWNED
            // extraction set (which survives every re-seed by construction), and auto-entering extraction
            // mode nulls the Delete key. `multiSelectionKeyCode` stays null — Ctrl/Cmd-click multi-select
            // remains out of scope.
            selectionKeyCode={readOnly ? null : 'Shift'}
            multiSelectionKeyCode={null}
            // A read-only component view is STRUCTURALLY non-interactive: the interactivity flags are
            // EXPLICIT booleans (not omitted) so RF's store applies them on every remount — a component
            // view never drags/connects/selects, the editor always can. The mutation dispatchers are
            // additionally OMITTED below. Delete is nulled in the component view AND in extraction mode.
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable={!readOnly}
            {...(readOnly || extractionMode ? { deleteKeyCode: null } : {})}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onInit={setRfInstance}
            // The mutation dispatchers + strategy single-select handler are ABSENT in a read-only
            // component view (absent, not no-ops — so the view can change nothing), present in the
            // strategy editor. The component view instead wires a SELECT-ONLY node click (M13.9 O3):
            // it reports the clicked inner node so the App can inspect it read-only, mutating nothing.
            {...(readOnly
              ? { onNodeClick: onComponentNodeClickHandler }
              : {
                  onConnect,
                  onNodesDelete,
                  onEdgesDelete,
                  onNodeDragStop,
                  onNodeClick: onNodeClickHandler,
                  // A completed Shift+drag marquee → mirror the box into the App-owned extraction set
                  // (M13.8). Strategy view only; a read-only component view has nothing to extract.
                  onSelectionEnd,
                })}
            // Double-click ENTERS a ComponentRef card — passed in both views (it mutates nothing, only
            // pushes onto the App-owned trail).
            onNodeDoubleClick={onNodeDoubleClickHandler}
            // Edge-hover value readout handlers (M14.3), wired in BOTH views but ONLY with a probe:
            // hover drives the dwell fetch, click pins, a pane click releases the pin. Absent probe ⇒
            // omitted entirely (RF receives no edge-hover/pane handlers) so the feature stays dormant.
            {...(probeActive
              ? { onEdgeMouseEnter, onEdgeMouseLeave, onEdgeClick, onPaneClick }
              : {})}
            zoomOnDoubleClick={false}
            fitView
          >
            <Background />
            {/* The interactivity (lock) button flips nodesDraggable/Connectable/Selectable directly in
                RF's store — hide it in the read-only component view (the drawer's `showInteractive={false}`
                guard, ported) so a click can't re-enable drag/connect over an immutable definition. */}
            <Controls showInteractive={!readOnly} />
            <MiniMap />
            {/* The on-canvas port-type legend — data-driven from the catalog's lattice. A RF Panel
                places it top-right so it never collides with Controls (bottom-left) / MiniMap. */}
            <Panel position="top-right">
              <Legend catalog={catalog} />
            </Panel>
            {/* The edge-hover value readout (M14.3): a fixed bottom-center Panel (Legend precedent),
                rendered ONLY with a probe. `effectiveAddr` is the render-gated pin-over-hover address;
                `pinnedEffective !== null` is the pinned LABEL — the pin actually supplied the address
                (not the raw pin state, which can outlive its origin for one pre-GC commit). FlowReadout
                owns the dwell/fetch/lifetime; the Canvas only supplies probe + address + pinned. */}
            {valueProbe !== undefined ? (
              <Panel position="bottom-center">
                <FlowReadout
                  probe={valueProbe}
                  address={effectiveAddr}
                  pinned={pinnedEffective !== null}
                />
              </Panel>
            ) : null}
          </ReactFlow>
        )}

        {/* The double-click quick-add menu (fuzzy catalog search), anchored at the click. Strategy view
            only — the component view is read-only. */}
        {quickAdd !== null && !readOnly ? (
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
