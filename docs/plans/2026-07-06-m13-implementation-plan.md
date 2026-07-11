# M13 — IDE Reorientation Sprint — Implementation Plan (2026-07-06)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Design record: `2026-07-06-m13-ide-reorientation-design.md` (read it first —
> this plan does not restate the *why*).
>
> **Founder amendment (2026-07-06) incorporated:** the sprint's bar is strategy-machine
> legibility, not IDE-themed polish. Changed by the amendment: Definition of done (headline
> 30-second criterion + five new checkboxes), Contracts (dataset introspection, session cursor,
> Node Value Tap future contract, reserved categories), decisions D-11…D-13, and slices
> **M13.1, M13.3, M13.4, M13.5, M13.7, M13.9** (each marked *[amended]*). M13.2, M13.6, M13.8
> are unchanged.
>
> **Pre-implementation guardrail pass (2026-07-06):** one blocking correction — `category` is
> **authored machine-stage semantics, not the `type_id` namespace** (namespaces cannot express
> the narrative stages: `portfolio.*` spans selection and weighting, `transform.rank` is
> ranking, `logic.greater_than` is a signal); `signal`/`selection`/`weighting` are live,
> reserved list is now five (D-14). Also: M13.1 test paths corrected to the real flat `tests/`
> layout; the stage strip's category→segment rollup made explicit; honest no-evaluation states
> (served `notes[]`) required at the cursor; Data Source card placeholder rule in read-only
> component views; `DatasetStored` fields noted as shared by upload + describe responses.

**Goal:** Reorient the M12 product experience from "graph-backed admin dashboard" to "visual
IDE for quantitative trading systems" — a legible *strategy machine*: canvas-first shell, a
first-class Data Source entry point, semantically legible nodes that narrate their role, node
math in the inspector, a session cursor + closed trace↔canvas↔results debugging loop, visible
composition, honest execution-mode framing, and a themed design system — with backend changes
limited to registry metadata and read-only projections.

**Architecture:** Every change is a projection change. The backend gains descriptor metadata
(`category` + `doc` on `NodeMetadata`, served via `/v1/node-types`) and one read endpoint
(`GET /v1/runs/{id}/trace-tree` exposing the existing `build_trace_trees`). The frontend is
restructured around the existing seams: `StrategyNode` as sole node renderer, `FlowNodeData`
enrichment, `HighlightTarget` addressing, conditional panel mounts, single-stylesheet theming.
No engine, evaluator, node-implementation, IR-semantics, or execution-policy changes.

**Tech stack:** unchanged — FastAPI + Pydantic (3.14), Vite + React 18 + `@xyflow/react` 12,
plain CSS, Vitest + Testing Library, pytest. **No new runtime dependencies, front or back.**

---

## Purpose & definition of done

M13 makes the product *feel like* the visual IDE the architecture already is, so that §13
founder-led validation (3–5 quant-literate testers walking the README journey unassisted) tests
the product thesis instead of a utilitarian dashboard.

**Done means (headline criterion first — the 30-second legibility test):**

- [ ] **A first-time quant-literate user opening the ETF Momentum Rotation demo can explain,
      within ~30 seconds and without documentation: (1) where data enters the machine, (2) what
      each major stage does, (3) how portfolio targets are produced, (4) how the engine turns
      targets into orders and fills, (5) where to inspect math, parameters, validation, and
      trace.** Operationalized as the scripted M13.9 closeout checklist; every box below serves
      it.
- [x] Every registered node type (12 core + `output.target_portfolio`) carries `category` and a
      populated `doc` block (**role-first summary** — opens with the node's plain-English role
      in the machine — plus formula where mathematical, semantics incl. missing-data rule and
      warm-up, per-parameter label/help), served by `/v1/node-types`, covered by tests.
      *(M13.5 — served by `/v1/node-types`; rendered in the Inspector Explanation.)*
- [x] `data`-category nodes render as a first-class **Data Source card**: source name + kind
      ("Uploaded dataset", with *Data API · Broker feed — future* connector labels), universe
      (from the connected `universe.*` node's params), calendar + date range (from dataset
      metadata), mode binding, and provenance (fingerprint) — with explicit unbound states.
      *(M13.1 — `DataSourceCard.tsx`; smoke-confirmed universe / calendar / fingerprint.)*
- [x] A **pipeline stage strip** above the canvas renders Data → Transforms → Signals →
      Rank & Select → Weighting & Risk → Targets → ⟨Engine⟩ via the fixed category→segment
      rollup (design W2/strip spec), with per-segment node counts and click-to-highlight;
      unknown/reserved categories roll into an "Advanced" bucket (never silently dropped),
      component instances appear as their own chip, and the Engine segment is visually outside
      the graph. *(M13.1 — `StageStrip.tsx`; smoke-confirmed the full segment rollup + counts.)*
