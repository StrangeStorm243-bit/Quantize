// The IDE shell (M13.3): a document-centric workspace. The app has two views — a Home front door
// (no document open) and the editor (a document open). The editor is a strategy bar (identity +
// Validate/Run/Save + dataset chip + session-cursor slot) over the three-column workspace
// (Library | canvas | Inspector) with a VS Code-style bottom Dock (Problems/Runs/Results/Trace).
//
// The canonical document lives in `useStrategyDocument`; every mutation routes through the store
// dispatchers (D4). Strategy CRUD (new/open/save) is lifted here so Home and the strategy bar share
// it, and the App tracks a `savedDoc` baseline so `dirty` is a pure object-identity check (every
// reducer returns a new object). Selection/highlight/run-record are DERIVED view state, never a
// second source of truth.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { DatasetStored, ValidateResponse } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import {
  ApiClientError,
  errorMessage,
  getDataset,
  listStrategyVersions,
  loadStrategyVersion,
  saveStrategy,
} from './api/client'
import { CatalogProvider } from './catalog'
import { ComponentsProvider, useComponentDefs } from './components-cache'
import { Canvas } from './components/Canvas'
import { DatasetPanel, LAST_DATASET_KEY } from './components/DatasetPanel'
import { Dock } from './components/Dock'
import type { DockPanel } from './components/Dock'
import { ExtractDialog } from './components/ExtractDialog'
import { Home } from './components/Home'
import { Inspector } from './components/Inspector'
import { Palette } from './components/Palette'
import { ResultsView } from './components/ResultsView'
import { RunPanel } from './components/RunPanel'
import { StrategyBar } from './components/StrategyBar'
import { TraceView } from './components/TraceView'
import { ValidatePanel } from './components/ValidatePanel'
import type { HighlightTarget } from './validation/targets'
import type { ComponentTrailEntry } from './document/flow'
import { resolveTrailFromPath } from './document/flow'
import { useDebugLoopState } from './run/useDebugLoopState'
import { bumpStrategyVersion, newStrategyDocument, semanticKey, useStrategyDocument } from './document/store'
import { computeNodeValidity } from './validity'
import type { StampedVerdict } from './validity'
import { useSchemaVersionCheck } from './meta'
import { useTheme } from './theme'
import './styles/tokens.css'
import './App.css'

/** The bottom dock's panels (datasets left the dock in M13.3 — they live on Home + the bar chip). */
type DockTab = 'problems' | 'runs' | 'results' | 'trace'

// Restore the last-selected dataset id from localStorage (a UX convenience ONLY — the server list is
// the source of truth; a stale id simply shows as selected until the user picks another).
function initialDatasetId(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_DATASET_KEY) ?? undefined
  } catch {
    return undefined
  }
}

// The exported App is a thin wrapper that mounts the app-wide providers around the real shell. The split
// exists so `AppShell` sits INSIDE its own providers and can therefore call `useCatalog`/`useComponentDefs`
// (M13.8: so it can resolve component-trace paths against the definition cache — wired in the
// trace→breadcrumb step) — a hook can only read a provider mounted ABOVE its component, and the shell
// used to be the provider host itself.
export function App(): ReactElement {
  return (
    <CatalogProvider>
      <ComponentsProvider>
        <AppShell />
      </ComponentsProvider>
    </CatalogProvider>
  )
}

