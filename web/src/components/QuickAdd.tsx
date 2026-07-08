// Quick-add menu (M13.4): a double-click affordance on the canvas that opens a fuzzy search over the
// node catalog and mints the chosen type at the click position. Pure presentation over server-supplied
// catalog data — it makes no compatibility decision (invariant 5); the Canvas owns positioning + the
// mint action. Esc closes.
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { NodeCatalogResponse, NodeTypeDto } from '@quantize/quantize-api'
import { categoryColor } from '../catalog/colors'
import { CategoryIcon } from '../icons/categories'

export interface QuickAddProps {
  catalog: NodeCatalogResponse
  /** Mint the chosen node type (the Canvas supplies position + default params). */
  onAdd: (nodeType: NodeTypeDto) => void
  onClose: () => void
  /** Screen-space anchor (the double-click point) so the menu opens where the user clicked. */
  position?: { x: number; y: number }
}

/**
 * Case-insensitive SUBSEQUENCE match: every character of `query` appears in `text` in order (not
 * necessarily contiguous). Empty query matches everything. Presentation-only string filtering.
 */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let i = 0
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      i++
    }
  }
  return i === q.length
}

export function QuickAdd({ catalog, onAdd, onClose, position }: QuickAddProps): ReactElement {
  const [query, setQuery] = useState('')
  // Command-palette-style row highlight. Reset to the top match on every query change (see onChange);
  // clamp to the current match list so a shrinking list never points past the end.
  const [activeIndex, setActiveIndex] = useState(0)
  const matches = useMemo(
    () =>
      catalog.node_types
        .filter((nt) => fuzzyMatch(query, nt.display_name) || fuzzyMatch(query, nt.type_id))
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [catalog, query],
  )
  const active = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1)

  return (
    <div
      className="quickadd"
      style={position !== undefined ? { left: position.x, top: position.y } : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onClose()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault() // keep the input caret still while navigating rows
          setActiveIndex((i) => Math.min(i + 1, matches.length - 1))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIndex((i) => Math.max(i - 1, 0))
        } else if (e.key === 'Enter') {
          if (active >= 0) {
            onAdd(matches[active])
          }
        }
      }}
    >
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- a transient popover; focus is expected here
        autoFocus
        type="text"
        className="quickadd__input"
        aria-label="quick add search"
        placeholder="Add a node…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActiveIndex(0)
        }}
      />
      {matches.length === 0 ? (
        <div className="quickadd__empty">No matching node type</div>
      ) : (
        <ul className="quickadd__list">
          {matches.map((nt, i) => (
            <li key={nt.type_id}>
              <button
                type="button"
                className={
                  i === active ? 'quickadd__item quickadd__item--active' : 'quickadd__item'
                }
                aria-selected={i === active}
                onClick={() => onAdd(nt)}
                style={{ ['--node-accent' as string]: categoryColor(nt.category) }}
              >
                <CategoryIcon category={nt.category} className="quickadd__icon" />
                <span className="quickadd__item-name">{nt.display_name}</span>
                <span className="quickadd__item-id">{nt.type_id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