- [x] A **global session cursor** (strategy-bar readout + prev/next stepping over the run's
      sessions) is set by chart hover/click and evaluation/fill rows, opens the trace at its
      session, and drives the inspector's "At session" section — client state over
      server-supplied dates only; absent without a run, cleared on run switch. *(M13.7)*
- [x] The inspector has an **"At session" section** rendering the selected node's served trace
      events (and reconciliation rows at the engine boundary) at the cursor — the designed slot
      for the future Node Value Tap (contract in this plan; **not implemented**). *(M13.7)*
- [x] Run controls carry the **execution-mode frame**: Backtest / Paper replay available,
      Live/broker explicitly labeled deferred, plus a persistent "all runs are simulations over
      local data" notice — no real-money implication anywhere.
      *(M13 — `RunPanel.tsx`: Backtest/Paper replay + disabled Live option + `rpanel__sim-notice`.)*
- [x] `GET /v1/runs/{run_id}/trace-tree` serves the hierarchical trace tree; the client-side
      grouper `web/src/trace/group.ts` is deleted; TraceView consumes the served tree.
      *(M13.6 — `quantize/api/dto/trace_tree.py`; `web/src/trace/group.ts` removed.)*
- [x] App opens to a Home screen (recent strategies, new strategy, "Walk the journey" demo
      entry); an open document shows a strategy bar (name · version · dirty · Validate/Run/Save
      · dataset chip) and a bottom dock (Problems / Runs / Results / Trace). Datasets are no
      longer a co-equal bottom tab. *(M13.3 — `Home.tsx` / `StrategyBar.tsx` / `Dock.tsx`.)*
- [x] Nodes render as category-colored, icon-bearing cards with a parameter summary line and a
      validity badge; handles/edges are colored by port type from catalog `port_types[]` with an
      on-canvas legend; ComponentRef instances are visually distinct with a version chip; the
      category color map ships tested token assignments for the eight live categories and the
      five reserved future categories (`optimization`, `stochastic`, `statistics`, `ml`,
      `external`) plus the neutral unknown-category fallback.
      *(M13.4 — `styles/tokens.css` + `tokens.test.ts` + `Legend.tsx`; smoke-confirmed.)*
- [x] Inspector shows an Explanation section (summary/formula/semantics/warm-up/ports) for the
      selected node; param controls use doc-block labels/help.
      *(M13.5 — `Inspector.explanation.test.tsx`; smoke-confirmed role-first sentence + formula.)*
- [x] Trace rows are clickable → select/center the node on canvas (into components via
      breadcrumb); equity chart is interactive (hover crosshair, click session → trace);
      evaluation/fill rows link to their session trace; engine output is grouped under an
      explicit "Engine" heading. *(M13.7 + M13.8: the in-component breadcrumb drill-down hook
      is closed — an in-component trace row now navigates the breadcrumb to the emitting node's
      nesting level.)*
- [x] Component drill-down is in-canvas breadcrumb navigation (read-only); the modal
      `ComponentDrawer` is removed; marquee multi-select feeds extraction.
- [ ] Dark theme (default) + light theme via design tokens; all styles consume tokens.
- [ ] Empty states + a dismissible journey checklist cover the README §4 path end-to-end.
- [ ] Full gate green (`./scripts/gate.ps1`); codegen artifacts regenerated and committed;
      README/LEARNING_LOG updated where the UI moved.

## Authoritative inputs

- `docs/plans/2026-07-06-m13-ide-reorientation-design.md` (the design this plan implements —
  including §5 boundaries, §6 pressure tests, §7 exclusions, §8 embedded founder decisions).
- `CLAUDE.md` invariants 1–11; `docs/PRODUCT.md` (journey), `docs/ARCHITECTURE.md` §2/§7,
  `docs/STRATEGY_LANGUAGE.md` (node semantics — source text for doc blocks), ADR-0001, ADR-0002.
- M11/M12 plans (`2026-07-04-m11-implementation-plan.md`, `2026-07-05-m12-implementation-plan.md`)
  for the editor decisions being superseded (D13 shell, E11 drawer) — supersessions are named
  here, not silent.

## Scope

- **Registry/descriptor:** `NodeMetadata.category` + `NodeMetadata.doc` (new `NodeDoc` model);
  authored content for all registered nodes.
- **API:** catalog DTO extension; dataset introspection fields (describe-time projection); new
  trace-tree endpoint + DTOs; codegen for both bundles.
- **Web shell:** Home screen, strategy bar (incl. cursor readout + mode framing + simulation
  notice), dock, Library rail, dataset chip/management view.
- **Web canvas:** node cards, Data Source card, pipeline stage strip, typed ports/edges +
  legend, ComponentRef rendering, minimap, quick-add, tooltips, marquee selection, breadcrumb
  component navigation.
- **Web inspection:** Explanation section (role-first), "At session" section (value-tap slot),
  session cursor, interactive results chart, trace↔canvas linking, engine-stage grouping.
