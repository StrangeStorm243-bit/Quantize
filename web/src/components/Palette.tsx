// The node palette (M11.4): the M10 catalog projected into grouped, draggable node types, plus a
// "Components" section (M12.3) listing saved reusable components.
//
// A palette item is an HTML5 drag SOURCE — on drag start it stashes a payload on the DataTransfer under
// a private MIME type; the Canvas reads it on drop and dispatches a mint action. Node items carry the
// node's `type_id`/`type_version` (→ `addNode`); component items carry `{component_id, version}` (→
// `addComponentRefNode`). No compatibility or numerical logic lives here — it is pure presentation.
import type { DragEvent, ReactElement } from 'react'
import type { ComponentListRow, NodeTypeDto } from '@quantize/quantize-api'
import { paletteGroups, useCatalog } from '../catalog'
import { listComponents } from '../api/client'
import { useFetch } from '../useFetch'

/** Private DataTransfer MIME for a dragged palette node. Shared with the Canvas drop handler. */
export const NODE_DRAG_MIME = 'application/x-quantize-node'

/** Private DataTransfer MIME for a dragged palette component. Shared with the Canvas drop handler. */
export const COMPONENT_DRAG_MIME = 'application/x-quantize-component'

/** The payload a palette NODE drag carries: enough to mint a registered node on drop. */
export interface NodeDragPayload {
  type_id: string
  type_version: string
}

/** The payload a palette COMPONENT drag carries: enough to mint a `ComponentRefNode` on drop. */
export interface ComponentDragPayload {
  component_id: string
  version: string
}

function handleNodeDragStart(event: DragEvent<HTMLDivElement>, nodeType: NodeTypeDto): void {
  const payload: NodeDragPayload = {
    type_id: nodeType.type_id,
    type_version: nodeType.type_version,
  }
  event.dataTransfer.setData(NODE_DRAG_MIME, JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'copy'
}

function handleComponentDragStart(event: DragEvent<HTMLDivElement>, row: ComponentListRow): void {
  const payload: ComponentDragPayload = {
    component_id: row.component_id,
    version: row.version,
  }
  event.dataTransfer.setData(COMPONENT_DRAG_MIME, JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'copy'
}

/** Props: an optional refresh nonce the App bumps after an extraction so the list refetches (M12.5). */
export interface PaletteProps {
  /** Bumping this re-runs the `listComponents` fetch so a freshly-minted component appears at once. */
  refreshKey?: number
}

export function Palette({ refreshKey }: PaletteProps = {}): ReactElement {
  const { catalog, loading, error } = useCatalog()
  // The saved-component list is SERVER state, fetched independently of the node catalog. Every list
  // row (one per component version) is a draggable source. `refreshKey` is part of the fetch deps so a
  // successful extraction (which increments it in the App) re-fetches and surfaces the new component.
  // Hooks run before the early returns below.
  const components = useFetch(listComponents, [refreshKey])

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
  const componentRows = components.data?.components ?? []
  return (
    <div className="palette">
      {groups.map((group) => (
        <div key={group.group} className={`palette-group palette-group--${group.group}`}>
          <h3 className="palette-group__title">{group.label}</h3>
          {group.nodeTypes.map((nodeType) => (
            <div
              key={nodeType.type_id}
              className="palette-item"
              draggable
              onDragStart={(event) => handleNodeDragStart(event, nodeType)}
              title={nodeType.description}
            >
              {nodeType.display_name}
            </div>
          ))}
        </div>
      ))}
      <div className="palette-group palette-group--components">
        <h3 className="palette-group__title">Components</h3>
        {components.loading ? <div className="palette__hint">Loading components…</div> : null}
        {components.error !== undefined ? (
          <div className="palette__hint palette__hint--error">Failed to load components.</div>
        ) : null}
        {!components.loading && components.error === undefined && componentRows.length === 0 ? (
          <div className="palette__hint">No saved components.</div>
        ) : null}
        {componentRows.map((row) => (
          <div
            key={`${row.component_id}@${row.version}`}
            className="palette-item palette-item--component"
            draggable
            onDragStart={(event) => handleComponentDragStart(event, row)}
            title={`${row.name} · v${row.version}`}
          >
            {row.name} · v{row.version}
          </div>
        ))}
      </div>
    </div>
  )
}
