# M13 — Product Reorientation: Visual IDE for Quantitative Trading Systems (Design)

> Design record for the reorientation sprint. The companion implementation plan is
> `2026-07-06-m13-implementation-plan.md`. This document decides *what the product should feel
> like and why*; the plan decides *how it is built and verified*. Documentation only — no code
> was changed alongside this document.
>
> **Founder amendment (2026-07-06), incorporated throughout:** the sprint's bar is *strategy-
> machine legibility*, not IDE-themed polish. Added/strengthened: a first-class Data Source
> card (§4 W2), the strategy-machine narrative with per-node plain-English roles (§3, §4 W2/W3),
> a global session cursor (§4 W4), a designed-but-not-implemented Node Value Tap contract
> (§4 W4), explicit bot/execution-mode framing (§3, §4 W1), named reserved categories for the
> advanced quantitative ceiling (§4 W2, §6), and the 30-second legibility test as the headline
> done-criterion (§3).

## 1. Problem statement

M1–M12 are complete and merged. The system underneath is genuinely IDE-shaped: a versioned JSON
IR, compositional immutable components, structured hierarchical traces, one engine for backtest
and forward, and a single server-side `is_compatible`. But the shipped experience reads as a
**graph-backed admin dashboard**, not the intended **visual IDE for quantitative trading
systems**. Concretely (verified against the M12 codebase):

1. **Information architecture.** The canvas shares billing with a CRUD-style bottom tab bar
   (`strategies | datasets | runs | results | trace`). Strategies and datasets — *documents* and
   *inputs* — are presented as co-equal tabs with run artifacts. Nothing frames the canvas as the
   primary surface of a document-centric tool.
2. **Node legibility.** Every node is an identical white rounded box (`StrategyNode`,
   `web/src/components/Canvas.tsx`): no category color, no icon, no parameter preview, no
   validity state, no port-type cues. A real strategy graph reads as a wall of rectangles — the
   opposite of "visual strategy logic."
3. **Math legibility.** Each node's mathematical meaning exists only as a one-sentence
   `description` in the catalog; the real math lives in Python docstrings and
   `docs/STRATEGY_LANGUAGE.md`, unreachable from the UI. The user cannot "inspect what each node
   means mathematically."
4. **Broken debugging loop.** Trace entries display a `node_id` as dead monospace text — no
   click-through to the canvas. The results chart is a single non-interactive SVG polyline.
   The loop *what happened → where in my graph → why* does not close.
5. **Invisible composition.** A `ComponentRefNode` renders identically to a primitive node;
   drill-down is a modal overlay, not navigation. The product's strongest architectural feature
   (immutable versioned components) is experientially hidden.
6. **No design system.** One 1,300-line CSS file, hard-coded hex colors, light-mode only, no
   tokens, no iconography, no motion. Perceived polish caps well below "product."
7. **No arrival experience.** The app opens onto an empty canvas and a tab bar; the README
   journey (§13 validation: load demo → backtest → read trace → extract component) has no
   in-product path.

The §13 validation plan (3–5 quant-literate testers walk the journey unassisted) presumes
exactly the legibility this sprint adds. Running validation before this sprint would test the
dashboard, not the product thesis.

## 2. Approaches considered

- **A. Visual reskin in place.** Design tokens, node colors, dark mode; keep the IA and
  interaction model. Cheapest, but leaves the admin-dashboard shell, the dead-end trace, and the
  invisible components — the product model stays wrong.
- **B. IDE-shell reorientation (chosen).** Restructure the IA around the canvas as a
  document-centric workspace; make nodes/edges/components visually semantic; close the
  trace↔canvas↔results loop; surface node math in the inspector; add a design system. Backend
  changes limited to *metadata and projections* (catalog categories + docs, trace-tree endpoint,
  dataset introspection) — no engine, evaluator, or IR-semantics changes.