- **Web design system:** tokens, dark/light themes, icon set, type scale, motion.
- **Docs:** README UI-path updates, LEARNING_LOG entry, plan closeout.

## Exclusions (with deferral targets)

- Per-node output-series capture (Node Value Tap) — engine/persistence work; the **contract is
  documented in this plan and the design (W4)**, the inspector slot ships, capture/endpoint do
  not; a future sprint.
- Live/broker execution and anything real-money — named as a deferred mode in the UI frame,
  zero capability built behind it; paper replay remains the existing forward mode.
- Undo/redo — next UX sprint candidate (pure-reducer store makes it tractable; CAS interactions
  need their own design).
- Component editing/forking/version-upgrade UI — deferred (ADR-0002 immutability stands).
- New node types, indicators, asset classes; CSV ingestion; routing/deep-links; run streaming or
  cancellation; chart/math-typesetting libraries (LaTeX field reserved, unrendered); any engine,
  evaluator, IR-semantics, or execution-policy change.

## Contracts & invariants

**`NodeDoc` (new, `quantize/registry/descriptor.py`):**

```python
class ParamDoc(BaseModel):        # frozen, like all descriptor models
    label: str                    # min_length 1
    help: str | None = None

class NodeDoc(BaseModel):
    summary: str                  # min_length 1; prose meaning of the node
    formula: str | None = None    # plain-text/Unicode math, e.g. "r_D = close(D)/close(D-L) - 1"
    latex: str | None = None      # RESERVED: carried, never rendered in M13
    semantics: str | None = None  # missing-data rule, alignment, warm-up prose (CLAUDE.md rule 10)
    parameters: dict[str, ParamDoc] = {}   # keys ⊆ parameter_schema properties (validated)
```

- `NodeMetadata` gains `category: str` (required; lowercase identifier `^[a-z][a-z0-9_]*$`;
  **open set** — no enum) and `doc: NodeDoc | None = None`.
- **`category` is authored machine-stage semantics, NOT the `type_id` namespace** (guardrail
  pass 2026-07-06 — namespaces cannot express the narrative stages). v0 assignment (D-14):
  `universe` ← universe.fixed_list; `data` ← data.price; `transform` ← trailing_return /
  moving_average / latest; `signal` ← logic.greater_than; `selection` ← transform.rank /
  portfolio.select_top_n; `weighting` ← portfolio.equal_weight / fixed_weight / apply_mask;
  `risk` ← risk.max_weight; `output` ← output.target_portfolio. `type_id`s and the IR are
  untouched.
- **Registration-time invariant (tested, not typed):** every node in `build_core_catalog()` has
  `doc is not None` and `doc.parameters` keys exactly matching its `parameter_schema` required +
  optional property names. `category` values match the D-14 assignment table exactly.
- **Catalog DTO (`quantize/api/dto/catalog.py`):** `NodeTypeDto` gains `category: str` and
  `doc: NodeDocDto | None` (mirror of `NodeDoc`). Additive and backward-compatible; `api_version`
  unchanged; `catalog_digest` changes as a consequence (clients cache-bust automatically — this
  is the digest doing its job, assert in a test).
- **Dataset introspection (additive, read-only):** `DatasetStored` (describe endpoint) gains
  `first_session: date`, `last_session: date`, and `asset_tickers: list[str]` (canonical
  ascending order), computed on describe from the stored payload — **no stored-format change,
  no migration** (D-11). List rows unchanged (metadata fetched on select, per the existing M11
  pattern). Consumed by the Data Source card and the strategy-bar dataset chip.
- **Session cursor (frontend contract, no backend surface):** one app-level
  `sessionCursor: date | null`, valid only while a run is selected, drawn exclusively from that
  run's server-supplied session dates (valuations/evaluations), cleared on run switch. Writers:
  chart click/hover-commit, evaluation/fill row clicks, prev/next stepper. Readers: strategy-bar
  readout, TraceView (opens filtered to it), inspector "At session" section. Never persisted
  into the document; never used to compute anything.
- **Node Value Tap (FUTURE — documented contract, zero implementation in M13):** reserved
  endpoint shape `GET /v1/runs/{run_id}/values?node_id=&component_path=&session_date=&output_port=`
  returning `{node_id, component_path, session_date, output_port, value_summary,
  asset_values? | series_preview?, provenance{run_id, dataset_fingerprint, captured}}`, with all
  summarization server-side. M13 obligations only: the inspector "At session" section is its
  rendering slot; trace/canvas addressing speaks `(node_id, component_path)`; the cursor
  supplies `session_date`; output handles are the `output_port` affordance. Any M13 change that
  would contradict this shape is a stop condition.
- **Reserved categories:** `web/src/catalog/colors.ts` defines tokens for `optimization`,
  `stochastic`, `statistics`, `ml`, `external` in addition to the eight live categories
  (`universe`, `data`, `transform`, `signal`, `selection`, `weighting`, `risk`, `output`) and
  the neutral fallback. Execution policies are **not** a category (engine-side configuration
  only).
