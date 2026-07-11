// The component-navigation breadcrumb (M13.8) — the strip-slot chrome shown WHILE the canvas is in
// component-view mode. It replaces the modal drawer with an in-canvas trail: the strategy root, then
// one crumb per entered component, deepest last. PURE PRESENTATION — it renders the trail the App owns
// and reports crumb clicks; it resolves no definition, fetches nothing (labels are resolved by the
// caller from the definition cache, `undefined` until loaded).
import type { ReactElement } from 'react'
import type { ComponentTrailEntry } from '../document/flow'

export interface BreadcrumbProps {
  /** The open strategy's name — the root crumb (fallback label "Strategy" when empty). */
  strategyName: string
  /** The component-navigation trail, outermost first. Never empty when this renders. */
  trail: ComponentTrailEntry[]
  /** Display name per trail entry, from the definition cache; `undefined` = not loaded (fall back to
   * the entry's `componentId`). */
  labels: (string | undefined)[]
  /** Navigate to a depth: 0 = strategy view, i = keep the first i trail entries. */
  onNavigate: (depth: number) => void
}

/** The `▸` separator drawn between crumbs — presentational only, hidden from the accessibility tree. */
function Separator(): ReactElement {
  return (
    <span className="crumbs__sep" aria-hidden="true">
      ▸
    </span>
  )
}

export function Breadcrumb({ strategyName, trail, labels, onNavigate }: BreadcrumbProps): ReactElement {
  const lastIndex = trail.length - 1
  return (
    <nav className="crumbs" aria-label="component breadcrumb">
      <button type="button" className="crumbs__item" onClick={() => onNavigate(0)}>
        {strategyName === '' ? 'Strategy' : strategyName}
      </button>
      {trail.map((entry, i) => {
        // The label falls back to the pinned componentId until its definition loads.
        const name = labels[i] ?? entry.componentId
        const text = `${name} v${entry.version}`
        // The deepest crumb is the current location: non-interactive, marked as the current page.
        const isCurrent = i === lastIndex
        return (
          <span key={`${entry.componentId}@${entry.version}#${i}`} className="crumbs__group">
            <Separator />
            {isCurrent ? (
              <span className="crumbs__item crumbs__item--current" aria-current="page">
                {text}
              </span>
            ) : (
              <button type="button" className="crumbs__item" onClick={() => onNavigate(i + 1)}>
                {text}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
