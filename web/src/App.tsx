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
import { DatasetPanel, LAST_DATASET_KEY } from './components/DatasetPanel'
import { Inspector } from './components/Inspector'
import { Palette } from './components/Palette'
import { ResultsView } from './components/ResultsView'
import { RunPanel } from './components/RunPanel'
import { StrategyPanel } from './components/StrategyPanel'
import { TraceView } from './components/TraceView'
import { ValidatePanel } from './components/ValidatePanel'
import type { HighlightTarget } from './components/ValidatePanel'
import { newStrategyDocument, useStrategyDocument } from './document/store'
import './App.css'

// The bottom-panel tabs. The document is the single source of truth; datasets/runs/results are
// SERVER state fetched via the client — the App only holds the current selections (dataset id, run
// id) that the panels coordinate over.
type PanelTab = 'strategies' | 'datasets' | 'runs' | 'results' | 'trace'

// Restore the last-selected dataset id from localStorage (a UX convenience ONLY — the server list is
// the source of truth; a stale id simply shows as selected until the user picks another).
function initialDatasetId(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_DATASET_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function App(): ReactElement {
  const [doc, actions] = useStrategyDocument(newStrategyDocument('Untitled'))
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [highlightedEdgeIndex, setHighlightedEdgeIndex] = useState<number | null>(null)
  const [tab, setTab] = useState<PanelTab>('strategies')
  const [datasetId, setDatasetId] = useState<string | undefined>(initialDatasetId)
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined)

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
          <nav className="tabbar" aria-label="panel tabs">
            {(['strategies', 'datasets', 'runs', 'results', 'trace'] as const).map((t) => {
              // Trace inspects a selected run — disabled until one is chosen (like results, it is
              // meaningless without a run; the button gates on the App's `selectedRunId`).
              const needsRun = t === 'trace'
              const disabled = needsRun && selectedRunId === undefined
              return (
                <button
                  key={t}
                  type="button"
                  className={`tabbar__tab ${tab === t ? 'is-active' : ''}`}
                  aria-pressed={tab === t}
                  disabled={disabled}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              )
            })}
          </nav>
          <div className="tabpanel">
            {tab === 'strategies' ? <StrategyPanel doc={doc} actions={actions} /> : null}
            {tab === 'datasets' ? (
              <DatasetPanel activeDatasetId={datasetId} onSelectDataset={setDatasetId} />
            ) : null}
            {tab === 'runs' ? (
              <RunPanel
                doc={doc}
                datasetId={datasetId}
                selectedRunId={selectedRunId}
                onSelectRun={(runId) => {
                  setSelectedRunId(runId)
                  setTab('results')
                }}
              />
            ) : null}
            {tab === 'results' ? <ResultsView runId={selectedRunId} /> : null}
            {tab === 'trace' ? <TraceView runId={selectedRunId} /> : null}
          </div>
        </footer>
      </div>
    </CatalogProvider>
  )
}