- **Stage-strip rollup (frontend display grouping, fixed):** Data ← {universe, data};
  Transforms ← {transform}; Signals ← {signal}; Rank & Select ← {selection};
  Weighting & Risk ← {weighting, risk}; Targets ← {output}; ⟨Engine⟩ ← no category.
  Unmatched categories → appended "Advanced" bucket; component instances excluded from segment
  counts, shown as a "Components" chip.
- **Trace-tree endpoint:** `GET /v1/runs/{run_id}/trace-tree?session_date=` →
  `TraceTreeResponse{trees: list[TraceTreeDto]}` where `TraceTreeDto`/`TraceTreeNodeDto` mirror
  `quantize/tracing/tree.py` structures (instant, engine events, per-node events, children keyed
  by component path segment). Deterministic ordering (same as `build_trace_trees`); 404 on
  unknown run id; `session_date` filter semantics identical to the flat endpoint. The flat
  `/trace` endpoint is retained unchanged (raw stream remains available).
- **Frontend contracts:** category→color and port-type→color maps live in one module keyed by
  *server-supplied* identifiers with a neutral fallback for unknown keys (future node families
  render sanely with zero changes). Validity badges render only the most recent
  `ValidateResponse` and are cleared on any semantic document mutation (see Unresolved D-7).
  The interactive chart performs pixel mapping only — every displayed number comes verbatim
  from server fields (no client-side derivation; existing D9 rule extended, not relaxed).
- **Unchanged and load-bearing:** IR schema and `schema_version`; `ui.*` round-trip/exclusion
  semantics; `is_compatible` server-side with the enumerated allow-list; single engine; graph
  terminates at `output.target_portfolio`; generated `.d.ts` never hand-edited.

## Unresolved decisions

Design §8 decisions 1–6 (dark default; drawer removed; client grouper deleted; undo/redo
deferred; datasets demoted; plain-text formulas) are **plan-of-record unless the founder vetoes
before the consuming slice starts**. Additional implementation-level defaults, same rule:

- **D-7 Validity-badge staleness:** badges clear on any semantic doc change (mutation through
  the store that alters `semantic_projection`), shown as "not yet validated" — never a stale
  green. Alternative (persist with a "stale" marker) rejected for v0 as it invites trusting old
  results.
- **D-8 Trace-tree payload size:** no pagination in M13; the existing `session_date` filter is
  the size control (matches flat endpoint). Revisit only if a real run demonstrates a problem.
- **D-9 Icons:** ~10 hand-authored inline SVG glyphs (one per category + panel/action glyphs),
  no icon library.
- **D-10 Home-vs-editor state:** plain app state (no router). Deep-linking stays deferred.
- **D-11 Dataset introspection cost:** `first_session`/`last_session`/`asset_tickers` computed
  on describe by decoding the stored payload (local single-user; acceptable). Rejected for v0:
  storing them at upload (migration) — revisit only if describe is measurably slow.
- **D-12 Cursor default:** selecting a run sets the cursor to the run's **last** session (the
  most-recent decision is the most interesting); founder may prefer first.
- **D-13 Role-sentence voice:** doc summaries open with the node's role *for the machine*
  ("Measures… — the raw signal this strategy ranks on"), audience quant-literate non-programmer;
  enforced by the metadata audit, not a schema rule.
- **D-14 Category assignment table** (see Contracts): authored stage semantics decoupled from
  `type_id` namespaces. Most veto-able call: `transform.rank` → `selection` (ranking exists to
  order the cross-section for selection; the founder may prefer `signal` or `transform`).
  Changing an assignment is a one-line registry edit + test update — cheap to revisit.

## Implementation slices

> One branch/worktree for the sprint (`feat/m13-ide-reorientation`), one commit (or a few) per
> slice, test-first within each slice. Later slices assume earlier ones are green. Web tests run
> with `npm --prefix web run test`; backend with `pytest`; the full gate before any done-claim.
> Slices M13.2–M13.5 are frontend-only and may be reordered/parallelized if it helps review;
> M13.1 must land first (types flow from codegen), and M13.6 must precede M13.7.

### M13.1 — Registry doc metadata + catalog & dataset projections (backend) *[amended]*

**Files:** modify `quantize/registry/descriptor.py` (NodeDoc/ParamDoc, NodeMetadata fields),
`quantize/nodes/*.py` (author category + doc for all 13 registrations — **role-first summaries
per D-13**; source text from evaluate docstrings + `docs/STRATEGY_LANGUAGE.md`),
`quantize/api/dto/catalog.py`, `quantize/registry/export.py`; dataset introspection:
`quantize/api/dto/datasets.py` (`DatasetStored` additive fields), `quantize/api/routes/datasets.py`
+ `quantize/persistence/datasets.py` (describe-time computation from the stored payload — no
schema/migration change; the fields are additive-optional on the shared `DatasetStored` DTO, so
both the upload response and describe serve them — do not fork the DTO); regenerate codegen
bundles (`schema/quantize-api.schema.json`, `ts/quantize-api.d.ts`). Tests (flat `tests/`
layout — there is no `tests/registry/` package): `tests/test_registry_descriptor.py`,
`tests/test_nodes_descriptors.py` (doc/category completeness over `build_core_catalog()`),
`tests/api/test_catalog_endpoint.py`, `tests/api/test_dataset_upload.py`,
`tests/api/test_dataset_list.py`.

