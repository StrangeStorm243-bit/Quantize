// The React Flow canvas (M11.4): a live, editable view over the canonical document.
//
// The document is the source of truth; React Flow is a derived, disposable view (D4). Every semantic
// change routes through a store dispatcher — the canvas never mutates the document itself. The ONE
// compatibility decision (may this edge be created?) is a DATA LOOKUP against the catalog's allow-set
// via `isAllowed` (D5) — there is NO hand-written type rule here. Rejections surface as a composed
// message built from the two port-type LABELS, never from a bespoke conditional.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DragEvent, ReactElement } from 'react'
import {
  Background,
  Controls,
  Handle,
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
import type { NodeCatalogResponse } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import {
  buildCompatibilitySet,
  defaultParamsFor,
  isAllowed,
  labelOf,
  nodeTypeById,
  useCatalog,
} from '../catalog'
import type { EdgeSpec, StrategyDocumentActions } from '../document/store'
import { toFlow } from '../document/flow'
import type { StrategyFlowNode } from '../document/flow'
import { NODE_DRAG_MIME } from './Palette'
import type { NodeDragPayload } from './Palette'

/** The RF node key our single custom node registers under. */
const STRATEGY_NODE_TYPE = 'strategyNode'

/**
 * The single custom node: title (display name) with a `Handle` per input on the left and per output
 * on the right. Each handle's `id` is the PORT NAME so it matches `toFlow`'s
 * `sourceHandle`/`targetHandle`. Required inputs carry a small `*` badge.
 */
function StrategyNode({ data }: NodeProps<StrategyFlowNode>): ReactElement {
  const inputs = data.inputs ?? []
  const outputs = data.outputs ?? []
  return (
    <div className="snode">
      <div className="snode__title">{data.displayName ?? data.typeId}</div>
      <div className="snode__body">
        <div className="snode__col snode__col--in">
          {inputs.map((port) => (
            <div key={port.name} className="snode__port snode__port--in">
              <Handle type="target" position={Position.Left} id={port.name} />
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
        <div className="snode__col snode__col--out">
          {outputs.map((port) => (
            <div key={port.name} className="snode__port snode__port--out">
              <span className="snode__portlabel">{port.name}</span>
              <Handle type="source" position={Position.Right} id={port.name} />
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

/**
 * Decide whether a candidate React Flow connection may become an IR edge — the CORE gate.
 *
 * Resolves the source node's OUTPUT port type and the target node's INPUT port type from the catalog
 * + the document (node id → `type_id` → node type → port), then defers the verdict entirely to the
 * allow-set lookup `isAllowed`. There is no conditional over `kind`/`dtype` here. Anything that fails
 * to resolve (missing endpoint/handle, unknown node type, unknown port) rejects gracefully with a
 * clear reason rather than crashing. A candidate that duplicates an existing `(from, to)` edge is
 * also rejected — the canvas is the dedupe layer, which is what `store.connect` relies on.
 *
 * The compatibility allow-set is passed in (memoized by the caller) so it is not rebuilt per attempt;
 * this function stays pure over its arguments.
 */
export function decideConnection(
  catalog: NodeCatalogResponse,
  compatSet: Set<string>,
  doc: StrategyDocument,
  connection: Connection,
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
  const sourceType = nodeTypeById(catalog, sourceNode.type_id)
  const targetType = nodeTypeById(catalog, targetNode.type_id)
  if (sourceType === undefined || targetType === undefined) {
    const unknown = sourceType === undefined ? sourceNode.type_id : targetNode.type_id
    return { allowed: false, reason: `Unknown node type "${unknown}".` }
  }
  const outPort = sourceType.outputs.find((o) => o.name === sourceHandle)
  const inPort = targetType.inputs.find((i) => i.name === targetHandle)
  if (outPort === undefined || inPort === undefined) {
    return { allowed: false, reason: 'Connection references an unknown port.' }
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
      reason: `${labelOf(catalog, outPort.port_type)} → ${labelOf(catalog, inPort.port_type)} is already connected`,
    }
  }
  if (isAllowed(compatSet, outPort.port_type, inPort.port_type)) {
    return {
      allowed: true,
      edge: { from: [source, sourceHandle], to: [target, targetHandle] },
    }
  }
  return {
    allowed: false,
    reason: `${labelOf(catalog, outPort.port_type)} → ${labelOf(catalog, inPort.port_type)} is not an allowed connection`,
  }
}

/** Props: the canonical document and the store dispatchers (the canvas owns no document state). */
export interface CanvasProps {
  doc: StrategyDocument
  actions: StrategyDocumentActions
}

export function Canvas({ doc, actions }: CanvasProps): ReactElement {
  const { catalog, loading, error } = useCatalog()
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance<StrategyFlowNode, FlowEdge> | null>(
    null,
  )
  const [rejection, setRejection] = useState<string | undefined>(undefined)

  // Project the document into the RF node/edge shapes, tagging each node with our custom type so
  // React Flow renders `StrategyNode`. `catalog` may be undefined early — `toFlow` handles that.
  const project = useCallback((): { nodes: StrategyFlowNode[]; edges: FlowEdge[] } => {
    const flow = toFlow(doc, catalog)
    return {
      nodes: flow.nodes.map((n) => ({ ...n, type: STRATEGY_NODE_TYPE })),
      edges: flow.edges,
    }
  }, [doc, catalog])

  // React Flow owns LOCAL node/edge state so it can move nodes and draw edges interactively; the
  // document remains the source of truth. We re-seed that local state from the document whenever the
  // document (or catalog) changes — a live edit becomes a doc mutation via a dispatcher, and the doc
  // then flows back here. Positions round-trip through `ui.position`, so the re-seed is a no-op fight.
  const initial = useMemo(() => project(), [project])
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<StrategyFlowNode>(initial.nodes)
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(initial.edges)
  useEffect(() => {
    const flow = project()
    setRfNodes(flow.nodes)
    setRfEdges(flow.edges)
  }, [project, setRfNodes, setRfEdges])

  const nodeTypes = useMemo(() => ({ [STRATEGY_NODE_TYPE]: StrategyNode }), [])

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
      const decision = decideConnection(catalog, compatSet, doc, connection)
      if (decision.allowed) {
        actions.connect(decision.edge)
        setRejection(undefined)
      } else {
        setRejection(decision.reason)
      }
    },
    [catalog, compatSet, doc, actions],
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

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      if (catalog === undefined || rfInstance === null) {
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
    [catalog, rfInstance, actions],
  )

  if (loading) {
    return <div className="canvas canvas--status">Loading node catalog…</div>
  }
  if (error !== undefined) {
    return <div className="canvas canvas--error">Failed to load catalog: {error}</div>
  }

  return (
    <div className="canvas" onDragOver={onDragOver} onDrop={onDrop}>
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
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onInit={setRfInstance}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeDragStop={onNodeDragStop}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}