- **C. Full studio rebuild.** New routing/framework, per-node output-series capture in the
  engine, timeline scrubbing, chart library. Overbuilds: per-node capture touches engine +
  persistence + run format; new frameworks contradict the repo's deliberate minimalism; most of
  it is not required to make the product *feel* like an IDE.

**Chosen: B.** It corrects the product model with the smallest coherent change-set, uses
extension seams the M11/M12 code already isolated (`StrategyNode` as sole node renderer,
`HighlightTarget` addressing, `FlowNodeData` enrichment point, conditional panel mounts,
single-CSS-file theming), and leaves clean, named paths to every long-term capability
(§6 pressure tests).

## 3. Product model and key metaphor

The user manipulates a **strategy machine**. The canonical mental model, everywhere in the UI:

```text
Data source → transforms/indicators → signals/conditions → ranking/selection
→ weighting/optimization/risk → portfolio targets → [ENGINE: orders/fills]
→ portfolio evolution → trace/explanation
```

Design commitments that encode it:

- **The canvas is the workspace.** Everything else (library, inspector, dock) is furniture
  around the machine.
- **Stages are visible.** Palette groups, node category colors, and edge/port-type colors all
  derive from the same stage taxonomy, so the left-to-right graph *reads* as the pipeline above.
- **The engine is drawn, not hidden — and not a node.** The graph terminates at
  `output.target_portfolio` (invariant 2). Results and trace views render the engine's
  reconciliation (targets + policy → orders → fills → portfolio evolution) as an explicit,
  visually distinct "engine stage" *after* the graph — teaching the correct mental model without
  ever adding an order-generation node.
- **Execution modes are framed honestly.** The machine has three conceptual operating modes:
  **Backtest** (available), **Paper replay** (available — the existing forward mode, renamed in
  UI copy to what it is), and **Live/broker execution** (explicitly labeled as deferred — named
  in the frame so the product reads as a trading-bot IDE, never presented as available). A
  persistent, unambiguous "all runs are simulations over local data" notice sits with the run
  controls: the UI must never imply real-money trading, while still making clear that
  targets → orders → fills are the *downstream half of the machine*, not a reporting appendix.
- **Reference feel:** Figma (canvas-first composition), VS Code (dock/problems/breadcrumbs,
  dark-first), Observable (inspectable technical cells). Not: a holdings dashboard, a CSV tool,
  a backtest form.

**The legibility bar (headline done-criterion).** A first-time quant-literate user opening the
ETF Momentum Rotation demo must be able to explain, within ~30 seconds and without documentation:
(1) where data enters the machine; (2) what each major stage does; (3) how portfolio targets are
produced; (4) how the engine turns targets into orders and fills; (5) where to inspect math,
parameters, validation, and trace. Every workstream below is in service of this test; the plan
operationalizes it as a scripted closeout checklist (M13.9) and it becomes the first instrument
of §13 validation.

## 4. Design (by workstream)

### W1 — IDE shell & information architecture

- **Home screen** (new, shown when no strategy is open): recent/saved strategies, "New
  strategy," and a prominent **"Walk the journey"** card that loads the seeded ETF Momentum
  Rotation demo — the in-product front door for §13 validation. Strategies become *documents you
  open*, not a tab.
- **Strategy bar** (slim header when a document is open): name · version · dirty state, and the
  primary verbs **Validate · Run · Save**, plus the active-dataset chip and the **session
  cursor** readout (W4). Verbs move from buried panels to the top of the tool.
- **Execution-mode framing** (per §3): the run controls present Backtest / Paper replay / Live
  as the machine's operating modes with Live explicitly marked deferred ("not available in this
  version — broker integration is a future capability"), and carry the persistent
  simulation-only notice. This is copy + presentation structure, not new run capability.
- **Left rail — Library:** the node palette grouped by pipeline stage (stage order, not
  alphabetical), plus a **Components** section with real cards (name, version, exposed-port
  summary). One drag surface for both.