**Acceptance (write first, watch fail):**
- Descriptor validation: empty `summary` rejected; bad `category` pattern rejected;
  `doc.parameters` key not present in `parameter_schema` rejected.
- Completeness: parametrized over `build_core_catalog()` — every node has non-None `doc`,
  non-empty `summary`, `category` matching the D-14 assignment table exactly (asserted as a
  literal table in the test, so any drift is a reviewed diff), and `doc.parameters`
  covering every parameter (e.g. `transform.trailing_return` documents `lookback_sessions`).
- Mathematical nodes (`transform.*`, `risk.max_weight`, `portfolio.equal_weight/fixed_weight`)
  have non-None `formula`; nodes with an explicit missing-data rule (`logic.greater_than`,
  `transform.*`) have non-None `semantics`.
- API: `/v1/node-types` response carries `category` + `doc` per type; `catalog_digest` differs
  from a catalog without docs (digest covers the new fields).
- Datasets: describe returns `first_session` ≤ `last_session` matching the uploaded calendar's
  bounds and `asset_tickers` in canonical ascending order for a known fixture; list rows
  unchanged; upload/idempotency behavior byte-identical to M12 (existing tests prove it).
- `python -m quantize.codegen check` green after regeneration; `npm run typecheck` green.

**Green:** pytest + codegen check + typecheck pass; no other endpoint's behavior changes; the
role-sentence audit (self-review) has a written pass over all 13 summaries.

### M13.2 — Design tokens + theming (web)

**Files:** create `web/src/styles/tokens.css` (custom properties: color primitives + semantic
roles, category colors, port-type colors, spacing, type scale, radii, elevation, motion) with
`:root` (dark, default) and `[data-theme="light"]` blocks; refactor `web/src/App.css` to consume
tokens only (no raw hex outside tokens.css); add a theme toggle in the header; persist choice in
`localStorage`. Tests: `web/src/styles/tokens.test.ts` (parse tokens.css: every category/port
color defined in both themes; no hex literals left in App.css — a lint-style test), existing
component tests stay green.

**Green:** `npm --prefix web run test` + typecheck; visual smoke in both themes via `npm run
dev` (manual, noted in commit message).

### M13.3 — IDE shell: Home, strategy bar, dock, mode framing (web) *[amended]*

**Files:** modify `web/src/App.tsx` (Home-vs-editor state, layout); create
`web/src/components/Home.tsx`, `web/src/components/StrategyBar.tsx`,
`web/src/components/Dock.tsx`; modify `StrategyPanel`/`DatasetPanel` usage (strategies list →
Home; datasets → Home management view + strategy-bar chip); rename ValidatePanel presentation to
the dock's **Problems** panel (component may keep its file); modify `web/src/components/Palette.tsx`
+ `web/src/catalog/index.ts` (**Library rail**: `paletteGroups` regrouped by served `category` in
stage-rollup order — not `type_id` namespace, not alphabetical — unknown categories appended;
Components section upgraded to cards with name, version, exposed-port summary). Tests:
`Home.test.tsx`, `StrategyBar.test.tsx`, `Dock.test.tsx`, updated `Palette.test.tsx` +
`catalog/index.test.ts` (group order = stage order; unknown category appended), updated
`App.shell.test.tsx`.

**Acceptance:** app with no open document renders Home (recent strategies from
`GET /v1/strategies`, New strategy, journey card); opening/creating a strategy switches to the
editor with strategy bar (name, version, dirty indicator, Validate/Run/Save buttons wired to the
existing handlers, dataset chip showing the active dataset — enriched with date range from the
M13.1 introspection fields — or "none — choose", and a session-cursor readout slot that renders
empty until M13.7 wires it); dock tabs are Problems/Runs/Results/Trace with the existing panels
mounted; the old `strategies`/`datasets` bottom tabs are gone; selecting a run still auto-opens
Results. **Mode framing:** the run controls (RunPanel) present Backtest / Paper replay / Live as
the machine's operating modes — Backtest and Paper replay map to the existing backtest/forward
endpoints, Live renders as an explicitly deferred label (no dead button pretending to work) —
and a persistent "All runs are simulations over local data — no live trading" notice is visible
wherever runs are launched (asserted in `RunPanel` tests).

**Green:** all web tests; the M12 journey (load → run → results → trace → extract) still
completable manually.

