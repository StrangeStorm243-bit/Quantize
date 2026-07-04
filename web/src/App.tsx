// The editor shell (M11.5): palette (left), canvas (center), inspector + validate (right), and the
// strategy panel (bottom). The whole tree is wrapped in the `CatalogProvider` so palette, canvas, and
// inspector share ONE catalog fetch. The canonical document lives in `useStrategyDocument`; every
// mutation routes through the store dispatchers (D4).
//
// The App holds the two pieces of view state the panels coordinate over: `selectedNodeId` (set on a
// canvas node click OR by a validate highlight) and `highlightedEdgeIndex` (set by a validate edge
// highlight). Both are DERIVED view state, never a second source of truth — the document is canonical.
import { useState } from 'react'
import type { ReactElement } from 'react'
import { CatalogProvider } from './catalog'
import { Canvas } from './components/Canvas'
import { Inspector } from './components/Inspector'
import { Palette } from './components/Palette'
import { StrategyPanel } from './components/StrategyPanel'
import { ValidatePanel } from './components/ValidatePanel'
import type { HighlightTarget } from './components/ValidatePanel'
import { newStrategyDocument, useStrategyDocument } from './document/store'
import './App.css'

export function App(): ReactElement {
  const [doc, actions] = useStrategyDocument(newStrategyDocument('Untitled'))
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [highlightedEdgeIndex, setHighlightedEdgeIndex] = useState<number | null>(null)

  // Resolve a structured validate target to a selection / edge highlight — the App owns both. A node
  // index is resolved against the current document to a node id; a runtime target already carries one.
  const onHighlight = (target: HighlightTarget): void => {
    if (target.kind === 'nodeId') {
      setSelectedNodeId(target.nodeId)
      setHighlightedEdgeIndex(null)
    } else if (target.kind === 'nodeIndex') {
      const node = doc.nodes[target.index]
      if (node !== undefined) {
        setSelectedNodeId(node.id)
      }
      setHighlightedEdgeIndex(null)
    } else {
      setHighlightedEdgeIndex(target.index)
    }
  }

  return (
    <CatalogProvider>
      <div className="app">
        <header className="app-header">
          <h1>Quantize</h1>
          <span className="app-header__name">
            {doc.strategy.name} · v{doc.strategy.version}
          </span>
        </header>
        <main className="app-body">
          <aside className="app-region app-region--left" aria-label="palette">
            <Palette />
          </aside>
          <section className="app-region app-region--center" aria-label="canvas">
            <Canvas
              doc={doc}
              actions={actions}
              onNodeClick={(id) => setSelectedNodeId(id)}
              selectedNodeId={selectedNodeId}
              highlightedEdgeIndex={highlightedEdgeIndex}
            />
          </section>
          <aside className="app-region app-region--right" aria-label="inspector">
            <Inspector doc={doc} selectedNodeId={selectedNodeId} actions={actions} />
            <ValidatePanel doc={doc} onHighlight={onHighlight} />
          </aside>
        </main>
        <footer className="app-region app-region--bottom" aria-label="panel">
          <StrategyPanel doc={doc} actions={actions} />
        </footer>
      </div>
    </CatalogProvider>
  )
}