- **Right rail — Inspector:** node identity, parameters, and the new Explanation section (W3).
- **Bottom dock** (VS Code-style panel strip): **Problems** (validation diagnostics) · **Runs**
  · **Results** · **Trace**. Datasets leave the dock: dataset selection lives in the strategy
  bar chip + a management view reachable from Home. The dock is a generic panel system —
  future panels (optimizer diagnostics, model training) mount without IA changes.
- No router dependency required; "Home vs. editor" is app state, matching the repo's
  minimalism. Deep-linking is deferred.

### W2 — Node & graph legibility

- **Category taxonomy served by the registry, not hard-coded in the frontend — and authored as
  machine-stage semantics, NOT derived from `type_id` namespaces.** Add `category` to
  `NodeMetadata` (`quantize/registry/descriptor.py`) and surface it in `/v1/node-types`.
  A guardrail finding (pre-implementation review, 2026-07-06): the §3 narrative *cannot* be
  derived from namespaces — the `portfolio` namespace spans three narrative stages
  (`select_top_n` is selection; `equal_weight`/`fixed_weight`/`apply_mask` are weighting),
  `transform.rank` is narratively ranking, and `logic.greater_than` is a signal. Deriving
  stages in the frontend would put semantic reassignment client-side. So the category is
  **authored per node in the registry** (the `type_id` and IR are untouched). v0 assignment
  table (founder-vetoable, plan D-14):

  | category | nodes |
  |---|---|
  | `universe` | `universe.fixed_list` |
  | `data` | `data.price` |
  | `transform` | `transform.trailing_return`, `transform.moving_average`, `transform.latest` |
  | `signal` | `logic.greater_than` |
  | `selection` | `transform.rank`, `portfolio.select_top_n` |
  | `weighting` | `portfolio.equal_weight`, `portfolio.fixed_weight`, `portfolio.apply_mask` |
  | `risk` | `risk.max_weight` |
  | `output` | `output.target_portfolio` |

  The set stays open: the frontend maps known categories to color tokens and unknown categories
  to a neutral default. Beyond the fallback, the color map **ships named token assignments for
  five reserved future categories** — `optimization` (optimizers, constrained portfolio
  construction, objective functions), `stochastic` (stochastic processes, random walks, mean
  reversion, Monte Carlo), `statistics` (regression, time-series models, distributions,
  factor/volatility/covariance models), `ml` (supervised/RL, model artifacts, inference,
  feature pipelines), and `external` (external model services, data APIs) — unused today,
  tested via a synthetic catalog entry, so those families arrive with a designed identity
  rather than the neutral default. (`signal`, `selection`, and `weighting` — previously on the
  reserved list — are live from day one under this taxonomy.) Execution *policies* are
  deliberately **not** a node category: they are engine-side configuration (invariant 2) and
  surface in the execution-mode framing and Engine stage, never on the palette.
- **Node cards** replace white boxes: category color accent + small icon, display name, a
  one-line **parameter summary** on the face (e.g. `lookback = 63`), and a validity badge fed by
  the latest validation response (presentation of server diagnostics only — the frontend judges
  nothing).