### M13.4 — Node & graph legibility: cards, Data Source, stage strip (web) *[amended]*

**Files:** modify `web/src/document/flow.ts` (enrich `FlowNodeData` with category, paramSummary,
validity, portTypes), `web/src/components/Canvas.tsx` (`StrategyNode` card rendering, **Data
Source card variant for `data`-category nodes**, typed `Handle` colors, edge styling by carried
port type, `<MiniMap/>`, double-click quick-add menu with fuzzy catalog search, hover tooltip,
ComponentRef card variant + version chip); create `web/src/catalog/colors.ts` (category/port-type
→ token maps for the eight live categories, **five reserved future-category tokens**, neutral
fallback),
`web/src/components/DataSourceCard.tsx`, `web/src/components/StageStrip.tsx`,
`web/src/components/QuickAdd.tsx`, `web/src/components/Legend.tsx`, `web/src/icons/` (inline SVG
set). Tests: `flow.test.ts` (enrichment incl. param summary formatting and unknown-category
fallback), `Canvas.test.tsx` (card renders category class/icon/summary/badge; edge gets
port-type class; component node gets variant + chip), `DataSourceCard.test.tsx`,
`StageStrip.test.tsx`, `QuickAdd.test.tsx` (fuzzy filter, add at position, Esc closes),
`colors.test.ts` (reserved categories resolve to distinct tokens; unknown → neutral).

**Acceptance:** every catalog node renders with its category color/icon and a parameter summary
(`lookback = 63`); unknown category renders neutral and each reserved category renders its
assigned token (synthetic catalog entries); handles/edges carry port-type colors sourced from
catalog `port_types[]`; legend lists exactly the catalog's port types; validity badge appears
after a validation response and clears on doc mutation (D-7); minimap present; double-click
opens quick-add. **Data Source card:** a `data.price` node bound to the demo dataset shows
source name/kind ("Uploaded dataset" + *Data API · Broker feed — future* labels), universe
tickers read from the connected `universe.fixed_list` params, calendar + first/last session from
dataset metadata, and the fingerprint; with no dataset selected it shows the explicit unbound
state; with no universe connected — or when rendered inside a read-only component view where
the binding is not resolvable — it says so with the same explicit placeholders (all fields are
served metadata or document params — asserted no other data source). **Stage strip:** renders
the six graph segments + distinct Engine segment via the fixed category→segment rollup
(Contracts) with correct per-segment counts for the demo strategy; a synthetic reserved-category
node lands in the "Advanced" bucket (never dropped); a ComponentRef is excluded from segment
counts and appears in the "Components" chip; clicking a segment highlights its nodes; Engine
segment does not claim graph membership (distinct styling + links toward Results/Trace).

**Green:** all web tests; connection-rejection banner behavior unchanged (existing tests).

### M13.5 — Inspector: Explanation section (web) *[amended]*

**Files:** modify `web/src/components/Inspector.tsx` (sections: Parameters / Explanation /
Ports, plus an **"At session" section shell** — heading + "run a strategy and select a session
to inspect this node's last-run behavior" empty state — wired to live data in M13.7; this is the
Node Value Tap rendering slot and must not need relayout when values arrive),
`web/src/components/ParamForm.tsx` (labels/help from `doc.parameters`, fallback to property key
when absent). Tests: `Inspector.test.tsx` (doc-bearing node shows the **role sentence first**,
then formula/semantics/warm-up and port list; doc-less node shows description fallback without
crashing; "At session" shell renders its empty state), `ParamForm.test.tsx` (label/help
rendering + fallback).

**Green:** all web tests; raw-JSON param fallback path untouched and still tested.

### M13.6 — Trace-tree endpoint (backend) + client adoption (web)

**Files:** create `quantize/api/dto/trace_tree.py`, route in `quantize/api/routes/runs.py`
(serialize `build_trace_trees` output); regenerate codegen. Web: extend `web/src/api/client.ts`
(`getTraceTree`), rewrite `web/src/components/TraceView.tsx` over the served tree, **delete
`web/src/trace/group.ts` + its tests**. Tests: `tests/api/test_trace_tree.py` (tree matches
`build_trace_trees` for a golden run; `session_date` filter; 404 unknown run; deterministic
repeated-call equality), `TraceView.test.tsx` rewritten against served-tree fixtures.

**Acceptance:** for the seeded demo run, the endpoint's tree is structurally equal to calling
`build_trace_trees` on the stored flat events (same instants, same component nesting, same
engine/node event split); TraceView renders identically-nested output from the endpoint; no
client-side grouping code remains.

**Green:** pytest + codegen check + web tests; flat `/trace` endpoint untouched (existing tests
prove it).

### M13.7 — Debug-loop UX: session cursor, trace↔canvas, interactive results, engine stage (web) *[amended]*

