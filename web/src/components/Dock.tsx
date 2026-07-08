// The bottom dock (M13.3): a VS Code-style generic panel strip. It renders a labelled tab per panel
// and mounts the active panel's content. It is deliberately GENERIC — the App supplies the panel set
// (Problems / Runs / Results / Trace today; optimizer/model panels later) so new panels mount without
// any IA change. Pure presentation: tab state and content are owned by the App.
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
}

export function Dock({ tab, onTab, panels }: DockProps): ReactElement {
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
            onClick={() => onTab(p.id)}
          >
            {p.label}
          </button>
        ))}
      </nav>
      <div className="dock__panel">{active?.node}</div>
    </div>
  )
}