- **First-class Data Source card.** The machine's data entry point must be its most legible
  card, not another box. Nodes in the `data` category render as a larger card composing facts
  the system already holds: **source name** and kind ("Uploaded dataset" — with the connector
  frame reserving future kinds: *Data API · Broker feed — future*), the **universe** (tickers
  read from the connected `universe.*` node's params — document data, not computation),
  **calendar** and **date range** (first/last session, from dataset metadata — requires the
  small dataset-introspection projection in the plan), the **mode** binding (which dataset the
  next run will use), and **provenance** (dataset fingerprint, content-addressed identity).
  Unbound states are explicit ("no dataset selected — choose in the strategy bar"), never
  blank; inside read-only component views, facts that are not resolvable there (dataset
  binding, a universe arriving through an exposed input) show the same explicit placeholders —
  the card never invents resolution logic client-side. The card is pure presentation of server
  metadata + document params.
- **Pipeline stage strip.** A compact horizontal strip above the canvas renders the §3 machine
  narrative — Data → Transforms → Signals → Rank & Select → Weighting & Risk → Targets →
  ⟨Engine⟩ — with each segment colored by its category token and showing the count of the open
  strategy's nodes in that segment; clicking a segment highlights its nodes on canvas. The
  segment↔category rollup is fixed and explicit (pure display grouping of served categories):
  Data ← {`universe`, `data`}; Transforms ← {`transform`}; Signals ← {`signal`};
  Rank & Select ← {`selection`}; Weighting & Risk ← {`weighting`, `risk`};
  Targets ← {`output`}; ⟨Engine⟩ ← no category (engine-owned, invariant 2). Nodes whose
  category matches no segment (reserved/future/unknown) roll into an appended "Advanced"
  bucket — never dropped silently. Component instances are composite (they may span stages
  internally), so they are excluded from segment counts and shown as their own "Components"
  chip at the strip's end. The Engine segment is visually distinct (it is not part of the
  graph) and links to the Engine grouping in Results/Trace. This is the single strongest
  "you are looking at a strategy machine" device and it derives entirely from served
  categories plus this documented rollup.
- **Typed ports and edges:** handles and edges colored by the port type they carry, driven by
  the catalog's `port_types[]` list (data-driven — a future `Matrix` or `Distribution` type gets
  a color assignment, not a code change). A compact legend lives on the canvas.
- **ComponentRef distinction:** stacked/double-border card treatment + version chip, so
  composition is visible at a glance (see W5).
- **Canvas affordances:** minimap, double-click quick-add menu with fuzzy search over the
  catalog, hover tooltip with the node description. Connection rejection stays banner-based but
  gains the port-type colors in its message.

### W3 — Mathematical meaning in the inspector

- **Structured node documentation in the descriptor.** Extend `NodeMetadata` with a `doc` block:
  `summary` (prose), `formula` (plain-text/Unicode math string; a LaTeX field is reserved but
  not rendered in v0 — no math-typesetting dependency yet), `semantics` (missing-data rule,
  warm-up, alignment — the things CLAUDE.md requires to be explicit), and per-parameter
  `label`/`help`. Content is authored once in the registry, sourced from the existing evaluate
  docstrings and `STRATEGY_LANGUAGE.md` — the registry becomes the single home for node meaning,
  served to any client via `/v1/node-types`.