**Files:** modify `App.tsx` (**`sessionCursor` state per the contract** — set to the run's last
session on run select (D-12), cleared on run switch, plus cross-panel navigation state),
`StrategyBar.tsx` (cursor readout + ◀/▶ stepper over the run's session dates, with evaluated
sessions visually distinguished from warm-up/no-eval sessions),
`TraceView.tsx` (opens at the cursor's session; rows clickable → `HighlightTarget`-style
callback; rows inside components trigger breadcrumb navigation once M13.8 lands — until then,
select the ComponentRef node), `web/src/components/ResultsView.tsx` + `SvgLineChart.tsx` (hover
crosshair with server date/value, click session → set cursor + open Trace; evaluation/fill rows
→ set cursor + session trace; "Engine" grouping for reconciliation rows and `engine.*` events,
framed as the downstream half of the machine: targets → orders → fills), `Inspector.tsx` (wire
the M13.5 "At session" shell: selected node's trace events at the cursor's instant from the
served tree; reconciliation rows when the terminal node is selected). Tests: `App.cursor.test.tsx`
(cursor set on run select per D-12, cleared on run switch, stepper bounds), `TraceView.test.tsx`
(opens at cursor; click row → callback with node id/component path), `ResultsView.test.tsx`
(click chart/evaluation → cursor set + trace-navigation callback with session date; engine
grouping present), `SvgLineChart.test.tsx` (crosshair shows the server-provided point value
verbatim — no derived numbers), `Inspector.test.tsx` ("At session" renders the node's served
events at the cursor; empty state when the node emitted nothing that session).

**Acceptance:** one cursor drives everything — chart, evaluation rows, trace, stepper, and the
inspector's "At session" section move together; clicking a trace row selects/centers the
emitting node on canvas; every number shown anywhere is a value already present in the run
record or trace (no client derivation). **Honest no-evaluation states:** stepping the cursor
onto a session without an evaluation shows the run record's served `notes[]` reason when one
exists ("no evaluation this session: warm-up") in the "At session" section and trace view —
never an unexplained blank (asserted in `Inspector.test.tsx`/`TraceView.test.tsx` with a
warm-up-session fixture); the stepper visually distinguishes evaluated sessions.

**Green:** all web tests.

### M13.8 — Component navigation + extraction polish (web)

**Files:** modify `Canvas.tsx` (read-only breadcrumb navigation mode reusing `toFlow` over a
`ComponentDefinition`, arbitrary depth; marquee selection enabled — `selectionKeyCode` restored
— feeding the existing extraction selection set), create
`web/src/components/Breadcrumb.tsx`; **delete `web/src/components/ComponentDrawer.tsx`** (its
`implementation.kind` gate moves into the navigation entry point); modify `Inspector.tsx`
("Inspect internals" → "Enter component"). Tests: `Canvas.navigation.test.tsx` (enter → read-only
graph + breadcrumb `Strategy ▸ Name vX`; nested ref → deeper crumb; Esc/crumb-click returns;
editing affordances absent in component view), `Canvas.selection.test.tsx` updated for marquee →
extraction, `ExtractDialog` tests stay green (flow unchanged).

**Acceptance:** entering a component navigates the main canvas (no modal anywhere); nesting
recurses to arbitrary depth with a correct trail; extraction works from a marquee selection;
non-`graph` implementation kinds show the explanatory notice (gate preserved).

**Green:** all web tests.

### M13.9 — Arrival, journey, legibility test, closeout (web + docs) *[amended]*

**Files:** create `web/src/components/JourneyChecklist.tsx` (dismissible; steps mirror README §4:
load demo → run backtest → open results → open trace → extract; step completion inferred from
app state, persisted in `localStorage`); empty states for Home/Runs/Results/Problems/dataset
chip; modify `README.md` (§4 click-path updated to the new shell), `docs/LEARNING_LOG.md`
(entry per closeout), this plan (closeout notes). Tests: `JourneyChecklist.test.tsx`
(steps tick from state; dismiss persists), empty-state assertions in the relevant panel tests.

**Acceptance:** a fresh profile (empty localStorage, seeded DB) can complete the full journey
guided only by Home + checklist + empty states; README instructions match the shipped UI.
**The 30-second legibility test** is executed as a scripted checklist against the open ETF
Momentum Rotation demo and each answer's on-screen source is recorded: (1) *where data enters* —
the Data Source card + stage strip's Data segment; (2) *what each stage does* — stage strip +
category-colored cards + one-click role sentences; (3) *how targets are produced* — the
Weighting/Risk → Targets path terminating at `output.target_portfolio`; (4) *how the engine
produces orders/fills* — the Engine segment + Results/Trace Engine grouping + mode framing;
(5) *where to inspect math/parameters/validation/trace* — Inspector Explanation, ParamForm,
Problems panel, Trace panel. Any question whose answer is not discoverable from the default
demo view (± one click) is a closeout blocker, not a nice-to-have. The same checklist becomes
the first instrument handed to §13 validation testers.

**Green:** full gate (`./scripts/gate.ps1`) from a clean checkout state; manual journey
walkthrough + legibility checklist completed and reported with actual observations.

