// The bottom dock (M13.3): a VS Code-style generic panel strip. It renders a labelled tab per panel
// and mounts the active panel's content. It is deliberately GENERIC — the App supplies the panel set
// (Problems / Runs / Results / Trace today; optimizer/model panels later) so new panels mount without
// any IA change. Pure presentation: tab state and content are owned by the App.
//
// M14.4: the dock can COLLAPSE to its tab strip (chevron affordance) to give the canvas back its
// vertical share on short desktops. Collapse/expand is App-owned state threaded through `collapsed` +
// `onToggleCollapse`; the dock only reflects it (renders the panel iff open) and adds one nicety —
// clicking a tab while collapsed re-expands on that tab (so a collapsed dock is one click from useful).
import type { ReactElement, ReactNode } from 'react'

export interface DockPanel {
  id: string
  label: string
  /** When true the tab is shown but not selectable (e.g. Results/Trace before a run is chosen). */
  disabled?: boolean
  node: ReactNode
}

export interface DockProps {
  tab: string
  onTab: (id: string) => void
  panels: DockPanel[]
  /** Collapsed = tab strip only, active panel unmounted. App-owned (never auto-toggled here). */
  collapsed: boolean
  onToggleCollapse: () => void
}

export function Dock({ tab, onTab, panels, collapsed, onToggleCollapse }: DockProps): ReactElement {
  const active = panels.find((p) => p.id === tab) ?? panels[0]
  return (
    <div className="dock">
      <nav className="dock__tabs" aria-label="dock tabs">
        {panels.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`dock__tab ${p.id === tab ? 'is-active' : ''}`}
            aria-pressed={p.id === tab}
            disabled={p.disabled === true}
            onClick={() => {
              onTab(p.id)
              // A tab click on a COLLAPSED dock re-expands it on that tab — the tab strip stays live so
              // the dock is one click from useful. Expanded already: leave the collapse state alone.
              if (collapsed) onToggleCollapse()
            }}
          >
            {p.label}
          </button>
        ))}
        {/* Collapse chevron, anchored at the END of the tab strip. `aria-expanded` describes the dock
            body (open = panel visible), so it reads true when NOT collapsed; the label names the ACTION
            the click performs, so a screen reader hears "collapse dock" while open, "expand dock" while
            collapsed — not a state-blind "toggle". */}
        <button
          type="button"
          className="dock__collapse"
          aria-label={collapsed ? 'expand dock' : 'collapse dock'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </nav>
      {collapsed ? null : <div className="dock__panel">{active?.node}</div>}
    </div>
  )
}