- **Role-first authoring rule for `doc.summary`.** Every summary opens with a plain-English
  *role sentence* — what this node does **for the machine**, readable by a quant-literate
  non-programmer (e.g. `transform.trailing_return`: "Measures each asset's momentum as its
  return over the trailing lookback window — the raw signal this strategy ranks on."). The
  formula and semantics follow the role, never replace it. This rule is enforced by review in
  the plan's metadata audit, and it is what makes the sample strategy narrate itself: with the
  ETF Momentum Rotation demo open, every node exposes its role on the card (category + name +
  param summary) and in one click (inspector role sentence).
- **Inspector Explanation section:** for the selected node, render the role sentence, formula,
  semantics, warm-up, and port meanings. Param form controls gain proper labels/help from the
  doc block instead of raw JSON-Schema keys.
- The doc block is deliberately extensible (future: references, artifact descriptions,
  distribution assumptions for probabilistic nodes) and generically rendered, so ML/stat nodes
  can ship richer docs without UI rework.

### W4 — Closing the debugging loop (trace ↔ canvas ↔ results)

- **Serve the trace tree.** `build_trace_trees` (`quantize/tracing/tree.py`) already assembles
  hierarchical per-instant trees server-side but is unexposed; the client re-implements grouping
  in `web/src/trace/group.ts`. Add `GET /v1/runs/{id}/trace-tree` and delete the client
  grouper — one implementation, per the repo's standing principle.
- **Trace → canvas:** every trace row referencing a node becomes clickable, reusing the
  existing `HighlightTarget` mechanism to select/center the node; rows inside components
  navigate the drill-down breadcrumb (W5) to the right nesting level.
- **Global session cursor.** One selected-session date is app-level state, visible in the
  strategy bar and shared by every inspection surface: the equity chart crosshair sets it,
  clicking an evaluation/fill row sets it, the trace view opens at it, and stepping it
  (◀ prev / next ▶ over the run's session list) moves all of them together. This is how
  "strategy behavior over time" gets a handle before any per-node series exist. The cursor is
  pure client presentation state over **server-supplied session dates only** (the run's
  valuations/evaluations); with no run selected it is absent, and it is cleared when the
  selected run changes. Sessions without an evaluation (warm-up, no-eval notes) are honest
  machine behavior, not blank screens: the stepper visually distinguishes evaluated sessions,
  and empty states cite the run record's served `notes[]` reason when one exists ("no
  evaluation this session: warm-up") rather than showing nothing.
- **Inspector "At session" section (the value-tap slot).** When a run is selected and a cursor
  is set, the inspector shows, for the selected node, the last-run facts that already exist at
  that session: the node's trace events at that instant (from the served trace tree, addressed
  by `(node_id, component_path)`), and for the terminal/engine boundary the reconciliation rows.
  This section is deliberately designed as the **rendering slot for the future Node Value Tap**
  — when per-node values ship, they appear here with zero relayout.
- **Results → trace:** the equity chart becomes interactive (hover crosshair with date/value,
  click a session → set the cursor and open that session's trace). Evaluation and fill rows link
  to their session trace via the cursor. The chart remains a hand-rolled SVG rendering
  **server-provided series only** — pixel mapping is presentation, not numerics; no chart
  library, no client-side derived statistics.
- **Engine stage rendering:** results/trace views group `engine.*` events and reconciliation
  rows under an explicit "Engine" heading with the targets→orders→fills flow, per §3.
- **Designed, not implemented — the Node Value Tap contract.** "Watch data flow through the
  graph" ultimately wants each node's output values. That requires engine-side capture (a run
  option), a persistence-format change, and a fetch endpoint — real engine/format work,
  explicitly out of scope. M13 fixes the **contract shape** now so nothing built in this sprint
  has to move later:

  ```text
  FUTURE  GET /v1/runs/{run_id}/values
            ?node_id= &component_path= &session_date= &output_port=
  →  {
       node_id, component_path, session_date, output_port,
       value_summary,        # server-computed: port_type + type-appropriate digest
                             # (count/min/max for cross-sections, weight sum for targets, …)
       asset_values?,        # [{asset, value}] for CrossSection/PortfolioTargets/AssetSet
       series_preview?,      # [(date, value)] window for TimeSeries ports
       provenance            # {run_id, dataset_fingerprint, captured: bool}
     }
  ```

  All summarization is server-side (invariant 5 — the frontend never derives numbers). M13's
  obligations to this contract: the inspector "At session" section is its rendering slot; trace
  and canvas addressing already speak `(node_id, component_path)`; the session cursor supplies
  `session_date`; node cards' output handles are the natural affordance for `output_port`.
  Nothing in this sprint blocks it, and nothing built here would be redesigned by it.

### W5 — Components as first-class visible objects

- **Distinct rendering** on canvas (W2) and **component cards** in the Library (W1).
- **Breadcrumb drill-down replaces the modal drawer:** "Enter component" navigates the *main
  canvas* into the component's internal graph, read-only, with a breadcrumb trail
  (`Strategy ▸ MomentumCore v1 ▸ …`) and Esc/click-to-return. Generalizes to arbitrary nesting
  depth; the modal drawer is removed. Read-only is correct, not a shortcut: definitions are
  immutable per version (ADR-0002); component *editing* remains deferred.
- **Extraction polish:** enable marquee/multi-select on canvas (currently disabled) so
  "select a subgraph → Extract component" is direct manipulation instead of click-toggling in a
  mode. The two-phase-commit extraction flow and dialog are kept as-is — they are already the
  strongest UX in the app.

### W6 — Design system & visual identity

- **Design tokens** as CSS custom properties (color, spacing, type scale, radii, elevation,
  motion durations) in one tokens file; component styles consume tokens only. Plain CSS stays —
  no Tailwind/CSS-in-JS, matching repo minimalism.
- **Dark theme as the default** (IDE convention; VS Code/Figma-adjacent), light theme retained
  via a token swap. Category and port-type colors specified for both themes with contrast
  checked.
- **Iconography:** one small inline-SVG icon set (stage categories, panel glyphs, actions) — no
  icon-font or external dependency.
- **Type & density:** monospace reserved for identifiers/numerics; a real type scale replaces
  the current uniform 0.72–0.85rem; canvas breathing room; subtle motion on panel/selection
  transitions.

### W7 — Arrival & the validation journey

- Home screen "Walk the journey" path mirrors README §4: load demo strategy → run backtest on
  the seeded dataset → open results → open trace → try extraction. Implemented as light
  contextual nudges (empty states, a dismissible checklist), **not** a modal tutorial engine.
- Purposeful empty states everywhere a list can be empty (no strategies, no runs, no dataset
  selected), each stating the next action.
- This workstream is the direct enabler of §13's success signals (backtest unassisted; explain
  trades from traces alone; attempt extraction unprompted).