function AppShell(): ReactElement {
  // Best-effort boot check: warn (never crash) if the server's schema version has drifted.
  useSchemaVersionCheck()
  // Theme is a pure client preference (dark default, light opt-in), applied to the document root.
  const [theme, toggleTheme] = useTheme()

  // Home vs. editor is plain app state (no router, D-10). Start on Home: no document is open.
  const [view, setView] = useState<'home' | 'editor'>('home')

  const [doc, actions] = useStrategyDocument(newStrategyDocument('Untitled'))
  // The last saved/loaded document OBJECT: `dirty` is `doc !== savedDoc` (every reducer returns a new
  // object, so any mutation makes them differ; new/open/save reset the baseline to the exact object).
  const [savedDoc, setSavedDoc] = useState<StrategyDocument | null>(null)
  const dirty = savedDoc !== null && doc !== savedDoc

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  // A canvas focus request: a nonce-keyed imperative "center this node" signal (React-idiomatic vs a
  // ref handle) — bumped per click so re-clicking the same row re-centers.
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; nonce: number } | null>(null)
  const [highlightedEdgeIndex, setHighlightedEdgeIndex] = useState<number | null>(null)
  const [dockTab, setDockTab] = useState<DockTab>('problems')
  const [datasetId, setDatasetId] = useState<string | undefined>(initialDatasetId)
  const [datasetMeta, setDatasetMeta] = useState<DatasetStored | undefined>(undefined)
  const [datasetPickerOpen, setDatasetPickerOpen] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined)
  // The debug-loop cluster (M13.7; extracted to a hook in M13.7.5, ahead of M13.8): the selected run's
  // record, the session cursor over its server dates, the axis/evaluated projections, the single
  // tagged trace fetch, and the Inspector's "At session" payload. The scheduling-coupled effects live
  // together in `useDebugLoopState`; the App only threads the values to the bar/panels below.
  const {
    runRecord,
    runRecordLoading,
    runRecordError,
    note,
    sessionCursor,
    setSessionCursor,
    sessionDates,
    evaluatedSessions,
    traceTrees,
    traceLoading,
    traceError,
    atSession,
    runScheduleKind,
  } = useDebugLoopState(selectedRunId)
  // The strategy bar's Validate verb bumps this to trigger a validation in the Problems panel.
  const [validateNonce, setValidateNonce] = useState(0)
  // The document's semantic identity (ui.* excluded) — badges key on THIS, not the whole doc object,
  // so a pure node MOVE never disturbs validity (D-7). `docKeyRef` gives the async validate publisher
  // the latest committed key to stamp its verdict with.
  const docKey = useMemo(() => semanticKey(doc), [doc])
  const docKeyRef = useRef(docKey)
  useEffect(() => {
    docKeyRef.current = docKey
  }, [docKey])
  // The LATEST validation verdict, STAMPED with the semantic key it was validated against, mirrored up
  // from the Problems panel so node cards can badge validity (M13.4, D-7). The panel only publishes a
  // verdict for the current semantics (it discards a superseded in-flight one).
  const [validation, setValidation] = useState<StampedVerdict | undefined>(undefined)
  const onValidationResult = useCallback((verdict: ValidateResponse | undefined) => {
    setValidation(verdict === undefined ? undefined : { verdict, key: docKeyRef.current })
  }, [])
  // Clear the mirrored verdict on any SEMANTIC change (D-7 — no stale green after an edit). The App
  // owns this, NOT the Problems panel: the dock mounts only the active panel, so switching tabs
  // unmounts/remounts ValidatePanel with the SAME semantic key — a panel-owned clear would wipe node
  // badges on mere navigation. Keyed on `docKey`, this fires only on a real semantic edit; a pure ui
  // move (same key) leaves badges intact.
  useEffect(() => {
    setValidation(undefined)
  }, [docKey])
  // Per-node validity — pure projection of the stamped verdict; renders no badge once the key no
  // longer matches the current document, so an ok verdict can never flash green on an edited graph.
  const nodeValidity = useMemo(
    () => computeNodeValidity(validation, doc, docKey),
    [validation, doc, docKey],
  )
  const [saving, setSaving] = useState(false)
  const [shellError, setShellError] = useState<string | undefined>(undefined)
  // A monotonic ticket for document-open requests. Opening a strategy is async (version lookup +
  // load) while Home stays interactive, so rapid clicks race. Each New/Open takes the next ticket and
  // an in-flight open applies (or reports) ONLY if it is still the latest — so the user's LAST action
  // wins and a superseded request is dropped silently (never applied, never a spurious error).
  const openTicketRef = useRef(0)

  // Extraction mode (M12.5, E2): an App-OWNED selection set — NOT React Flow's transient multi-select
  // — so it survives every doc re-seed by construction.
  const [extractionMode, setExtractionMode] = useState(false)
  const [extractionSelection, setExtractionSelection] = useState<Set<string>>(new Set())
  const [extractDialogOpen, setExtractDialogOpen] = useState(false)
  const [componentsRefreshKey, setComponentsRefreshKey] = useState(0)

  // Component-navigation trail (M13.8): an App-OWNED breadcrumb into component internals. Empty = the
  // strategy editing view; each entry descends one pinned `(componentId, version)`. A non-empty trail
  // flips the Canvas into its read-only component view. `componentSelectedNodeId` marks a node INSIDE
  // that view (the M13.7 trace→breadcrumb hook, wired in a later task) — distinct from `selectedNodeId`,
  // which only ever references strategy-doc nodes.
  const [componentTrail, setComponentTrail] = useState<ComponentTrailEntry[]>([])
  const [componentSelectedNodeId, setComponentSelectedNodeId] = useState<string | null>(null)
  // The definition cache (read-only): a served component-trace `component_path` resolves against it to a
  // breadcrumb trail (`resolveTrailFromPath`). AppShell sits inside `ComponentsProvider`, so this hook is
  // legal here; it drives the trace→breadcrumb navigation below.
  const { defs: componentDefs } = useComponentDefs()

  // --- Strategy CRUD (lifted so Home + the strategy bar share it) -------------------------------

  // Apply the non-document editor state for a freshly opened document (the caller already made `next`
  // canonical). Split from the document swap so an async open can guard the swap with `replaceIf` and
  // only enter the editor once the swap actually applied.
  const enterEditorWith = (next: StrategyDocument): void => {
    setSavedDoc(next)
    setSelectedNodeId(null)
    setSelectedRunId(undefined)
    setDockTab('problems')
    setShellError(undefined)
    setSaving(false) // a freshly opened document is not mid-save (a prior save belongs to the old doc)
    // A freshly opened/created document starts at the strategy view (its own graph), never mid-navigation
    // through some previous document's components.
    setComponentTrail([])
    setComponentSelectedNodeId(null)
    setView('editor')
  }

  // New is synchronous — replace immediately. It also claims the next ticket, so any in-flight open
  // is superseded (a New always beats a still-loading Open).
  const handleNew = (name: string): void => {
    openTicketRef.current += 1
    const created = newStrategyDocument(name)
    actions.replace(created)
    enterEditorWith(created)
  }

  // Open is async: claim a ticket, and after each await bail if a newer New/Open has superseded this
  // request — so the user's LATEST click wins regardless of which load resolves first, and a stale
  // earlier request is dropped silently (never applied, never a spurious error). When it is still the
  // latest, nothing else changed the canonical document (only New/Open do, and both bump the ticket),
  // so the swap is unconditional.
  const handleOpen = async (strategyId: string): Promise<void> => {
    const ticket = (openTicketRef.current += 1)
    setShellError(undefined)
    try {
      const { versions } = await listStrategyVersions(strategyId)
      if (ticket !== openTicketRef.current) return // superseded during the version lookup
      if (versions.length === 0) {
        setShellError('This strategy has no stored versions.')
        return
      }
      const latest = versions.reduce((a, b) => (b > a ? b : a), versions[0])
      const loaded = await loadStrategyVersion(strategyId, latest)
      if (ticket !== openTicketRef.current) return // superseded during the load
      actions.replace(loaded)
      enterEditorWith(loaded)
    } catch (e) {
      if (ticket !== openTicketRef.current) return // stale request — do not report its error
      setShellError(errorMessage(e))
    }
  }

  // Save the CURRENT document. Byte-identical → 200/201; a different doc at an existing (id, version)
  // → 409 → bump the version and retry once (mirrors the M11.5 recovery). On success the saved object
  // becomes the dirty baseline, clearing the dirty indicator.
  const handleSave = async (): Promise<void> => {
    // Capture the current document GENERATION. A save must never update the baseline/error/saving of a
    // DIFFERENT document that became current while it was in flight (the user navigated Home and
    // created/opened another doc). New/Open bump the generation; a stale save is dropped on resolution.
    const generation = openTicketRef.current
    const captured = doc
    setSaving(true)
    setShellError(undefined)
    try {
      await saveStrategy(captured)
      if (generation !== openTicketRef.current) return // a different document is now open
      // Baseline becomes the object we persisted. If the user edited during the await, the live doc
      // now differs from `captured`, so `dirty` stays true (there are unsaved edits) — never a clobber,
      // because the success path does not touch the live document.
      setSavedDoc(captured)
    } catch (e) {
      if (generation !== openTicketRef.current) return // stale — do not touch the newer document
      if (e instanceof ApiClientError && e.code === 'artifact_conflict') {
        // Bump + retry — but ONLY if the document is unchanged since we captured it. If the user edited
        // during the save await, `replaceIf` refuses so the bumped STALE document never overwrites the
        // live edit; the user saves again to persist the new content (the async-writer guard, D4).
        const bumped = bumpStrategyVersion(captured)
        if (!actions.replaceIf(captured, bumped)) {
          setShellError('Document changed during save — not retried. Save again to persist your edits.')
          return
        }
        try {
          await saveStrategy(bumped)
          if (generation !== openTicketRef.current) return
          setSavedDoc(bumped)
        } catch (retryError) {
          if (generation !== openTicketRef.current) return
          setShellError(errorMessage(retryError))
        }
      } else {
        setShellError(errorMessage(e))
      }
    } finally {
      // Only clear the SHARED saving indicator if this save's document is still the one on screen —
      // otherwise a stale save would flip a newer document's Save button.
      if (generation === openTicketRef.current) {
        setSaving(false)
      }
    }
  }

  const handleValidate = (): void => {
    setDockTab('problems')
    setValidateNonce((n) => n + 1)
  }
  // Consumption is App-owned via a SYNCHRONOUS guard (M13.4). The nonce is monotonic; this ref records
  // the highest one already run. `consumeValidateNonce` returns true only the FIRST time it sees a given
  // nonce and false thereafter. Because it mutates a ref (not state), the answer is correct WITHIN a
  // single commit — so a StrictMode double-invoked mount effect, and a later dock remount (the dock
  // mounts only the active panel), both run the validation exactly once. A state reset could not: it
  // would not land before StrictMode's second synchronous mount-effect invocation.
  const consumedNonceRef = useRef(0)
  const consumeValidateNonce = useCallback((nonce: number): boolean => {
    if (nonce <= consumedNonceRef.current) {
      return false
    }
    consumedNonceRef.current = nonce
    return true
  }, [])
  const handleRun = (): void => setDockTab('runs')
  // The stage strip's Engine chip links the canvas toward the run outputs (PX-2). With a run selected,
  // Results is enabled → open it; otherwise fall back to Runs (never activate a disabled Results/Trace).
  const handleEngine = (): void => setDockTab(selectedRunId !== undefined ? 'results' : 'runs')
  const handleHome = (): void => {
    setShellError(undefined) // a shell error is contextual to the current document; drop it on nav
    setView('home')
  }

  const onSelectRun = (runId: string): void => {
    setSelectedRunId(runId)
    setDockTab('results')
  }

  // Results→Trace click-through (M13.7): the chart / an evaluation or fill row selects a session, which
  // sets the shared cursor and opens the Trace tab so the decision is inspectable side by side.
  const onSelectSession = (date: string): void => {
    // `date` is a server field (a valuations/evaluation/fill session date), so the cursor contract holds.
    setSessionCursor(date)
    setDockTab('trace')
  }

  // --- Extraction orchestration (unchanged from M12) -------------------------------------------

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
  const onExtracted = (newNodeId: string): void => {
    setComponentsRefreshKey((k) => k + 1)
    setExtractionMode(false)
    setExtractionSelection(new Set())
    setExtractDialogOpen(false)
    setSelectedNodeId(newNodeId === '' ? null : newNodeId)
  }
  const commitExtraction = (
    capturedDoc: StrategyDocument,
    strategy: StrategyDocument,
    newNodeId: string,
  ): boolean => {
    if (!actions.replaceIf(capturedDoc, strategy)) {
      return false
    }
    onExtracted(newNodeId)
    return true
  }
  // A completed canvas marquee reports the enclosed node ids (M13.8, Decision (a)). Outside extraction
  // mode this AUTO-ENTERS the mode seeded with the box — direct manipulation replacing click-toggling in a
  // mode (design W5). The auto-enter immediately nulls the canvas Delete key (extractionMode → deleteKeyCode
  // null), which is what makes restoring the RF marquee safe. Already in the mode → UNION into the set. The
  // set is App-owned, so it survives every doc re-seed by construction (the M11.9 delete-safety worry, closed).
  const onMarqueeSelection = (ids: string[]): void => {
    if (extractionMode) {
      setExtractionSelection((prev) => {
        const next = new Set(prev)
        for (const id of ids) {
          next.add(id)
        }
        return next
      })
    } else {
      // Mirror `enterExtractionMode`'s posture: seed the set, drop the single selection, close any dialog.
      setExtractionSelection(new Set(ids))
      setSelectedNodeId(null)
      setExtractDialogOpen(false)
      setExtractionMode(true)
    }
  }

  // --- Component navigation (M13.8) ------------------------------------------------------------
  // Two entry paths, one shared clear of the in-component emphasis (it belonged to the level we leave).

  // From the INSPECTOR: its selected node is always a STRATEGY-DOC node (a top-level ComponentRef), so
  // entering from it starts fresh at the strategy → this component. REPLACE the trail with `[entry]`
  // rather than append — otherwise re-clicking the same instance (the Inspector still shows it while a
  // trail is open) would push a duplicate crumb (Strategy ▸ X ▸ X).
  const enterComponentFromStrategy = (entry: ComponentTrailEntry): void => {
    setComponentTrail([entry])
    setComponentSelectedNodeId(null)
  }
  // From a CANVAS double-click: APPEND. In the strategy view the trail is empty (append ≡ replace); in a
  // component view a nested-ref double-click descends one more level, so append is the correct semantics.
  const enterComponentNested = (entry: ComponentTrailEntry): void => {
    setComponentTrail((prev) => [...prev, entry])
    setComponentSelectedNodeId(null)
  }
  // Jump the trail to a depth (0 = strategy view, i = keep the first i entries): breadcrumb crumb clicks
  // and Escape (a one-level pop) both route here. `slice(0, depth)` yields `[]` at depth 0.
  const onNavigateToDepth = (depth: number): void => {
    setComponentTrail((prev) => prev.slice(0, depth))
    setComponentSelectedNodeId(null)
  }

  // The active dataset's introspection metadata (M13.1) — drives the strategy-bar chip's date range.
  useEffect(() => {
    if (datasetId === undefined) {
      setDatasetMeta(undefined)
      return
    }
    let cancelled = false
    getDataset(datasetId)
      .then((meta) => {
        if (!cancelled) {
          setDatasetMeta(meta)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDatasetMeta(undefined)
        }
      })
    return () => {
      cancelled = true
    }
  }, [datasetId])

  // Clear a stale node selection when the selected node leaves the document (delete/replace/extract).
  useEffect(() => {
    if (selectedNodeId !== null && !doc.nodes.some((n) => n.id === selectedNodeId)) {
      setSelectedNodeId(null)
    }
  }, [doc, selectedNodeId])

  // A positional edge highlight is an INDEX into `doc.edges`; clear it on any doc change so a stale
  // index never mis-highlights (and is not Backspace-deletable while selected).
  useEffect(() => {
    setHighlightedEdgeIndex(null)
  }, [doc])

  // Trace→canvas/breadcrumb click-through (M13.7 hook, closed in M13.8): a node-origin trace row
  // navigates to its emitting node, wherever it lives in the component hierarchy.
  const onTraceNodeClick = (nodeId: string, componentPath: string[]): void => {
    // Top-level row: always the strategy view. Drop any open trail + in-component emphasis, then select +
    // center the emitting node on the strategy canvas.
    if (componentPath.length === 0) {
      setComponentTrail([])
      setComponentSelectedNodeId(null)
      setSelectedNodeId(nodeId)
      setFocusRequest((prev) => ({ nodeId, nonce: (prev?.nonce ?? 0) + 1 }))
      return
    }
    // A row INSIDE a component: walk the served path to the deepest provable breadcrumb level.
    const trail = resolveTrailFromPath(doc, componentPath, componentDefs)
    if (trail.length === 0) {
      // Unresolvable (malformed path, or the ref has left the document): fall back to the pre-breadcrumb
      // behaviour — select + center the ComponentRef INSTANCE node (component_path[0]) in the strategy view.
      const target = componentPath[0]
      setSelectedNodeId(target)
      setFocusRequest((prev) => ({ nodeId: target, nonce: (prev?.nonce ?? 0) + 1 }))
      return
    }
    // Navigate the breadcrumb. Keep the top-level ComponentRef instance selected so the Inspector still
    // describes it (`selectedNodeId` only ever references strategy-doc nodes).
    setComponentTrail(trail)
    setSelectedNodeId(componentPath[0])
    if (trail.length === componentPath.length) {
      // Fully resolved: the emitting leaf's own level is in view — emphasize + center it there.
      setComponentSelectedNodeId(nodeId)
      setFocusRequest((prev) => ({ nodeId, nonce: (prev?.nonce ?? 0) + 1 }))
    } else {
      // Partial: the leaf's level isn't cached yet, so there is nothing to emphasize here — the tip
      // view's `ensure` loads the rest. Clear any stale emphasis carried over from a prior navigation.
      setComponentSelectedNodeId(null)
    }
  }

  // Resolve a structured validate target to a selection / edge highlight — the App owns both.
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

  const dockPanels: DockPanel[] = [
    {
      id: 'problems',
      label: 'Problems',
      node: (
        <ValidatePanel
          doc={doc}
          onHighlight={onHighlight}
          validateNonce={validateNonce}
          consumeValidateNonce={consumeValidateNonce}
          onResult={onValidationResult}
        />
      ),
    },
    {
      id: 'runs',
      label: 'Runs',
      node: (
        <RunPanel
          doc={doc}
          datasetId={datasetId}
          selectedRunId={selectedRunId}
          onSelectRun={onSelectRun}
        />
      ),
    },
    {
      id: 'results',
      label: 'Results',
      disabled: selectedRunId === undefined,
      node: (
        <ResultsView
          runId={selectedRunId}
          record={runRecord}
          loading={runRecordLoading}
          error={runRecordError}
          onSelectSession={onSelectSession}
        />
      ),
    },
    {
      id: 'trace',
      label: 'Trace',
      disabled: selectedRunId === undefined,
      node: (
        <TraceView
          runId={selectedRunId}
          recordLoading={runRecordLoading}
          recordError={runRecordError}
          sessions={sessionDates}
          evaluatedSessions={evaluatedSessions}
          note={note}
          scheduleKind={runScheduleKind}
          sessionCursor={sessionCursor}
          onCursorChange={setSessionCursor}
          trees={traceTrees}
          treesLoading={traceLoading}
          treesError={traceError}
          onNodeClick={onTraceNodeClick}
        />
      ),
    },
  ]

  return (
    <div className="app">
      <header className="app-header">
        <h1>Quantize</h1>
        <span className="app-header__spacer" />
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      {/* Shell-level error — rendered OUTSIDE the Home/editor branch so a failed open (which
          leaves the user on Home) is visible, as well as a failed save in the editor. */}
      {shellError !== undefined ? (
        <div className="sbar__error" role="alert">
          {shellError}
        </div>
      ) : null}

      {view === 'home' ? (
        <Home
          onNew={handleNew}
          onOpen={(id) => void handleOpen(id)}
          datasetId={datasetId}
          onSelectDataset={setDatasetId}
        />
      ) : (
        <>
          <StrategyBar
            doc={doc}
            dirty={dirty}
            saving={saving}
            datasetId={datasetId}
            datasetMeta={datasetMeta}
            sessionCursor={sessionCursor}
            sessionDates={sessionDates}
            evaluatedSessions={evaluatedSessions}
            onCursorChange={setSessionCursor}
            onValidate={handleValidate}
            onRun={handleRun}
            onSave={() => void handleSave()}
            onChooseDataset={() => setDatasetPickerOpen(true)}
            onHome={handleHome}
          />

          <main className="app-body">
            <aside className="app-region app-region--left" aria-label="library">
              <Palette refreshKey={componentsRefreshKey} />
            </aside>
            <section className="app-region app-region--center" aria-label="canvas">
              {/* The extraction toolbar edits the STRATEGY document, so it is hidden in a component view
                  (a non-empty trail): a definition is immutable — there is nothing to extract there. */}
              {componentTrail.length === 0 ? (
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
              ) : null}
              <Canvas
                doc={doc}
                actions={actions}
                onNodeClick={(id) => setSelectedNodeId(id)}
                selectedNodeId={selectedNodeId}
                selectedNodeIds={extractionMode ? extractionSelection : undefined}
                extractionMode={extractionMode}
                onToggleExtractionNode={toggleExtractionNode}
                onMarqueeSelection={onMarqueeSelection}
                highlightedEdgeIndex={highlightedEdgeIndex}
                datasetId={datasetId}
                datasetMeta={datasetMeta}
                nodeValidity={nodeValidity}
                onEngineClick={handleEngine}
                focusRequest={focusRequest}
                componentTrail={componentTrail}
                componentSelectedNodeId={componentSelectedNodeId}
                onEnterComponent={enterComponentNested}
                onNavigateToDepth={onNavigateToDepth}
              />
              {extractDialogOpen ? (
                <ExtractDialog
                  doc={doc}
                  selection={extractionSelection}
                  onCommit={commitExtraction}
                  onCancel={() => setExtractDialogOpen(false)}
                />
              ) : null}
              {datasetPickerOpen ? (
                <div className="dpicker" role="dialog" aria-label="choose dataset">
                  <div className="dpicker__panel">
                    <div className="dpicker__head">
                      <span className="dpicker__title">Choose dataset</span>
                      <button
                        type="button"
                        className="dpicker__close"
                        aria-label="close dataset picker"
                        onClick={() => setDatasetPickerOpen(false)}
                      >
                        ×
                      </button>
                    </div>
                    <DatasetPanel activeDatasetId={datasetId} onSelectDataset={setDatasetId} />
                  </div>
                </div>
              ) : null}
            </section>
            <aside className="app-region app-region--right" aria-label="inspector">
              <Inspector
                doc={doc}
                selectedNodeId={selectedNodeId}
                actions={actions}
                atSession={atSession}
                onEnterComponent={enterComponentFromStrategy}
              />
            </aside>
          </main>

          <footer className="app-region app-region--bottom" aria-label="dock">
            <Dock tab={dockTab} onTab={(id) => setDockTab(id as DockTab)} panels={dockPanels} />
          </footer>
        </>
      )}
    </div>
  )
}
