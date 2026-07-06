// The editor shell (M11.5): palette (left), canvas (center), inspector + validate (right), and the
// strategy panel (bottom). The whole tree is wrapped in the `CatalogProvider` so palette, canvas, and
// inspector share ONE catalog fetch. The canonical document lives in `useStrategyDocument`; every
// mutation routes through the store dispatchers (D4).
//
// The App holds the two pieces of view state the panels coordinate over: `selectedNodeId` (set on a
// canvas node click OR by a validate highlight) and `highlightedEdgeIndex` (set by a validate edge
// highlight). Both are DERIVED view state, never a second source of truth — the document is canonical.
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { RunRecordResponse } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { errorMessage, getRun } from './api/client'
import { CatalogProvider } from './catalog'
import { ComponentsProvider } from './components-cache'
import { Canvas } from './components/Canvas'
import { ComponentDrawer } from './components/ComponentDrawer'
import { DatasetPanel, LAST_DATASET_KEY } from './components/DatasetPanel'
import { ExtractDialog } from './components/ExtractDialog'
import { Inspector } from './components/Inspector'
import { Palette } from './components/Palette'
import { ResultsView } from './components/ResultsView'
import { RunPanel } from './components/RunPanel'
import { StrategyPanel } from './components/StrategyPanel'
import { TraceView } from './components/TraceView'
import { ValidatePanel } from './components/ValidatePanel'
import type { HighlightTarget } from './components/ValidatePanel'
import { newStrategyDocument, useStrategyDocument } from './document/store'
import { useSchemaVersionCheck } from './meta'
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
  // Best-effort boot check: warn (never crash) if the server's schema version has drifted from the
  // version this editor was built against. Fulfills the config.ts pin-vs-service contract.
  useSchemaVersionCheck()

  const [doc, actions] = useStrategyDocument(newStrategyDocument('Untitled'))
  // A ref that always points at the LIVE document object. The extraction commit (M12.5b) captures the
  // doc identity when it begins and hands it back at apply time; comparing against `docRef.current`
  // (updated every render) detects a doc that was loaded/created/edited during the async save→validate
  // window, so a stale extraction result can never clobber a document the user has since navigated away
  // from. Object identity is exact here because every store reducer returns a NEW document object.
  const docRef = useRef(doc)
  docRef.current = doc
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [highlightedEdgeIndex, setHighlightedEdgeIndex] = useState<number | null>(null)
  const [tab, setTab] = useState<PanelTab>('strategies')
  const [datasetId, setDatasetId] = useState<string | undefined>(initialDatasetId)
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined)
  // The component whose internals are open in the read-only detail drawer (M12.4, E11). Transient view
  // state — never a second source of truth; the definition itself lives in the immutable cache.
  const [viewedComponent, setViewedComponent] = useState<{ componentId: string; version: string } | null>(
    null,
  )

  // Extraction mode (M12.5, E2): an App-OWNED selection set — NOT React Flow's transient multi-select
  // (kept disabled since M11.10) — so it survives every doc re-seed by construction. `extractionMode`
  // gates the Canvas's click-to-toggle + delete-key behaviour; `extractDialogOpen` mounts the dialog.
  // `componentsRefreshKey` is bumped on a successful extraction so the Palette refetches its list and
  // the freshly-minted component appears without a page reload.
  const [extractionMode, setExtractionMode] = useState(false)
  const [extractionSelection, setExtractionSelection] = useState<Set<string>>(new Set())
  const [extractDialogOpen, setExtractDialogOpen] = useState(false)
  const [componentsRefreshKey, setComponentsRefreshKey] = useState(0)

  // Enter extraction mode: seed the set from the single selection (if any), then clear single-select so
  // the two selection models never fight. Exit paths (cancel / success) always clear the set + dialog.
  const enterExtractionMode = (): void => {
    setExtractionSelection(selectedNodeId !== null ? new Set([selectedNodeId]) : new Set())
    setSelectedNodeId(null)
    setExtractDialogOpen(false)
    setExtractionMode(true)
  }
  const cancelExtraction = (): void => {
    setExtractionMode(false)
    setExtractionSelection(new Set())
    setExtractDialogOpen(false)
  }
  const toggleExtractionNode = (nodeId: string): void => {
    setExtractionSelection((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }
  // A blessed extraction: replace the doc, refresh the palette, leave the mode, and select the minted
  // component instance node. Called from the dialog's `onCommit` ONLY after it applies (see below).
  const onExtracted = (newNodeId: string): void => {
    setComponentsRefreshKey((k) => k + 1)
    setExtractionMode(false)
    setExtractionSelection(new Set())
    setExtractDialogOpen(false)
    setSelectedNodeId(newNodeId === '' ? null : newNodeId)
  }
  // The App-owned commit gate (M12.5b): the dialog server-validated the rewrite and now asks us to apply
  // it. We refuse — WITHOUT mutating anything — if the live document is no longer the object the commit
  // captured (a mid-flight load/new/edit, e.g. from the StrategyPanel the modal does not cover). This is
  // the last line closing the stale-clobber hole; the dialog surfaces a non-destructive message on false.
  const commitExtraction = (
    capturedDoc: StrategyDocument,
    strategy: StrategyDocument,
    newNodeId: string,
  ): boolean => {
    if (docRef.current !== capturedDoc) {
      return false
    }
    actions.replace(strategy)
    onExtracted(newNodeId)
    return true
  }

  // The run record is fetched ONCE per selected run and held here (not in the panels): ResultsView and
  // TraceView are conditionally mounted per tab, so if each fetched its own record every results↔trace
  // flip would refetch + re-parse the same run. The App holds the record so it survives the flips; the
  // panels render the passed record (TraceView keeps its own per-session `getTrace`).
  const [runRecord, setRunRecord] = useState<RunRecordResponse | undefined>(undefined)
  const [runRecordLoading, setRunRecordLoading] = useState(false)
  const [runRecordError, setRunRecordError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (selectedRunId === undefined) {
      setRunRecord(undefined)
      setRunRecordError(undefined)
      setRunRecordLoading(false)
      return
    }
    let cancelled = false
    setRunRecord(undefined)
    setRunRecordError(undefined)
    setRunRecordLoading(true)
    getRun(selectedRunId)
      .then((res) => {
        if (!cancelled) {
          setRunRecord(res)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setRunRecord(undefined)
          setRunRecordError(errorMessage(e))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunRecordLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedRunId])

  // A positional edge highlight (`highlightedEdgeIndex`) is an INDEX into `doc.edges`; once the
  // document mutates or is replaced those indices point at different edges, so a stale highlight would
  // mark the WRONG edge (and, being RF-`selected`, make it Backspace-deletable). Clear it on any doc
  // change — node highlights are id-resolved and survive. Mirrors ValidatePanel clearing its verdict.
  useEffect(() => {
    setHighlightedEdgeIndex(null)
  }, [doc])

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
      <ComponentsProvider>
        <div className="app">
          <header className="app-header">
            <h1>Quantize</h1>
            <span className="app-header__name">
              {doc.strategy.name} · v{doc.strategy.version}
            </span>
          </header>
          <main className="app-body">
            <aside className="app-region app-region--left" aria-label="palette">
              <Palette refreshKey={componentsRefreshKey} />
            </aside>
            <section className="app-region app-region--center" aria-label="canvas">
              <div className="extract-toolbar">
                {extractionMode ? (
                  <div className="extract-banner" role="status">
                    <span className="extract-banner__count">
                      Extraction mode — {extractionSelection.size} node
                      {extractionSelection.size === 1 ? '' : 's'} selected
                    </span>
                    <button
                      type="button"
                      className="pform__btn pform__btn--primary"
                      disabled={extractionSelection.size === 0}
                      onClick={() => setExtractDialogOpen(true)}
                    >
                      Create component…
                    </button>
                    <button type="button" className="pform__btn" onClick={cancelExtraction}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" className="pform__btn" onClick={enterExtractionMode}>
                    Extract component
                  </button>
                )}
              </div>
              <Canvas
                doc={doc}
                actions={actions}
                onNodeClick={(id) => setSelectedNodeId(id)}
                selectedNodeId={selectedNodeId}
                selectedNodeIds={extractionMode ? extractionSelection : undefined}
                extractionMode={extractionMode}
                onToggleExtractionNode={toggleExtractionNode}
                highlightedEdgeIndex={highlightedEdgeIndex}
              />
              {viewedComponent !== null ? (
                <ComponentDrawer
                  componentId={viewedComponent.componentId}
                  version={viewedComponent.version}
                  onClose={() => setViewedComponent(null)}
                />
              ) : null}
              {extractDialogOpen ? (
                <ExtractDialog
                  doc={doc}
                  selection={extractionSelection}
                  onCommit={commitExtraction}
                  onCancel={() => setExtractDialogOpen(false)}
                />
              ) : null}
            </section>
            <aside className="app-region app-region--right" aria-label="inspector">
              <Inspector
                doc={doc}
                selectedNodeId={selectedNodeId}
                actions={actions}
                onInspectComponent={(target) => setViewedComponent(target)}
              />
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
              {tab === 'results' ? (
                <ResultsView
                  runId={selectedRunId}
                  record={runRecord}
                  loading={runRecordLoading}
                  error={runRecordError}
                />
              ) : null}
              {tab === 'trace' ? (
                <TraceView
                  runId={selectedRunId}
                  record={runRecord}
                  recordLoading={runRecordLoading}
                  recordError={runRecordError}
                />
              ) : null}
            </div>
          </footer>
        </div>
      </ComponentsProvider>
    </CatalogProvider>
  )
}