## 5. Architectural boundaries (unchanged and load-bearing)

Every workstream is a **projection change**. The invariants that constrain all of it:

1. The persisted JSON IR remains the sole source of truth; the canvas stays a disposable derived
   view; all new visual state (positions already; nothing new needed) rides in `ui.*`, excluded
   from execution and semantic equality.
2. No numerical, portfolio, or compatibility logic enters the frontend. Validity badges, typed
   edges, and connection hints render **server-supplied** catalog data and diagnostics. The
   interactive chart maps server series to pixels and nothing more. The session cursor selects
   among server-supplied dates; the Data Source card composes server metadata and document
   params; the inspector "At session" section renders served trace/reconciliation facts —
   none of them compute anything.
3. `is_compatible` stays in Python; the editor keeps consuming the enumerated `compatibility[]`
   allow-list.
4. All new API surface is plain JSON DTOs; Pydantic → JSON Schema → generated TS types; codegen
   staleness gates apply to the extended catalog and new endpoints.
5. One engine, one evaluator, one node set. The engine-stage visualization is presentation of
   existing engine outputs; **no order-generation node exists or is implied**.
6. Registry, not switches: `category` and `doc` are descriptor metadata carried through the
   existing registration path.

## 6. Pressure tests against the long-term capability ceiling

Not built now; each must have a clean path through this design. Verified:

