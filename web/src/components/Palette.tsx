// The node palette (M11.4): the M10 catalog projected into grouped, draggable node types.
//
// A palette item is an HTML5 drag SOURCE — on drag start it stashes the node's `type_id`/`type_version`
// on the DataTransfer under a private MIME type; the Canvas reads it on drop and dispatches `addNode`.
// No compatibility or numerical logic lives here — it is pure presentation over `paletteGroups`.
import type { DragEvent, ReactElement } from 'react'
import type { NodeTypeDto } from '@quantize/quantize-api'
import { paletteGroups, useCatalog } from '../catalog'

/** Private DataTransfer MIME for a dragged palette node. Shared with the Canvas drop handler. */
export const NODE_DRAG_MIME = 'application/x-quantize-node'

/** The payload a palette drag carries: enough to mint a node on drop. */
export interface NodeDragPayload {
  type_id: string
  type_version: string
}

function handleDragStart(event: DragEvent<HTMLDivElement>, nodeType: NodeTypeDto): void {
  const payload: NodeDragPayload = {
    type_id: nodeType.type_id,
    type_version: nodeType.type_version,
  }
  event.dataTransfer.setData(NODE_DRAG_MIME, JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'copy'
}

export function Palette(): ReactElement {
  const { catalog, loading, error } = useCatalog()

  if (loading) {
    return <div className="palette palette--status">Loading node catalog…</div>
  }
  if (error !== undefined) {
    return <div className="palette palette--error">Failed to load catalog: {error}</div>
  }
  if (catalog === undefined) {
    return <div className="palette palette--status">No catalog available.</div>
  }

  const groups = paletteGroups(catalog)
  return (
    <div className="palette">
      {groups.map((group) => (
        <div key={group.group} className="palette-group">
          <h3 className="palette-group__title">{group.group}</h3>
          {group.nodeTypes.map((nodeType) => (
            <div
              key={nodeType.type_id}
              className="palette-item"
              draggable
              onDragStart={(event) => handleDragStart(event, nodeType)}
              title={nodeType.description}
            >
              {nodeType.display_name}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