## Test blueprint

- **Correctness:** doc-block completeness parametrized over the registry (M13.1); trace-tree
  structural equality vs `build_trace_trees` on a golden run (M13.6); param-summary formatting
  hand-specified per node type (M13.4).
- **Boundaries/invalid:** descriptor validation rejections (empty summary, bad category, orphan
  param doc); unknown-category and unknown-port-type fallbacks (M13.4); doc-less node in
  Inspector (M13.5); 404 trace-tree (M13.6).
- **Determinism:** trace-tree repeated-call equality; catalog digest stability across identical
  registries and change on doc edits (M13.1).
- **No-client-numerics guardrail:** chart/crosshair tests assert displayed values are verbatim
  server fields (M13.7); Data Source card fields assert served-metadata/document-param
  provenance only (M13.4); tokens test forbids raw hex outside tokens.css (M13.2).
- **Cursor contract:** set-on-run-select (D-12), cleared-on-run-switch, stepper bounded by the
  run's session list, absent without a run, never written into the document (M13.7).
- **Ceiling absorption:** synthetic catalog entries under reserved categories
  (`optimization`/`stochastic`/`statistics`/`ml`/`external`) render palette, card, stage strip
  ("Advanced" bucket), and inspector doc block with zero code changes (M13.4/M13.5); truly
  unknown category falls back neutral.
- **Regression:** all M11/M12 web tests kept green through every slice — the reorientation must
  not change document semantics, extraction safety, or connection gating; deleted modules
  (`trace/group.ts`, `ComponentDrawer.tsx`) take their tests with them only when replacement
  coverage exists in the same slice.
- **Failure paths:** validation-badge clearing on mutation (D-7); journey checklist with API
  errors (steps stay unticked, no crash).

## Stop conditions

Beyond CLAUDE.md's standing invariants:

- Any need to change the **IR schema or `schema_version`** to deliver a workstream (descriptor
  metadata must suffice) — stop, founder decision.
- Any need to change **`trace_format`/`record_format`** or stored run records for the trace-tree
  endpoint (it must be a pure projection of existing events) — stop.
- Any temptation to compute a number client-side for the interactive chart (e.g. per-session
  drawdown series) — stop; either drop the feature or bring a server-side field proposal to the
  founder.
- Dataset introspection turning out to require a stored-format change or migration (it must be
  a describe-time projection of the existing payload) — stop.
- Any M13 change that would contradict the documented Node Value Tap contract shape (a slot
  that couldn't render it, an addressing scheme that couldn't request it) — stop and re-design
  the slot, not the contract.
- Any UI copy or affordance that could be read as live/real-money trading being available —
  stop; the mode frame names Live only as deferred.
- The founder vetoes any of design §8 D-1…D-9 or plan D-7…D-13 — halt the consuming slice.

## Verification

`./scripts/gate.ps1` end-to-end (pytest, ruff, format, mypy, Node-24 activation, codegen check,
`npm run typecheck`, web typecheck, web test) after every slice and before any done-claim, plus:
regenerated codegen artifacts committed with the slice that changes contracts (M13.1, M13.6);
manual dark/light smoke (M13.2); manual full-journey walkthrough on a fresh profile with the
seeded demo (M13.9) reported with actual observed behavior, per CLAUDE.md's "never claim
something works because code was written."

## Self-review areas

- **Boundary audit:** grep the web diff for any numeric derivation, compatibility judgment, or
  validation logic — the frontend must only have rearranged *presentation* of server data.
- **Metadata audit:** doc-block prose vs `STRATEGY_LANGUAGE.md` — no semantic drift between the
  served docs and the normative spec (the spec remains normative); plus the **role-sentence
  audit** (D-13): every summary opens with the node's plain-English role for the machine,
  readable by a quant-literate non-programmer.
- **Honesty audit:** sweep all new UI copy for anything implying live/real-money capability;
  the simulation notice is present at every run-launch surface.
- **Supersession hygiene:** M11 D13 (shell) and M12 E11 (drawer) are explicitly superseded here;
  confirm no other M11/M12 decision was silently contradicted.
- **Determinism/order:** trace-tree serialization ordering; catalog digest coverage of new
  fields.
- **Test quality:** deleted-module coverage replaced in-slice; no test asserts on styling
  details that tokens legitimately change.

## Closeout

- LEARNING_LOG entry: descriptor-driven UI metadata (registry as single home for node meaning),
  projection-only API growth, design tokens/theming, and the trace-tree exposure — with files
  studied and one hand exercise (suggest: author the `doc` block for one node by hand from its
  docstring, then predict the Inspector rendering before running it).
- Final report: per-slice test counts (real numbers), invariant→test mapping, known limitations
  (no per-node values, no undo/redo, no deep links), deferred-work register updated, and the
  §13 validation phase re-armed: the journey is now walked in the reoriented product.