| Future capability | Where this design leaves the path |
|---|---|
| Linear/factor/volatility/risk models, regression, time-series models | New node types behind the registry under the reserved `statistics` category (token already assigned); open `category` set + generic doc-block rendering means they arrive with full palette/inspector/legibility support and zero frontend rework. |
| Probability distributions, uncertainty, probabilistic signals | New port types (e.g. `Distribution`) enter the data-driven type registry; port/edge coloring and the legend are driven by catalog `port_types[]`, not hard-coded. Doc block's extensible fields carry distributional assumptions. |
| Constrained portfolio optimization, objective functions | Optimizer nodes produce `PortfolioTargets` (existing seam, ADR-noted `Matrix` type path) under the reserved `optimization` category; a future "optimizer diagnostics" panel mounts in the W1 dock without IA change. |
| Monte Carlo, stochastic processes, random walks, mean reversion | Node types under the reserved `stochastic` category + possibly run-level modes; results/trace views are panel-mounted and per-run, so new artifact shapes get new panels, not a new shell. |
| Supervised/RL/inference nodes, model artifacts, feature pipelines, Qlib-style workflows, training/inference separation | Reserved `ml` category; `ComponentDefinition.implementation.kind` discriminator (`model`, `external`, `sandboxed` reserved) is already the seam; W5's breadcrumb navigation and the drawer's kind-gate generalize to non-graph implementations (an inspector view per kind). Model artifacts are registry/node metadata + future endpoints. |
| External model services, data APIs as compute | Reserved `external` category; service-backed nodes stay behind the registry contract, and the doc block's extensible fields carry service/latency/artifact facts into the same inspector. |
| Entry/exit logic, thresholds, ranking/selection, rebalancing, stops | Already representable as node families under the **live** `signal`/`selection`/`weighting` categories; W2/W3 make each new family legible by construction. |
| Order generation, transaction costs, execution policies | Engine-owned (invariant 2); the W4 engine-stage rendering and the §3 execution-mode frame are where richer policy/cost visualization accrues — presentation of engine output and run configuration, never graph nodes or palette categories. |
| Data APIs / broker / paper-live execution | MarketData/Broker adapter seams (ARCHITECTURE §7) untouched; the Data Source card's connector frame ("Uploaded dataset" today; *Data API · Broker feed — future*) and the W1 dataset chip are exactly where connected sources surface; the §3 mode frame already names Live as the deferred third mode; datasets stay content-addressed inputs. |
| Per-node data-flow visualization | Contract fixed in W4 (Node Value Tap: `node_id`, `component_path`, `session_date`, `output_port`, `value_summary`, `asset_values`/`series_preview`, `provenance`); the inspector "At session" section is its rendering slot and the session cursor its time axis; needs only engine-side capture + endpoint later. |
| Deep component hierarchies, reuse libraries, marketplace | Breadcrumb navigation is depth-agnostic; Library cards + provenance/pinning (existing) are the discovery substrate; marketplace remains a deferred path. |

## 7. Explicitly out of scope for this sprint

- Per-node output-series capture (engine/persistence change — the Node Value Tap **contract is
  designed in W4**; capture, storage, and the endpoint are a future sprint).
- Live/broker execution and any real-money affordance — the mode frame *names* Live as
  deferred; nothing is built behind it. Paper replay remains the existing forward mode.
- Undo/redo (feasible later via the pure-reducer store; candidate for the next UX sprint).
- Component editing/forking UI, version-upgrade flows (definitions stay immutable per version).
- Any new node types, indicators, or asset classes. No CSV parsing (upload stays JSON).
- Routing/deep-linking, multi-document tabs, collaboration.
- Chart or math-typesetting libraries; LaTeX rendering (field reserved, plain-text formulas v0).
- Run progress streaming/cancellation (runs stay synchronous).
- Any change to engine, evaluator, node implementations, IR semantics, or execution policy.

## 8. Founder decisions embedded in this design

Recorded here so review can veto them cheaply (details in the plan's Unresolved decisions):

1. **Dark theme default**, light retained. (IDE convention; flip is a token swap.)
2. **Modal component drawer is removed**, replaced by in-canvas breadcrumb navigation.
3. **Client-side trace grouping is deleted** in favor of the served trace tree.
4. **Undo/redo deferred** despite being IDE-typical — it is orthogonal to the reorientation and
   its CAS interactions deserve their own slice.
5. Datasets demoted from a co-equal bottom tab to strategy-bar chip + Home management view.
6. Plain-text/Unicode formulas now; LaTeX rendering deferred with the field reserved.
7. **Dataset introspection added to the API** (first/last session + asset tickers on dataset
   metadata) — a small additive read-only projection, required by the Data Source card's date
   range and universe cross-check. (Amendment 2026-07-06.)
8. **Session cursor is client state over server dates** — no new backend surface; absent
   without a selected run, cleared on run switch. (Amendment 2026-07-06.)
9. **Categories are authored machine-stage semantics, not `type_id` namespaces** (guardrail
   pass 2026-07-06 — namespaces cannot express the §3 stages; see the W2 assignment table and
   plan D-14). Eight live categories; **five reserved** (`optimization`, `stochastic`,
   `statistics`, `ml`, `external`) pre-assigned color tokens; execution policies deliberately
   not a category. (Amendment 2026-07-06, revised by the guardrail pass.)
