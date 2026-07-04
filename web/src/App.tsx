// The editor shell (M11.4): the first VISIBLE slice — palette (left), canvas (center), and
// placeholder inspector (right) + placeholder bottom panel. The whole tree is wrapped in the
// `CatalogProvider` so the palette and canvas share ONE catalog fetch. The canonical document lives
// in `useStrategyDocument`; the canvas edits it through the store dispatchers (D4).
//
// Param-editing forms, validate/save, and datasets/runs are LATER slices — the inspector and bottom
// panel are deliberately placeholders here.
import type { ReactElement } from 'react'
import { CatalogProvider } from './catalog'
import { Canvas } from './components/Canvas'
import { Palette } from './components/Palette'
import { newStrategyDocument, useStrategyDocument } from './document/store'
import './App.css'

export function App(): ReactElement {
  const [doc, actions] = useStrategyDocument(newStrategyDocument('Untitled'))
  return (
    <CatalogProvider>
      <div className="app">
        <header className="app-header">
          <h1>Quantize</h1>
          <span className="app-header__name">{doc.strategy.name}</span>
        </header>
        <main className="app-body">
          <aside className="app-region app-region--left" aria-label="palette">
            <Palette />
          </aside>
          <section className="app-region app-region--center" aria-label="canvas">
            <Canvas doc={doc} actions={actions} />
          </section>
          <aside className="app-region app-region--right" aria-label="inspector">
            <div className="placeholder">Inspector — node parameters land in M11.5.</div>
          </aside>
        </main>
        <footer className="app-region app-region--bottom" aria-label="panel">
          <div className="placeholder">Validation &amp; runs land in M11.5–M11.6.</div>
        </footer>
      </div>
    </CatalogProvider>
  )
}
