// Read-only component internals (M12.4, E11). A drawer over the canvas region that renders a
// component's `implementation.graph` through the SAME `toFlow` used by the main canvas, into a SECOND
// ReactFlow instance that is STRUCTURALLY read-only: it is handed NO dispatch handlers (no onNodesChange
// / onConnect / onNodesDelete / …) and the non-interactive props (`nodesDraggable`/`nodesConnectable`/
// `elementsSelectable` all false, `deleteKeyCode` null), so it can mutate nothing — the document and
// the definition are untouched. Collapse/expand is THIS drawer, not in-canvas expansion; no
// `ui.collapsed` is ever written.
//
// The `implementation.kind` gate is the future-kinds seam: only `graph` is viewable in v0; a future
// `sandboxed`/`model`/`external` kind shows an honest "not viewable" message rather than crashing.
import { useEffect, useMemo } from 'react'
import type { ReactElement } from 'react'
import { Background, Controls, Handle, Position, ReactFlow } from '@xyflow/react'
import type { Edge as FlowEdge, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCatalog } from '../catalog'
import { useComponentDefs } from '../components-cache'
import { toFlow } from '../document/flow'
import type { StrategyFlowNode } from '../document/flow'

/** The RF node key the drawer's read-only custom node registers under. */
const DRAWER_NODE_TYPE = 'readOnlyNode'

/**
 * A read-only mirror of the canvas node: title (display name) with a non-connectable `Handle` per input
 * on the left and per output on the right (so edges attach to the right point). It carries NO
 * interactive affordances — the whole drawer mutates nothing.
 */
function ReadOnlyNode({ data }: NodeProps<StrategyFlowNode>): ReactElement {
  const inputs = data.inputs ?? []
  const outputs = data.outputs ?? []
  return (
    <div className="snode">
      <div className="snode__title">{data.displayName ?? data.typeId}</div>
      <div className="snode__body">
        <div className="snode__col snode__col--in">
          {inputs.map((port) => (
            <div key={port.name} className="snode__port snode__port--in">
              <Handle type="target" position={Position.Left} id={port.name} isConnectable={false} />
              <span className="snode__portlabel">{port.name}</span>
            </div>
          ))}
        </div>
        <div className="snode__col snode__col--out">
          {outputs.map((port) => (
            <div key={port.name} className="snode__port snode__port--out">
              <span className="snode__portlabel">{port.name}</span>
              <Handle type="source" position={Position.Right} id={port.name} isConnectable={false} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export interface ComponentDrawerProps {
  componentId: string
  version: string
  onClose: () => void
}

export function ComponentDrawer({ componentId, version, onClose }: ComponentDrawerProps): ReactElement {
  const { catalog } = useCatalog()
  const { defs, get, ensure } = useComponentDefs()
  const def = get(componentId, version)

  // On a cache miss, fetch the definition once (cache-forever). The drawer only READS the cache.
  // Once loaded, also `ensure` each NESTED component ref's definition so nested `ComponentRefNode`s
  // resolve to their name/ports rather than degrading to bare boxes (invariant 8: components nest).
  // `ensure` is idempotent/cache-forever, so iterating every render is safe against loops; a nested
  // def still loading or 404 → its node stays bare (graceful, no crash).
  useEffect(() => {
    if (def === undefined) {
      ensure(componentId, version)
      return
    }
    for (const ref of def.component_refs) {
      ensure(ref.component_id, ref.version)
    }
  }, [def, componentId, version, ensure])

  // Project the internal graph through the SAME `toFlow`. A component `Graph` is `{nodes, edges}` and
  // carries NO `component_refs` — nested `ComponentRefNode.ref` values resolve against the DEFINITION's
  // `component_refs`, so we splice those onto the widened first arg (toFlow's `Pick<…> &
  // {component_refs?}` already accepts it) or every nested ref would degrade to a bare `component` box.
  // Only when the implementation is a viewable `graph`.
  const flow = useMemo(() => {
    if (def === undefined || def.implementation.kind !== 'graph') {
      return { nodes: [], edges: [] }
    }
    return toFlow(
      { ...def.implementation.graph, component_refs: def.component_refs },
      catalog,
      defs,
    )
  }, [def, catalog, defs])
  const rfNodes = useMemo<StrategyFlowNode[]>(
    () => flow.nodes.map((n) => ({ ...n, type: DRAWER_NODE_TYPE })),
    [flow],
  )
  const nodeTypes = useMemo(() => ({ [DRAWER_NODE_TYPE]: ReadOnlyNode }), [])

  return (
    // Dismissable overlay: Escape closes (keyboard users aren't trapped) and a click on the backdrop
    // (the overlay background, NOT the inner panel) closes. The inner panel stops propagation so a
    // click inside the content never dismisses. The × button remains.
    <div
      className="cdrawer"
      role="dialog"
      aria-label="component internals"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onClose()
        }
      }}
      onClick={onClose}
    >
      <div className="cdrawer__panel" onClick={(e) => e.stopPropagation()}>
        <header className="cdrawer__head">
          <div className="cdrawer__title">{def !== undefined ? def.name : 'Component'}</div>
          <div className="cdrawer__meta">{`${componentId}@${version}`}</div>
          <button type="button" className="cdrawer__close" onClick={onClose} aria-label="close">
            ×
          </button>
        </header>
        <div className="cdrawer__body">
          {def === undefined ? (
            <div className="cdrawer__status">Loading component…</div>
          ) : def.implementation.kind !== 'graph' ? (
            <div className="cdrawer__status">
              This component&apos;s implementation (kind: {def.implementation.kind}) is not viewable.
            </div>
          ) : (
            <ReactFlow<StrategyFlowNode, FlowEdge>
              nodes={rfNodes}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              // Read-only: no interaction, no deletion, and (below) NO dispatch handlers at all.
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              deleteKeyCode={null}
              fitView
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
      </div>
    </div>
  )
}
