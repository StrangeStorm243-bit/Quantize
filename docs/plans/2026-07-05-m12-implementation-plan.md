# M12 — Component Authoring/Extraction UI + MVP Closeout — Implementation Plan (2026-07-05)

> Plan-of-record for M12, authored by the planning session (no production code written).
> **For the implementer (Opus):** execute the slices per §9/§10 (ordering + ownership); each is
> test-first and independently green. Decisions in §4 are RESOLVED — do not re-derive them.
> M11's ratified frontend decisions D1–D13 (docs/plans/2026-07-04-m11-implementation-plan.md §4)
> REMAIN BINDING; this plan's decisions are numbered E1+ to avoid collision.

## 1. Baseline (verified 2026-07-05)

- `origin/main` = `0f19f4a` (merge of PR #14, M11 editor) — **M11 is merged**. Working tree clean.
- Tests at M11 close: **875 Python (pytest) + 122 web (vitest)**; both gates green
  (`./scripts/gate.ps1` / `bash scripts/gate.sh`: pytest → ruff → format → mypy → node24 →
  codegen check → tsc → web typecheck → web test). Python 3.14 (`.venv/Scripts/python.exe`),
  Node 24 (`./scripts/node24.ps1` first in any Node shell).
- Backend: `quantize/{schema,validation,registry,compatibility,nodes,runtime,components,
  evaluator,engine,market,tracing,persistence,codegen,api}`. 16 endpoints under `/v1`.
- Frontend: `web/` (Vite React TS; react, react-dom, @xyflow/react only) — see M11 plan §5.
- Generated contracts: `schema/quantize{,-api}.schema.json` + `ts/quantize-{ir,api}.d.ts`.
  `ComponentDefinition` is already an IR root in both the schema bundle and generated TS.
- **M12 roadmap text (docs/MVP_PLAN.md:269-278, verbatim):** "Component authoring/extraction UI
  (separate from M3 component runtime). Objective: Reuse a connected subgraph as a real,
  versioned component, in the editor. ✅ Select a connected subgraph → convert to a
  `ComponentDefinition` → name it → expose ports/params → reuse it via a pinned `ComponentRef`.
  ✅ Recursion rejected clearly in the UI; collapse/expand; traces preserve component hierarchy
  (runtime already from M3). Dependencies: M3, M11. Risks: ⚠ extraction edge cases (mitigate:
  rely on M3 runtime + tests)."
- **M12 is the FINAL milestone**: cross-cutting acceptance (MVP_PLAN.md:282-290) defines
  MVP-done. No post-M12 validation phase exists anywhere in docs/ (verified by grep) — §13's
  handoff paragraph is new plan-authored content.

## 2. M12 definition

**User-visible outcome:** after M12, a user can select a connected subgraph on the canvas, turn
it into a named, versioned, reusable component (choosing exposed ports and parameters), have the
strategy rewritten to use it via a pinned reference — with identical run results — then reuse
that component from the palette in any strategy, inspect its internals read-only, edit its
exposed parameters per instance, and see component-nested decision traces. Additionally, a new
user can go from clone → running backtest by following the README (seed script provides the
demo dataset + reference strategies).

**Done means:**
- The full extraction journey (§3) works end-to-end against the real API on localhost.
- Componentized strategies **validate and run over HTTP** (the ComponentCatalog wiring gap is
  closed): the run-faithful validate endpoint surfaces component/recursion diagnostics
  (`component_direct_recursion`, `component_cycle`, `component_definition_unavailable`,
  exposed-port/param codes) and API-submitted backtest/forward runs of componentized strategies
  succeed with results equal to their flat equivalents (test-pinned).
- Extraction is proven against the in-repo oracle: extracting Strategy A's momentum subgraph
  reproduces `tests/fixtures/component_momentum.json` + `strategy_a_component.json` modulo
  minted ids, and the extracted strategy's run equals the flat run.
- ComponentRefNodes render with real names/ports; connections to them are compatibility-gated;
  exposed params are editable via the existing ParamForm; a read-only detail view shows a
  component's internal graph; traces nest by component in TraceView (already built — verified
  live).
- MVP closeout: `scripts/seed_demo.py` + rewritten README (quickstart, scope & caveats, honest
  claims, pointer to the documented custom-node path); LEARNING_LOG M12 entry; the manual
  browser walkthrough of the FULL journey (M11's open item + M12 additions) executed and
  recorded; cross-cutting acceptance checklist audited in the closeout; both gates green.

**What M12 adds beyond M11:** component authoring (extraction), component reuse (palette
placement + instance params + detail view), HTTP-reachable component validation/execution, and
product-readiness (onboarding + honest documentation). M11 delivered everything else.

**Exclusions (intentionally absent, with owner):** component EDITING (open/modify a
ComponentDefinition as a document; definitions are immutable per version) → post-MVP. Version
unpin/upgrade flows, component search/tags, forking UI → post-MVP. Marketplace/discovery/social
→ globally deferred. Client-side recursion/cycle detection → server owns it (M3). In-canvas
literal expansion (subflows) → post-MVP; M12 ships the read-only drawer. Auth, Docker, deploy,
CORS, production serving, Playwright/browser-automation e2e → out (policy: e2e = headless
pytest, CLAUDE.md:128; M11 D11). A per-component versions-list endpoint → not needed (client
filters the flat list). Undo/redo → post-MVP (extraction safety comes from the two-phase
commit, E5). New DTOs/codegen artifacts/migrations → none needed (verified).

**MVP posture (the ten questions):**
1. *Product after M12:* a local, single-user, browser-based visual quant-strategy environment —
   build/validate/version strategies from typed nodes AND reusable components, run deterministic
   backtests + forward replays on uploaded daily-bar data, and inspect results + hierarchical
   decision traces.
2. *Proven workflow:* §3, end to end, including component extraction/reuse with run-equivalence.
3. *Beyond M11:* see above.
4. *Intentionally absent:* the exclusions above + globally deferred list (MVP_PLAN.md:292-298).
5. *Stable before external users:* the IR schema (versioned, published), the API contracts
   (codegen-governed), determinism/goldens, the honest README. These are already stable; M12
   adds no breaking change to any of them.
6. *Acceptable debt:* the four M11-review PLAUSIBLE items (blunt highlight-clear, useFetch
   skip-mode, parseFiniteNumber home, dataset-list reload flash) — all audited as
   safe/cosmetic; fix only if a slice touches that code anyway.
7. *Unacceptable debt:* anything violating trust surfaces — wrong numbers, silent document
   corruption, prose-parsed diagnostics. None exists; extraction (the first destructive
   multi-entity rewrite) must not introduce one — hence E5's two-phase commit + oracle tests.
8. *Handoff:* §13 (product-validation paragraph).
9. *Honest claims:* one IR runs identically in backtest & forward replay (test-proven);
   every decision is explainable via structured hierarchical traces; backtests are
   deterministic and golden-pinned; strategies/components are real versioned objects
   (components compositional at runtime, not visual groups); invalid strategies fail loudly
   with structured, UI-highlighted diagnostics.
10. *Claims to avoid:* live trading/brokerage/real money; real or current market data; that
    backtest results predict real performance; that custom Python/math/ML nodes exist (a
    documented path only); multi-user/hosted/secured operation.

## 3. Final MVP user journey (the E2E acceptance narrative)

launch (uvicorn + `npm run dev`) → README quickstart → `python scripts/seed_demo.py` (demo
dataset + Strategies A/B saved) → load Strategy A → canvas shows the graph → **enter extraction
mode** → click the momentum-selection nodes (**ret, rk, sel** — an App-owned selection set
highlights them) → "Extract component" → dialog: name "Momentum", exposed port names prefilled
(identifier-checked; here `series`, `universe` in, `assets` out), opt-in exposed params (e.g.
`lookback_sessions` on ret; `n` on sel) → confirm → component POSTed
(201) → rewritten strategy server-validated (`ok:true`) → canvas now shows a "Momentum" node
with typed ports, pinned `component_refs` entry → save strategy as new version → run backtest →
**results identical to the pre-extraction run** → trace: momentum decisions nested under the
component instance → palette "Components" section lists Momentum v1.0.0 → drag a second instance
into a new strategy → connect (compatibility-gated via its exposed port types) → edit its
exposed param in the Inspector (same ParamForm) → open the read-only detail drawer to inspect
its internal graph → validate/run/trace as any strategy. Recursion/missing-component faults
(from hand-loaded documents) surface in ValidatePanel with machine codes.

## 4. Ratified decisions — DO NOT REOPEN

| # | Decision | Selected contract | Evidence / reason | Consequence |
|---|---|---|---|---|
| E1 | **Backend gap closure (the one backend slice):** wire a `ComponentRepository`-backed `ComponentCatalog` into the validate route AND both run paths | In `quantize/api/service.py`: a helper that BFS-fetches the pinned closure starting from `document.component_refs` via `ComponentRepository.load`, filling a `ComponentCatalog`; a missing definition is simply absent (resolve emits `component_definition_unavailable` — fail-loud preserved). `routes/validate.py` passes it to `run_document_preflight(components=...)`; `execute_backtest_run`/`execute_forward_run` pass it to the engine. NO new endpoint, NO DTO change, NO migration. | R1+R2 both found it: `validate.py:34` and `service.py` pass no catalog; library (`preflight.py:201-203`, `engine/backtest.py:432`) already accepts one. Without this, the M12 journey dead-ends at "reuse". | Componentized strategies become first-class over HTTP; ValidatePanel surfaces recursion codes with zero frontend change. |
| E2 | **Subgraph selection = App-owned set** (extraction mode) | `extractionMode: boolean` + `extractionSelection: Set<string>` in App; `onNodeClick` toggles membership while active; Canvas gains optional `selectedNodeIds?: ReadonlySet<string>` and `project()` generalizes `selected: selectedNodeIds?.has(n.id) ?? n.id === selectedNodeId`; `deleteKeyCode={null}` while the mode is active (a Backspace must not delete the highlighted set). RF multi-select STAYS disabled (M11.10). | App-owned selection survives every re-seed by construction (Canvas re-derives RF state from props); re-enabling RF multi-select would re-litigate M11.10 and re-arm the group-delete hazard. | ~10 lines of Canvas change; no new interaction machinery. |
| E3 | **Extraction = a pure document transformation** in `web/src/document/extract.ts` | `extractComponent(doc, selectedNodeIds, opts) → {definition, strategy}` — a reducer-family member (pure, structuredClone, verbatim-preserving). Algorithm: non-empty + weak-connectivity pre-check (undirected BFS — structural, not type logic); edge classification IN DOCUMENT ORDER (inside→inside = component edges; outside→inside = exposed_inputs deduped by inner (node,port); inside→outside = ONE exposed output per inner source, outer fan-out stays as edges; exposed port/param iteration order = document order — deterministic and fixture-matching); exposed port `type` copied verbatim from the catalog descriptor (data); inner nodes moved verbatim INCLUDING any `ui`; the minted ComponentRefNode is **inserted at the array index of the FIRST removed node** (not appended), with hyphen-free id, `params:{}`, and `ui.position` = bounding-box center of the removed nodes' positions **only when at least one selected node has a position — otherwise `ui` is OMITTED entirely**; plus a pinned `component_refs` entry; boundary edges rewired to exposed names. Minted definition carries `schema_version:"0.1.0"`, `component_id` = uuid4, **version `"1.0.0"`**, provenance = placeholder user, `forked_from: null`. | Structural surgery is the same class as `removeNode`'s edge filter; the only type content is verbatim data copy. Invariant 5 holds. Insertion-at-first-removed-index and ui-omission match the oracle fixtures (audit-verified). | The oracle test (E7) pins correctness; server validation is the semantic authority. |
| E4 | **Nested ComponentRefNodes inside a selection are SUPPORTED** | Selected instances' ref entries are copied into `definition.component_refs`; removed from the strategy's `component_refs` only if no remaining outside instance uses them; boundary port types for a nested instance come from its cached definition's exposed ports. | IR explicitly allows nesting (Graph.nodes includes ComponentRefNode); rejecting would be an artificial rule; the mechanics are ~15 lines; M3 fixtures already prove nested evaluation. | Extraction never needs a "no components in selection" error path. |
| E5 | **Two-phase commit; no undo needed** | The pre-extraction doc is never replaced until the server blesses the result: (1) run `extractComponent` in memory → (2) `POST /v1/components` (new client fn `saveComponent`) → (3) `POST /v1/strategies/validate` the rewritten strategy → on `ok:true` only, (4) `actions.replace(rewrittenStrategy)` + seed the component cache with the new definition (no refetch). Any failure leaves the document untouched and shows the error/diagnostics. | Extraction is the first destructive multi-entity rewrite in an editor without undo; server-side validation (real after E1) is the authority. | A failed extraction is a no-op; a stray saved component (phase 2 ok, phase 3 fail) is harmless (immutable, unused). |
| E6 | **Client pre-checks are structural ONLY; semantics stay server-side** | Client checks: selection non-empty; weakly connected. NOT client-checked: terminal-in-selection (server: `missing_terminal_node`), unfilled exposed inputs (`required_input_unconnected`), definition validity (`component_definition_invalid`), recursion (impossible via extraction — fresh uuid — and server-diagnosed otherwise). Exposed-port NAMES are constrained to `^[A-Za-z0-9_]+$` in the dialog (they become instance port names used in edges — the R1 trap), with deterministic collision suffixes (`series`, `series_2`), editable. | No bespoke domain conditionals in TS; the two-phase commit makes server rejection safe. | "Recursion rejected clearly in the UI" = ValidatePanel rendering the existing machine codes (real once E1 lands). |
| E7 | **Extraction correctness oracle** | A web test extracts the momentum subgraph — selection **`{ret, rk, sel}`** (the fixture component contains all THREE; audit hand-simulated: exposed_inputs `series` (→ret) + `universe` (→sel), exposed_output `assets` (→sel), in edge document order) — from `strategy_a.json` with exposedParams `[{ret, lookback_sessions → "lookback_sessions"}, {sel, n → "n"}]`, and asserts the result equals `component_momentum.json` + `strategy_a_component.json` after NORMALIZING: minted component_id / ref id / node id; provenance `created_at` + `owner`/`creator` (fixture uses `2222…`, mint uses the placeholder); strategy meta `id`/`name`/`description` (extraction does not rename the strategy; the fixture was hand-labeled); the ref node's `params` (algorithm contract is `{}`; the fixture hand-authored an instance override `{"n":3}` to demonstrate overrides — normalize BOTH sides to `{}`); and `ui` absence on the minted node (strategy_a.json has no ui, so E3 omits it — fixture agrees). Node-array position needs NO normalization (E3 inserts at first-removed index, matching the fixture). Backend: an API-level test runs the componentized fixture vs flat over HTTP and asserts equal results. | Fixtures + library equivalence test exist (test_reference_strategies_eval.py:267-313); the audit hand-verified the algorithm reproduces the fixture surface exactly under these normalizations. | Extraction edge-case risk (the roadmap's named risk) is pinned by fixture, not by hope. If the oracle STILL mismatches at implementation → §12 STOP (never bend the algorithm ad hoc). |
| E8 | **Component rendering via a cache-forever ComponentsProvider** | `Map<'id@version', ComponentDefinition>` context beside CatalogProvider; filled on demand (drop, doc load scanning `component_refs`, post-extraction seed). Definitions are immutable per version (409 on divergence) → never invalidated. `toFlow` gains an optional third arg `components?`; a node with `'ref' in node` resolves ref→(id,version)→definition and maps exposed ports onto the EXISTING `CatalogInputPortDto`/`CatalogOutputPortDto` shapes (`required: true` — honest: every exposed input must be connected). Cache miss degrades to the bare `{typeId:'component'}` node (existing unknown-type posture). ONE shared helper does definition→port mapping, used by toFlow, decideConnection, and the Inspector (no divergent resolution). | R2 §4; immutability verified (components.py 409). `FlowNodeData`/`StrategyNode`/`ParamForm` need zero shape changes. | New port sources stay consistent; a missing definition is visible, not a crash. |
| E9 | **Placement & connection** | Palette gains a "Components" section from `listComponents` (each version a row), draggable with a second MIME; drop dispatches a new pure reducer `addComponentRefNode(doc, {componentId, version, position})` which REUSES an existing `component_refs` entry with the same (component_id, version) else mints one; node `params: {}` (definition's authored values are the defaults; exposed params are overrides). `removeNode` does NOT garbage-collect refs (verbatim preservation; a dangling ref is harmless). `decideConnection` resolves a component endpoint's port type from the cache via the E8 shared helper; the verdict remains the allow-set membership. | R2 §4; invariant 5 (no new type logic — data lookup only). | Components participate in connection gating exactly like registered nodes. |
| E10 | **Instance params via the existing ParamForm** | Inspector branches on `'ref' in node`: identity header (name, component_id@version) + ParamForm over a SYNTHESIZED schema `{type:'object', properties: fromEntries(def.exposed_params.map(p => [p.name, p.schema]))}`; instance `params` keyed by exposed name → `setParams` unchanged. | ExposedParam.schema is exactly a parameter_schema property fragment; the server layers overrides (resolve.py effective_params). | Same renderer, same guarded subset, same raw-JSON fallback; zero new form machinery. |
| E11 | **Collapse/expand = read-only detail drawer; no `ui.collapsed`** | A drawer/modal renders `def.implementation.graph` through the SAME `toFlow` (first param widened to `Pick<StrategyDocument,'nodes'|'edges'>` — Graph satisfies it structurally) into a second RF instance with `nodesDraggable/nodesConnectable/elementsSelectable=false` and no dispatch handlers. Drawer state = transient App view state (`viewedComponent?: {componentId, version}`). Do NOT write `ui.collapsed`. | Literal in-canvas expansion (RF subflows, coordinate rebasing, phantom-node semantics) is an order of magnitude more surface for zero MVP value. | "Expand" = inspect; the instance node is always the collapsed form. |
| E12 | **MVP closeout artifacts** | `scripts/seed_demo.py` (against the RUNNING API: serialize `tests/market_fixture.build_market_fixture()` into the `DatasetUpload` JSON shape → POST /v1/datasets; POST `strategy_a.json`/`strategy_b.json` verbatim — proven saveable; print dataset_id, strategy ids, suggested window 2025-07-31..2025-08-29; idempotent for free). README rewrite (single file): correct stale M8-era content; Quickstart; Scope & caveats (no live trading, no real data, single-user localhost by design, research/education replay); the 5 honest claims; pointer to the documented custom-node path (ARCHITECTURE §7, STRATEGY_LANGUAGE §10 — already satisfies "documented", README just surfaces it). Post-MVP handoff paragraph (§13). NO Playwright/Docker/auth/CORS/docs-site. | R3 §2/§3/§5: the missing dataset path is the ONE onboarding blocker; the README is stale-and-false (claims "no frontend yet"). | A new user reaches a successful backtest from the README alone. |
| E13 | **Debt: fix nothing pre-emptively** | The four M11-review PLAUSIBLE items are accepted MVP debt (audited safe/cosmetic). Fix opportunistically ONLY if a slice touches that exact code (e.g., if DatasetPanel is touched, the reload-flash keep-stale flag is ~5 lines). | R3 §6: none undermines trust surfaces. | No refactor-for-its-own-sake. |
| E14 | **No new generated contracts** | No DTO, no codegen artifact change, no migration anywhere in M12. `saveComponent` (client) uses the existing generated `ComponentDefinition`/`ComponentSaved` types. IR bundle byte-unchanged (standing invariant). | R1: endpoints complete; ComponentDefinition already in both bundles. | `codegen check` stays clean automatically. |

## 5. Architecture delta (from M11)

Backend: one service-layer wiring (E1) — no new module. Frontend:

```
web/src/
  document/extract.ts      NEW — extractComponent (pure transformation, E3–E7)
  document/store.ts        + addComponentRefNode reducer (E9)
  document/flow.ts         + optional components arg; Pick<> widening (E8, E11)
  components/index.tsx?    NEW — ComponentsProvider (cache-forever, E8) [name final at impl]
  components/Canvas.tsx    + selectedNodeIds set projection; component drop; component-port
                             resolution in decideConnection via the E8 shared helper (E2, E9)
  components/Palette.tsx   + Components section (E9)
  components/Inspector.tsx + ComponentRefNode branch (E10)
  components/ExtractDialog.tsx NEW — name/desc/ports/params + two-phase commit (E5, E6)
  components/ComponentDrawer.tsx NEW — read-only internal graph (E11)
  api/client.ts            + saveComponent (POST /v1/components)
  App.tsx                  + extractionMode/selection/viewedComponent state; wiring
scripts/seed_demo.py       NEW — onboarding seed (E12)
README.md                  REWRITTEN (E12)

data flow (new paths only):
  extraction: selection set ──extractComponent──► {definition, strategy'}
              ──POST /v1/components──► 201 ──POST validate──► ok:true ──replace──► doc
  reuse: listComponents ──► palette ──drop──► addComponentRefNode ──► doc
         loadComponentVersion ──► ComponentsProvider cache ──► toFlow/decideConnection/Inspector
  server: validate/run now build ComponentCatalog from ComponentRepository (E1)
```

## 6. Contract/API delta

- **No new endpoints. No DTO/schema/TS changes.** (E14)
- **Behavioral (additive) change to three existing paths** (E1): `POST /v1/strategies/validate`,
  `POST /v1/runs/backtest`, `POST /v1/runs/forward` now resolve components from persistence.
  Previously-failing componentized inputs now succeed (or fail with SPECIFIC diagnostics instead
  of blanket `component_definition_unavailable`). Strictly widens capability; no existing green
  behavior changes (strategies without refs are untouched — test-pinned).
- Web client: `saveComponent(def: ComponentDefinition): Promise<ComponentSaved>`.

## 7. State & persistence delta

- **No migration. No schema change. No new persisted state.** Components already persist (M9).
- Frontend: App gains extraction-mode/selection/drawer view state (derived, never a second
  source of truth); ComponentsProvider is an immutable server-state cache (id@version →
  definition, cache-forever by the 409-immutability contract).

## 8. Long-term product check

Components-as-real-objects is the vision's compositional core: extraction produces the SAME
`ComponentDefinition` the future marketplace/library distributes; the pinned-ref + immutable
version contract is the provenance story; `implementation.kind` is the documented seam where
`sandboxed`/`model`/`external` implementations later plug in WITHOUT touching M12's UI (the
drawer/ports/params all read the definition surface, not the graph specifically — only the
drawer assumes `kind:'graph'` and must gate on it). The read-only drawer is the honest MVP
ancestor of in-canvas nesting. The seed script + honest README are the bridge from internal
milestones to real-user validation without overclaiming. Nothing in M12 requires a rewrite for
hosted/multi-user (server state stays behind the same API; the cache key is version-immutable).

## 9. Implementation slices (dependency-safe)

Branch `feat/m12-components` off `origin/main` (`0f19f4a`) — fetch first. Commits `M12.x: <summary>`.
Standing stop conditions for EVERY slice: any IR-bundle byte change; any DTO/codegen-artifact
change (E14 — M12 adds NONE); any migration; any engine/evaluator/node-semantics change (E1
touches ONLY `api/service.py` + `api/routes/validate.py`); any pre-existing golden movement; any
hand-declared domain type in TS; any type-compatibility logic in TS beyond allow-set lookup; any
prose parsing; component-EDITING scope creep; Playwright/Docker/auth/CORS.

- **M12.1 — ComponentCatalog wiring (backend; E1).** `api/service.py`: helper building a
  `ComponentCatalog` by BFS closure fetch from `document.component_refs` via
  `ComponentRepository` (missing defs simply absent → resolve's fail-loud diagnostics);
  threaded into `execute_backtest_run`/`execute_forward_run`; `routes/validate.py` gains
  settings/DB access and passes the catalog (FAST PATH: skip the DB entirely when
  `component_refs` is empty — the common case keeps its no-DB purity). Tests
  (`tests/api/test_component_execution.py`, new): componentized-fixture validate `ok:true` over
  HTTP; recursion/missing-def codes over HTTP; backtest+forward of componentized Strategy A ≡
  flat over HTTP; trace `component_path` over HTTP; no-refs strategies regression-pinned.
- **M12.2 — extraction transformation + placement reducer + client fn (web; E3–E7, E9-partial).**
  `web/src/document/extract.ts` (new; the E3 algorithm incl. E4 nesting), `store.ts` +
  `addComponentRefNode`, `api/client.ts` + `saveComponent`. Tests: the E7 oracle
  (momentum extraction ≡ fixtures modulo minted ids); adversarial fixtures (fan-out outputs,
  node feeding both sides, nested refs, name collisions, disconnected/empty selections →
  errors); verbatim preservation incl. unknown keys; ref-reuse semantics.
- **M12.3 — component rendering, placement, connection (web; E8, E9).** ComponentsProvider
  (cache-forever); ONE shared definition→port-DTO helper; `toFlow` third arg + bare-node
  degradation; `decideConnection` component-port resolution; Palette "Components" section +
  drop→`addComponentRefNode`; doc-load cache fill (scan `component_refs`).
- **M12.4 — instance inspection (web; E10, E11).** Inspector `'ref' in node` branch
  (synthesized-schema ParamForm); `ComponentDrawer` read-only internal graph (toFlow `Pick<>`
  widening; non-interactive RF instance); App `viewedComponent` state; drawer gates on
  `implementation.kind === 'graph'`.
- **M12.5 — extraction mode + dialog + two-phase commit (web; E2, E5, E6).** App
  extraction-mode/selection-set state; Canvas `selectedNodeIds` projection +
  `deleteKeyCode={null}` in mode; `ExtractDialog` (name/description; exposed-port names
  prefilled, identifier-constrained, collision-suffixed; opt-in exposed params); the E5 commit
  sequence with cache seeding; failure paths leave the doc untouched (tested).
- **M12.6a — onboarding + README (docs/scripts; E12).** `scripts/seed_demo.py` (importable
  functions + `__main__`; serialize `build_market_fixture()` → DatasetUpload JSON; POST
  dataset + both strategy fixtures verbatim; print ids + suggested window) with a pytest
  driving the same functions against the in-process TestClient (no network); README rewrite
  (Quickstart, Scope & caveats, honest claims, custom-node-path pointer, corrected status).
- **M12.6b — MVP closeout (primary, last).** LEARNING_LOG M12 entry; cross-cutting acceptance
  checklist audited item-by-item in this plan's Closeout with artifact citations; §13 handoff
  paragraph copied to MVP_PLAN tail or referenced; the MANUAL browser walkthrough of the full
  §3 journey executed and its outcome recorded (discharges the M11 open item); final sweeps
  (no hand TS domain types incl. ComponentDefinition; no type-logic conditionals; no client
  metric math); both gates green end-to-end.

## 10. Agent ownership & parallelism (Opus execution safety)

- **Primary Opus agent** owns the sequential web chain **M12.2 → M12.3 → M12.4 → M12.5 →
  M12.6b** (heavy `web/src` + `App.tsx` file overlap makes parallelizing these unsafe) and all
  integration.
- **Parallel agent B** owns **M12.1** (touches ONLY `quantize/api/service.py`,
  `quantize/api/routes/validate.py`, `tests/api/test_component_execution.py` — zero overlap
  with the web chain). Dispatch concurrently with M12.2.
- **Parallel agent C** owns **M12.6a** (touches ONLY `scripts/seed_demo.py`, `README.md`, one
  new pytest file — zero overlap). Dispatch any time; it depends on nothing in M12 (uses only
  M9 endpoints).
- **Commit serialization rule:** parallel agents work in **git worktrees** (Agent isolation:
  worktree) and hand their diff back; the ORCHESTRATOR lands commits on `feat/m12-components`
  in the §12 integration order. No two agents ever commit to the branch concurrently. Each
  landed slice must leave both gates green before the next lands.
- Review model per slice: two-stage (spec-compliance → code-quality), house style; fixes folded
  before the next dependent slice starts.

## 12. Integration order, review gates, stop conditions

- **Integration order:** M12.1 → M12.2 → M12.3 → M12.4 → M12.5 → M12.6a (may land at any slice
  boundary after it's ready) → M12.6b. M12.1 lands first so every later slice's live testing
  exercises real component validation/execution.
- **Codex-style focused reviews (beyond the per-slice two-stage):** after **M12.1** (public
  behavior change on validate/run paths — verify no-refs regression pinning + fail-loud
  preservation) and after **M12.5** (the destructive transformation UX + two-phase commit
  protocol + oracle integrity).
- **Final gate:** whole-branch review after M12.6b (roadmap-checkmark coverage incl. the
  cross-cutting acceptance list; invariant sweeps; docs truthfulness) → then **STOP: no commit
  of new work, no merge, no PR, no push** without founder instruction.
- Stop conditions: the standing list in §9, plus: M12.1 may NOT alter any response shape
  (diagnostics DTOs unchanged — only which diagnostics FIRE changes); M12.5 may NOT mutate the
  document on any failure path; if the E7 oracle cannot be satisfied modulo ids (fixture
  mismatch reveals an extraction-semantics misunderstanding), STOP and report rather than
  adjusting the oracle.

## 11. Opus execution packets (standalone; §10 ownership; §12 order)

### Shared preamble (read once per packet)
Repo C:\GitHubProjects\Quantize. Branch `feat/m12-components` off **`origin/main`** (`0f19f4a`)
— `git fetch origin` first (local refs may be stale). Read FIRST: this plan's §4 (decisions
E1–E14, RESOLVED) + M11 plan §4 (D1–D13, still binding) + the packet itself; read listed files
before coding. TDD: write the packet's tests, watch them fail, implement, green. Python:
`.venv/Scripts/python.exe -m pytest <paths>`. Node 24: run `& C:\GitHubProjects\Quantize\
scripts\node24.ps1` in the same shell before any npm command; web commands
`npm --prefix C:\GitHubProjects\Quantize\web run <script>`. Gates =
`& C:\GitHubProjects\Quantize\scripts\gate.ps1` AND `bash scripts/gate.sh`, BOTH green before
"done" (baseline 875 py + 122 web). Standing stops: §9 list; anything ambiguous → STOP and
report. One commit `M12.x: <summary>` + trailer
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. NO push/merge/PR. Completion report:
files changed; test counts before/after; both gates' actual output; deviations (expect none);
self-review results.

### Packet M12.1 — ComponentCatalog wiring (backend; agent B; worktree-safe)
Read: `quantize/api/service.py` (whole), `quantize/api/routes/validate.py`,
`quantize/evaluator/preflight.py:173-236` (the `components` parameter),
`quantize/components/resolve.py:547-626` + `quantize/components/catalog.py` (or wherever
`ComponentCatalog` lives — grep `class ComponentCatalog`), `quantize/persistence/documents.py`
(`ComponentRepository.load` + its not-found error), `quantize/engine/backtest.py:425-440` and
`quantize/engine/forward.py` (how `components=` reaches the engine),
`tests/fixtures/{strategy_a_component,component_momentum,strategy_a}.json`,
`tests/api/conftest.py` (client/db/seeded fixtures), `tests/api/test_run_endpoint.py` (run
params that work), `tests/test_reference_strategies_eval.py:255-313` (the library equivalence).
Scope:
1. `service.py`: `def load_component_catalog(db: Database, document: StrategyDocument) ->
   ComponentCatalog` — BFS over `document.component_refs` and, transitively, each fetched
   definition's `component_refs`, loading via `ComponentRepository(db)`; a load that raises
   artifact_not_found leaves that (id,version) ABSENT (resolve emits
   `component_definition_unavailable` — do NOT convert to an HTTP error); guard against
   re-fetching the same (id,version). Thread the catalog into `execute_backtest_run` and
   `execute_forward_run` (both build it inside their existing `with Database(...)` and pass
   `components=` through to the engine/preflight path they use).
2. `routes/validate.py`: add `SettingsDep`; when `document.component_refs` is non-empty, open
   `Database(settings.db_path, ...)` and build the catalog; when EMPTY, do NOT open a DB
   (preserve the current no-DB fast path); pass `components=` to `run_document_preflight`.
3. Tests (`tests/api/test_component_execution.py`, new; use client+db fixtures): (a) save
   `component_momentum.json` via POST /v1/components + componentized strategy via POST
   /v1/strategies, then validate → 200 `ok:true`; (b) validate WITHOUT saving the component →
   `ok:false` with a runtime diagnostic code `component_definition_unavailable`; (c) craft a
   direct-recursion definition (component whose component_refs pins its own id@version — the
   repository saves it without structural validation, so POST works), save it + a strategy
   referencing it → validate surfaces `component_direct_recursion` **in the RUNTIME array**
   (resolve down-converts set-level structural errors to runtime diagnostics, resolve.py:586-588;
   a wrapping `component_definition_invalid` may accompany it — assert MEMBERSHIP of the code,
   not an exact set); (d) run backtest of the componentized strategy (seeded dataset,
   window 2025-07-31..2025-08-29) AND of flat strategy_a → assert the persisted records' ok,
   total_return, valuations, fills, final_cash are EQUAL (normalize run_id); same for forward
   with last_session; (e) GET the componentized run's trace for a session → some events carry
   `component_path == ["mom"]`; (f) regression: a no-refs strategy validates identically to
   before, AND the empty-refs fast path provably skips the DB — point settings at a fresh
   tmp path, validate a no-refs strategy, then assert the DB FILE WAS NOT CREATED (mere
   success proves nothing since Database(path) auto-creates); (g) deliberately re-run the
   existing invalid-corpus parity test (tests/api/test_validate_endpoint.py — the
   `duplicate_ref_id.json` fixture has non-empty component_refs and now exercises the new DB
   branch) and confirm it is green UNCHANGED.
Constraints/stops: NO response-shape change (DTOs untouched); NO codegen change (`codegen
check` must stay clean untouched); NO engine/evaluator edits; NO new endpoint. If
`ComponentCatalog` turns out not to be constructible from a plain dict of definitions, STOP and
report its actual construction API rather than modifying it.
DoD: both gates green; the six test groups pass; `git diff --stat` shows ONLY service.py,
validate.py, the new test file.

### Packet M12.2 — extraction transformation + reducer + client fn (web; primary)
Read: `web/src/document/store.ts` (reducer family, mintNodeId, verbatim law),
`web/src/document/store.test.ts` (fixture + snap patterns), `ts/quantize-ir.d.ts`
(ComponentDefinition:135+, ExposedPort, ExposedParam, ComponentRef, ComponentRefNode, Graph),
`web/src/catalog/index.ts` (`nodeTypeById` — port types come from here), `web/src/config.ts`
(PLACEHOLDER_USER_ID), `web/src/api/client.ts` (postJson pattern),
`tests/fixtures/strategy_a.json`, `tests/fixtures/component_momentum.json`,
`tests/fixtures/strategy_a_component.json` (the E7 oracle — vitest imports cross-root JSON
fine, precedent: the node_catalog golden import in catalog tests). Plan §4 E3–E7, E9.
Scope:
1. `web/src/document/extract.ts` (new): `extractComponent(doc, selectedNodeIds:
   ReadonlySet<string>, catalog: NodeCatalogResponse, components:
   ReadonlyMap<string, ComponentDefinition>, opts: {name, description?, exposedParams:
   {nodeId, paramKey, exposedName}[], portNames?: Map<string,string>}) →
   {definition: ComponentDefinition, strategy: StrategyDocument} | {error: string}` (or throw a
   typed error — pick one, test it). Implement the E3 algorithm EXACTLY (see §4 table): partition;
   weak-connectivity pre-check (undirected BFS over induced edges); edge classification with
   input-dedupe by inner (node,port) and ONE output per inner source; exposed types via
   `nodeTypeById(...).inputs/outputs[].port_type` verbatim (for nested ComponentRefNodes in the
   selection: from `components` cache exposed ports); port names = inner port name with
   deterministic `_2` suffixing (overridable via opts, must match `^[A-Za-z0-9_]+$` — validate);
   nodes moved verbatim incl. ui; E4 nested-ref handling (copy refs into definition; drop from
   strategy only if unused outside); minted ids (component_id uuid4 via crypto.randomUUID;
   version "1.0.0"; ref + node ids hyphen-free); provenance {owner/creator: PLACEHOLDER_USER_ID,
   contributors: [], visibility: "private", duplicable: false, created_at: ISO now,
   forked_from: null}; ExposedParam schema fragments copied verbatim from
   `parameter_schema.properties[paramKey]` (wire key is `schema` — the generated TS field name
   IS `schema`); `params: {}` on the new node; boundary edges rewired.
2. `store.ts`: `addComponentRefNode(doc, {componentId, version, position}) → doc` — reuse an
   existing component_refs entry with same (component_id, version) else mint (RefId
   hyphen-free); push ComponentRefNode {id minted, type_id:'component', ref, params:{},
   ui:{position}}. Pure/structuredClone/verbatim like siblings.
3. `api/client.ts`: `saveComponent(def: ComponentDefinition): Promise<ComponentSaved>` (POST
   /v1/components, raw doc body — mirror saveStrategy).
Tests (TDD): the **E7 oracle** — load the three fixture JSONs; extract **{"ret","rk","sel"}**
(the fixture component contains all three nodes — verify by reading component_momentum.json
first) from strategy_a with exposedParams [{nodeId:'ret', paramKey:'lookback_sessions',
exposedName:'lookback_sessions'}, {nodeId:'sel', paramKey:'n', exposedName:'n'}] (mirroring the
fixture's exposed_params exactly); NORMALIZE before deep-equal, per E7: minted component_id /
ref id / node id; provenance created_at + owner/creator; strategy meta id/name/description; the
ref node's `params` (normalize BOTH sides to `{}` — the fixture's `{"n":3}` is a hand-authored
instance-override demo, not extraction output); minted-node `ui` (E3 omits it here — assert it
is ABSENT). Node-array order needs no normalization (E3 inserts at the first removed node's
index — assert `mom`-equivalent sits at index 2). Expected exposed surface (audit-verified):
inputs `series` (TimeSeries[Number] → ["ret","series"]) then `universe` (AssetSet →
["sel","universe"]) in edge document order; output `assets` (AssetSet → ["sel","assets"]);
component edges = the ret→rk and rk→sel edges. If the oracle STILL mismatches, STOP — do not
bend the algorithm ad hoc; report the divergence. Plus:
fan-out output (one inner source, two outer consumers → 1 exposed output, 2 rewired edges);
node feeding inside AND outside; nested ref in selection (copy + conditional drop); name
collision suffixing; disconnected selection → error; empty → error; input unmutated + unknown
keys survive (the __future_field__ pattern from store.test.ts); addComponentRefNode ref-reuse;
saveComponent method/URL/body via the mocked-fetch pattern.
Stops: NO ComponentDefinition re-declaration (generated type only); no type-compat logic (port
types are copied, never compared); if the oracle mismatches → STOP per §12.
DoD: both gates green; report the oracle test's normalization rules explicitly.

### Packet M12.3 — component rendering, placement, connection (web; primary)
Read: `web/src/catalog/index.ts` (CatalogProvider pattern + portTypeKey/isAllowed/labelOf),
`web/src/document/flow.ts`, `web/src/components/Canvas.tsx` (decideConnection, drop handler,
StrategyNode), `web/src/components/Palette.tsx`, `web/src/App.tsx`, `web/src/useFetch.ts`,
`web/src/api/client.ts` (listComponents, loadComponentVersion), M12.2's new modules. §4 E8/E9.
Scope:
1. `ComponentsProvider` (new module, e.g. `web/src/components-cache/index.tsx` — pick a
   non-colliding path; NOT web/src/components/ which holds React components):
   `Map<'id@version', ComponentDefinition>` in a context; `ensure(componentId, version)` fills
   via `loadComponentVersion` once (cache-forever — immutable per 409 contract); `seed(def)`
   for post-extraction; a hook `useComponentDefs()`. On doc load/replace, App scans
   `doc.component_refs` and `ensure`s each.
2. ONE shared helper (in the provider module or flow.ts): `componentPorts(def) → {inputs:
   CatalogInputPortDto[], outputs: CatalogOutputPortDto[]}` mapping exposed_inputs/outputs
   (`required: true` on every input — preflight requires all exposed inputs connected).
3. `flow.ts`: optional third arg `components?: ReadonlyMap<string, ComponentDefinition>`; for
   `'ref' in node`, resolve node.ref → doc.component_refs → (component_id,version) → cache →
   displayName = def.name, ports via the shared helper; cache miss → bare `{typeId:
   'component'}` (existing unknown-type posture). Backward-compatible (all existing flow tests
   green unchanged).
4. `Canvas.tsx`: thread the components map into project()/toFlow and decideConnection —
   component endpoints resolve port types via the SAME shared helper; unresolvable → reject
   with a clear "component not loaded / unknown ref" reason (graceful, tested). Drop handler:
   a second MIME (`application/x-quantize-component` carrying {component_id, version}) →
   `addComponentRefNode`.
5. `Palette.tsx`: a "Components" section listing `listComponents()` rows (name + version),
   draggable with the second MIME; refresh seam (useFetch or provider — keep simple).
Tests: toFlow component enrichment (with cache: name+ports; without: bare) + M11.3/M11.4 flow
tests unchanged; decideConnection allows a valid edge into an exposed input whose type matches
the allow-set and rejects with "not loaded" on cache miss; palette renders component rows
(mocked client); drop dispatches addComponentRefNode; provider ensure()/seed() caching (one
fetch per id@version; no refetch).
Stops: rendering/connection must go through the ONE shared helper (no second resolution path);
no ComponentDefinition re-declaration.
DoD: both gates green.

### Packet M12.4 — instance inspection: Inspector branch + detail drawer (web; primary)
Read: `web/src/components/Inspector.tsx`, `ParamForm.tsx` (schema contract:
properties/required), M12.3's provider/helper, `web/src/document/flow.ts`,
`web/src/components/Canvas.tsx` (a read-only RF usage reference), `web/src/App.tsx`,
`web/src/App.css`. §4 E10/E11.
Scope:
1. Inspector: branch on `'ref' in node` → header (def.name or the ref id on cache miss,
   `component_id@version`) + ParamForm over the synthesized schema `{type:'object', properties:
   Object.fromEntries(def.exposed_params.map(p => [p.name, p.schema]))}` (empty exposed_params
   → an explicit "no exposed parameters" state); param edits → existing `setParams` (params
   keyed by exposed name). Also an "Inspect internals" button → App `viewedComponent`.
2. `ComponentDrawer.tsx` (new): given {componentId, version} + cache, render
   `def.implementation.graph` via `toFlow(graph, catalog, components)` — widen toFlow's first
   param to `Pick<StrategyDocument,'nodes'|'edges'>` (one type annotation; Graph satisfies it) —
   into a second `<ReactFlow>` with nodesDraggable/nodesConnectable/elementsSelectable all
   false and NO dispatch handlers; gate on `implementation.kind === 'graph'` (anything else →
   a plain "implementation kind X is not viewable" message — the future-kinds seam); a close
   button; cache miss → loading via ensure().
3. App: `viewedComponent` state; drawer rendered above the canvas region; plain CSS.
Tests: Inspector renders exposed-param form and dispatches setParams keyed by exposed name;
empty-params state; drawer renders the internal graph's node names read-only (RTL smoke via
the mocked provider) and shows the non-graph-kind message for a hypothetical future kind
(fixture cast); toFlow Pick<> widening keeps all existing tests green.
Stops: the drawer must be able to mutate NOTHING (no actions passed); no `ui.collapsed`
written anywhere.
DoD: both gates green.

### Packet M12.5 — extraction mode + dialog + two-phase commit (web; primary)
Read: `web/src/App.tsx`, `web/src/components/Canvas.tsx` (project/selected, deleteKeyCode,
onNodeClick), M12.2 `extract.ts` + `saveComponent`, `web/src/api/client.ts`
(validateStrategy, ApiClientError), `web/src/components/ValidatePanel.tsx` (diagnostic
rendering to reuse/echo), M12.3 provider (`seed`). §4 E2/E5/E6.
Scope:
1. App: `extractionMode: boolean`, `extractionSelection: Set<string>`; entering seeds from
   `selectedNodeId` (if any) and clears single-selection UI; `onNodeClick` toggles membership
   while active; exiting clears. An "Extract component" toolbar affordance enters the mode; a
   visible mode banner with count + Cancel.
2. Canvas: optional `selectedNodeIds?: ReadonlySet<string>` prop; `project()` generalizes
   `selected: selectedNodeIds ? selectedNodeIds.has(n.id) : n.id === selectedNodeId`;
   `deleteKeyCode={null}` while extraction mode is active (prop-driven).
3. `ExtractDialog.tsx` (new): opens from the mode banner when selection is non-empty; fields:
   name (required, min 1), description (optional); exposed ports PREVIEW (computed by a dry-run
   `extractComponent` with a fixed placeholder name, e.g. `"preview"` — minted-id
   nondeterminism between preview and commit is harmless since the preview shows only
   names/types, which are deterministic — show the deduped inputs/outputs with editable names,
   validated
   `^[A-Za-z0-9_]+$`, collision-suffix defaults); exposed params: checkbox list of
   (node display name, paramKey) for selected nodes with editable exposed names. Confirm runs
   the **E5 sequence**: extractComponent (fresh, with final names) → on {error} show it →
   `saveComponent(definition)` → `validateStrategy(rewrittenStrategy)` → `ok:false` → render
   the diagnostics (codes) in the dialog and ABORT (document untouched) → `ok:true` →
   `actions.replace(rewrittenStrategy)`, `componentsCache.seed(definition)`, exit mode, select
   the new ComponentRefNode. ApiClientError (409/422/network) → shown, ABORT, doc untouched.
4. Keep the mode/dialog OUT of Canvas internals — App-level composition like existing panels.
Tests: mode toggling + selection-set accumulation (App-level, mocked children per
App.test.tsx pattern); dialog dry-run preview shows deduped ports for a fan-out fixture; port
name validation (bad identifier blocks confirm); the commit sequence — mocked saveComponent +
validateStrategy: (a) validate ok:false → replace NOT called, diagnostics shown; (b)
saveComponent throws → replace NOT called; (c) happy path → replace called with the rewritten
doc, seed called, mode exited. Canvas: selectedNodeIds projection test (two nodes selected →
both RF-selected) and deleteKeyCode null when the prop says mode-active.
Stops: NO document mutation on any failure path (test-pinned); no bespoke semantic checks
beyond E6's structural ones.
DoD: both gates green; manual (best-effort headless note): the §3 extraction journey compiles
and the dialog flow works against mocked client.

### Packet M12.6a — seed script + README (docs/scripts; agent C; worktree-safe)
Read: `tests/market_fixture.py` (build_market_fixture), `quantize/api/dto/datasets.py`
(DatasetUpload/CalendarDto/SessionDto/ObservationDto field names + JSON types),
`tests/fixtures/strategy_a.json` + `strategy_b.json` (POST verbatim — proven by
tests/api/conftest.py:120-126), `tests/api/test_run_endpoint.py` (the working window),
`README.md` (current, stale), `CLAUDE.md` (run commands to copy-forward), `docs/PRODUCT.md`
(non-goals for the caveats), `docs/ARCHITECTURE.md` §7 + `docs/STRATEGY_LANGUAGE.md` §10
(custom-node path to point at). §4 E12; §2 honest claims/avoid lists.
Scope:
1. `scripts/seed_demo.py`: importable pure functions — `dataset_upload_payload() -> dict`
   (serialize build_market_fixture() into the DatasetUpload JSON shape: calendar
   {exchange,timezone,sessions[{session_date,open_at,close_at}]} + observations
   {asset:[{session_date,open_price,close_price,open_available_at,close_available_at}]}, all
   ISO strings) and `seed(base_url) -> summary` (POST /v1/datasets, POST both strategy fixture
   files RAW, return ids); `__main__` prints dataset_id, strategy ids/versions, suggested
   window 2025-07-31..2025-08-29, next steps. stdlib only (urllib) — no new deps. Idempotent
   by API contract (200 on re-run). **Concrete transport seam:** `seed(post)` takes a callable
   `post(path: str, payload: dict) -> tuple[int, dict]`; `__main__` wires a urllib
   implementation bound to the base URL; the test wires a TestClient-backed lambda.
2. `tests/test_seed_demo.py` (or tests/api/): drive `dataset_upload_payload()` +
   `seed(post)` against the in-process TestClient via the injected callable (no network;
   the urllib wrapper itself stays a thin untested `__main__` shim); assert the
   dataset uploads (201) and matches the repository fingerprints of build_market_fixture();
   both strategies save 201; re-run → 200s.
3. `README.md` rewrite (one file): what Quantize is (MVP-honest, from §2 claims); Quickstart
   (venv + `pip install -e ".[dev]"`, uvicorn command, Node 24 note + `npm ci`/`npm run dev`
   in web/, `python scripts/seed_demo.py`, then the journey); Scope & caveats (the §2
   avoid-list: no live trading, no real market data, no prediction claims, single-user
   localhost-only by design, custom nodes are a documented path not a feature — link
   ARCHITECTURE §7); current status (M1–M12, real test counts at time of writing); milestone
   table updated or removed in favor of MVP_PLAN link. NO Docker/deploy/auth sections.
Stops: no new dependencies; no changes outside scripts/, README.md, the one test file; do not
touch web/ or quantize/ (if the DatasetUpload serialization reveals a dto mismatch, STOP and
report).
DoD: both gates green (the new pytest counts); README claims cross-checked against §2 lists.

### Packet M12.6b — MVP closeout (primary; LAST)
Read: this plan (whole), `docs/LEARNING_LOG.md` (entry format; M11 tail),
`docs/MVP_PLAN.md:282-290` (acceptance list), M11 plan Closeout (the open manual-walk item),
all M12 slice commits.
Scope:
1. `docs/LEARNING_LOG.md` M12 entry (concepts: extraction as pure document transformation;
   two-phase commit against server authority; cache-forever immutable definitions; the
   catalog-wiring gap as a lesson in library-vs-HTTP completeness; with Where pointers, reading
   path, one by-hand exercise + prediction; status with final counts).
2. This plan's `## Closeout`: the cross-cutting acceptance list audited item-by-item WITH
   artifact citations (goldens/tests/UI); final test counts; gates output; deviations;
   flip-point states (E4 nested support kept? E12 script vs static file).
3. Execute the MANUAL browser walkthrough of §3 end-to-end (uvicorn + npm run dev + seed
   script) — record pass/fail + any friction verbatim in the Closeout (this discharges the
   M11 open item; a FAIL is a STOP: report, do not patch ad hoc).
4. Final sweeps: grep web/src for `interface ComponentDefinition|ExposedP|ComponentRef` domain
   re-declarations (none); type-logic conditionals (none beyond portTypeKey); client metric
   math (none). Both gates + `npm run build`.
5. Post-MVP handoff: ensure §13's validation paragraph is referenced from the Closeout.
DoD: both gates green end-to-end; Closeout written; THEN STOP — no merge/PR/push; the branch
awaits founder review and the product enters the §13 validation phase.

## 13. Founder decisions

**None blocking.** Two recorded flip-points:
1. E4 (nested refs in selection): flip to reject-with-message if implementation reveals >1 day
   of edge cases (one-packet change; the dialog gains one error path).
2. E12 seed script: if the founder prefers a committed static `examples/demo_dataset.json`
   instead of deriving from `market_fixture.py`, swap (the script is still the recommended
   single-source form).

Post-MVP handoff (new content, one paragraph): after M12 closes, the product enters
founder-led validation — 3–5 quantitatively-literate testers walk the README journey on their
own machines; signal = (a) they reach a successful backtest unassisted, (b) they can explain WHY
their strategy traded using traces alone, (c) they attempt a component extraction unprompted.
Feedback lands as issues; the next engineering phase is chosen from the globally-deferred list
by observed demand, not roadmap momentum.

## 14. Continuation checkpoint

- DONE: baseline; R1/R2/R3 reconstruction integrated (digests in appendices, evidence-checked);
  §2–§13 ALL written — decisions E1–E14 ratified, journey, slices M12.1–M12.6b, ownership
  (primary chain M12.2→.3→.4→.5→.6b; parallel agent B = M12.1, agent C = M12.6a, worktree +
  orchestrator-serialized commits), integration order + review gates, and all SEVEN standalone
  Opus packets. (Note: §12 physically precedes §11 in this file; cross-references are by
  section number.)
- DONE: adversarial audit completed; SIX confirmed defects corrected in place (oracle
  selection is {ret, rk, sel} — the fixture component has THREE nodes; E3 pins
  insertion-at-first-removed-index, ui-omission when no positions, document-order port/param
  iteration, schema_version; E7/M12.2 normalization list completed incl. strategy meta +
  ref-node params-to-{} + provenance owner/creator; M12.1 recursion code asserted in the
  RUNTIME array by membership; the no-DB fast-path test asserts the DB file is NOT created;
  the invalid-corpus parity test flagged as newly on-path; M12.6a transport seam made concrete
  — `seed(post)` callable; M12.5 preview uses a placeholder name). Audit verified OK:
  ComponentCatalog construction API, preflight/engine `components=` threading, fixture
  hand-simulation, parallelism file-overlap safety, E14 no-contract-change, roadmap +
  cross-cutting coverage.
- **PLAN COMPLETE — READY FOR OPUS EXECUTION.** Next action: dispatch per §10/§12 (M12.1 agent B
  + M12.2 primary concurrently; M12.6a agent C anytime; land in §12 order). STOP boundary: no
  merge/PR/push after M12.6b without founder instruction.
- If resuming cold: this file alone suffices for execution; M11 plan §4 (D1–D13) remains
  binding; do NOT re-run repository reconstruction.

## Appendix A — R1 evidence digest (component substrate — verified)

- IR complete: `ComponentDefinition{component_id: UUID, version: SemVer, schema_version,
  name(min1, free-form), description?, component_refs, implementation: {kind:"graph", graph},
  exposed_inputs/outputs: ExposedPort{name(min1), type: PortType, maps_to:[NodeId, PortName]},
  exposed_params: ExposedParam{name, binds_to:[NodeId, str], schema_→wire key "schema"},
  provenance: Provenance[ComponentForkRef{id, version: SemVer}], extensions?}`
  (quantize/schema/components.py). Nesting allowed (Graph.nodes = RegisteredNode |
  ComponentRefNode). Instance params keyed by EXPOSED NAME, layered over authored internal
  params (resolve.py:_instantiate:464-544; unknown name → UNKNOWN_COMPONENT_PARAM).
- Resolve/recursion complete at library level: closure BFS; codes `component_direct_recursion`
  / `component_cycle` / `unknown_component_ref` / `duplicate_ref_id` /
  `duplicate_component_definition` (validation/errors.py:26-30; structural.py); exposed
  port/param semantic checks incl. `is_compatible`; set-level recursion diagnostics lose `loc`
  through resolve's down-conversion (code+subject survive) — ValidatePanel renders code+subject
  fine.
- ⚠ GAP-1: `api/routes/validate.py:34` — no `components=` → empty catalog → only
  `component_definition_unavailable` reachable over HTTP. ⚠ GAP-2: `api/service.py:46,72` —
  runs of componentized strategies fail resolution (library run_backtest supports
  `components=`, engine/backtest.py:432). → E1.
- Endpoints: POST /v1/components raw IR, 201/200 idempotent, 409 divergent, 422 invalid;
  GET /v1/components flat rows (component_id, version, name, schema_version, saved_at; every
  version a row); GET .../versions/{version} verbatim. No versions-list endpoint (don't add).
  Strategy save does NOT check referential integrity (validate is the gate).
- Oracle: `tests/fixtures/strategy_a_component.json` + `component_momentum.json` + flat
  `strategy_a.json`; `tests/test_reference_strategies_eval.py:267-313` (componentized ≡ flat:
  targets, ranks, warm-up, component_path); golden
  `tests/goldens/trace_strategy_a_componentized.json` (test_trace_tree.py:121-162).
- Trace hierarchy: server needs NOTHING (component_path flows runtime → persistence → API).
- Traps: exposed-port `name` schema-unconstrained but used as an instance PORT name in edges
  (PortName `^[A-Za-z0-9_]+$`) → dialog constrains it (E6). `ExposedParam` wire key is
  `"schema"`. `binds_to[1]` is plain str. Component ids canonicalized UUIDs; SemVer strict
  `^\d+\.\d+\.\d+$`; JS-safe int bound on all JSON. `"component"` type_id reserved.

## Appendix B — R2 evidence digest (editor architecture — verified)

- Canvas.tsx:336-341 multi-select disabled (M11.10); selection App-owned single
  (`selectedNodeId`), projected in `project()` (Canvas.tsx:187-195); re-seed effect re-derives
  RF state from (doc, catalog, selectedNodeId, highlightedEdgeIndex) — App-owned selection is
  re-seed-proof. → E2.
- toFlow leaves unknown types bare `{typeId}` (flow.ts:73-88); ComponentRefNode (`type_id
  'component'`) today renders bare and `decideConnection` rejects its edges with "Unknown node
  type" (Canvas.tsx:118-122) — E8/E9 fix via the definition cache + shared helper.
- ParamForm reads only `schema.properties`/`required` (ParamForm.tsx:346-354) → E10's
  synthesized schema works unchanged. `loadComponentVersion`/`listComponents` exist in
  client.ts:131-145; `saveComponent` missing.
- toFlow reads only nodes+edges (flow.ts:73,90) → Pick<> widening for the drawer costs one
  annotation (E11). RefId shares `^[A-Za-z0-9_]+$` with NodeId (primitives.py:81-83); mint like
  `mintNodeId` (store.ts:47-49).
- Every-exposed-input-must-be-connected at top level: preflight.py:157-169 → render exposed
  inputs `required: true` (E8).
- Risks: (1) the E1 wiring is on the critical path — sequence it first; (2) extraction is
  destructive-without-undo → E5 two-phase + E7 oracle; (3) two port-resolution sources → one
  shared helper (E8).

## Appendix C — R3 evidence digest (MVP completeness — verified)

- Acceptance 10/10 audit: items 1–6, 8–10 DONE with cited artifacts; item 7 PARTIAL (runtime
  done since M3; UI half = M12 core). "e2e" = headless pytest by policy (CLAUDE.md:128; M11
  D11 excluded Playwright) — no new test infra owed. "Documented custom-node path" already
  satisfied (ARCHITECTURE.md:228-229; STRATEGY_LANGUAGE.md:474 names future implementation
  kinds sandboxed/model/external IN THE IR SPEC; :645-654) — README pointer closes it.
- First-launch blocker: NO sample dataset exists as a file; only `tests/market_fixture.py`
  builder; DatasetUpload shape nontrivial. Strategy fixtures POST verbatim (proven:
  tests/api/conftest.py:120-126). 10MB cap fits the fixture dataset. → seed_demo.py (E12).
- README.md is STALE-AND-FALSE (claims M1–M8, 677 tests, "no frontend yet"; milestones table
  stops at M8) → rewrite (E12). Run commands/no-auth/localhost stance already documented in
  CLAUDE.md:48-56 — copy-forward, not new design.
- No post-MVP validation phase documented anywhere → §13 paragraph is new content.
- Debt triage: all four M11 PLAUSIBLE items accepted (blunt highlight-clear is
  conservative-correct; useFetch skip-mode ergonomic; parseFiniteNumber placement nit;
  dataset reload flash cosmetic). Fix-in-M12 required list: EMPTY. → E13.
- Rejected scope creep: auth, Docker, deployment, web/dist serving, CORS, HTTPS, multi-user,
  Playwright, docs site.

## Closeout (M12.6b — 2026-07-06)

All seven M12 slices are merged on `feat/m12-components` (HEAD after M12.5b = `e9c9c62`). Final
test counts from a real gate run: **887 Python (pytest) + 200 web (vitest)**. Both gates green
end-to-end (`./scripts/gate.ps1` AND `bash scripts/gate.sh`: pytest → ruff check → ruff format
→ mypy → node24 → codegen check → tsc → web typecheck → web test — ALL STAGES PASSED on both).
`npm run build` (production bundle) succeeds. No DTO/codegen/migration change landed in M12 (E14
held; the IR + API bundles are byte-unchanged — `codegen check` reports "up to date").

### Post-review fixes (M12.7, M12.8 — founder review, 2026-07-06)

Two Important findings from founder review, each fixed on branch (both two-stage reviewed →
APPROVED); the plan's own E5/E9 premises ("a dangling ref is harmless" / "a stray saved
component is harmless") were too optimistic and are corrected:
- **M12.7 (`6e0651d`) — prune unused `component_refs` on node removal.** `removeNode` (store.ts)
  now drops pins no longer referenced by any remaining node (shared refs kept). Server resolution
  loads EVERY declared ref (resolve.py:556), so a stale pin is live, executable content — not
  inert. +4 web tests.
- **M12.8 (`bfef55f`) — semantically validate a `ComponentDefinition` before persistence.** POST
  /v1/components now runs `diagnose_component_definition` (structural + recursion + registry-
  semantic, reusing `resolve`'s own stack) before the immutable `repo.save`; an invalid definition
  → 422 `component_definition_invalid`, never stored. This is intentionally STRICTER than strategy
  save (strategies are mutable + explicitly validated; components are immutable per version, so a
  bad one can never be fixed/deleted). Review verified NO false-rejection of valid extracted
  components (`_check_definition` counts exposed-input mappings as satisfying internal required
  inputs — `component_momentum` → 201 proves it). The M12.1 self-recursion API test was replaced
  by a save-time-rejection test (recursion still covered at the resolve/library layer). +8 py
  tests (one prior test replaced).

**Revised final counts: 895 Python (pytest) + 204 web (vitest), both gates green** (branch tip
`bfef55f`). Non-blocking follow-up: M12.8's 422 collapses the specific fault to prose in the
message (single `component_definition_invalid` envelope code) — fine for v0's sole consumer
(ExtractDialog displays the string); a future client branching on fault kind would want a granular
code.

### M12.9 — ultra-review fix wave (2026-07-06)

A recall-biased high-effort review (8 finder angles → 23 candidates → per-candidate adversarial
verification) surfaced 10 findings on the full branch; ALL TEN were fixed by four parallel agents
(one commit per finding, `e5e784e..5debc45`), each fix independently spec'd from the verified
finding and the whole wave consolidated-reviewed → **APPROVED**:
- **Correctness:** two-pass exposed-port naming (a rename can no longer be silently dropped when
  collision suffixes shift — overrides are keyed by the exact preview defaults); saved-definition
  reuse on semantically-identical extraction retries (orphan accumulation bounded — same
  component_id re-POSTs → idempotent 200; the single first-failure orphan remains, accepted);
  SQLite **WAL journal mode** (validate can no longer 503 on a read during a concurrent run's
  write; one lock-pathology test rewritten to assert the improved behavior — the non-poisoning
  property remains covered by three other tests); `replaceIf` compare-and-swap in the document
  store used by BOTH async writers (StrategyPanel load + extraction commit — App's bespoke docRef
  deleted); stale `selectedNodeId` cleared when its node leaves the document (no phantom
  extraction seeds).
- **Fail-loud seam:** componentized documents now REQUIRE an explicit ComponentCatalog at
  preflight/engine (`require_component_catalog` — None + pinned refs raises; explicit empty stays
  valid), closing the silent-empty-default seam that produced GAP-1.
- **Coverage:** the run-layer recursion defense is integration-tested again via a store-bypass
  plant (direct `ComponentRepository.save`).
- **Deduplication:** resolve/diagnose share `_fetch_definition_closure` + `_run_definition_gates`
  (byte-identical behavior); extract.ts reuses store.ts minters; one shared `resolveComponentDef`
  for render/connect/inspect (Inspector's def-step stays on the provider's get — documented
  partial).
**Final counts: 904 Python + 220 web, both gates green** (branch tip after the wave). Remaining
accepted nit: the commit-time `database_locked` recovery path has no reachable dedicated test
under WAL (defensive code, noted in its docstring).

### Cross-cutting acceptance audit (MVP_PLAN.md:282-290 — item by item)

The list is one sentence in `PRODUCT.md`/`MVP_PLAN.md`; decomposed into its ten clauses, each with
the artifact that PROVES it. **Verdict: 10/10 covered.**

1. **Both reference strategies composed from general-purpose nodes.** `tests/fixtures/strategy_a.json`
   + `strategy_b.json` use only registry-registered node types (no bespoke nodes); proven runnable by
   `tests/test_reference_strategies_eval.py` and `tests/test_reference_backtests.py`. The engine
   never special-cases a strategy by name (CLAUDE.md scope discipline; grep of `quantize/engine`
   finds no strategy-id/name literals). ✅
2. **The versioned JSON IR is the source of truth.** `quantize/schema/document.py` (the IR model),
   canonical serialization + round-trip proven by `tests/test_roundtrip.py` and
   `tests/test_serialization.py`; `ui.*`-excluded semantic equality by `tests/test_semantic_projection.py`.
   Frontend honours it: `web/src/document/store.ts` holds the document as the single store and derives
   React-Flow views (`web/src/document/flow.ts`) — never a parallel truth (M11 D4; LEARNING_LOG M11).
   Two version axes (`schema_version` vs `strategy.version`) gated at load. ✅
3. **Invalid graphs/ports rejected clearly (structural + semantic).** `quantize/validation/{structural,
   semantic}.py` + the single shared `quantize/compatibility.py`; served run-faithfully by
   `quantize/api/routes/validate.py` (the SAME `run_document_preflight` the evaluator runs). The 3-way
   parity (endpoint == preflight == real-run rejection) is `tests/api/test_validate_endpoint.py`; the
   editor renders diagnostics by structured `loc`/`node_path`, never by parsing messages
   (`web/src/components/ValidatePanel.tsx`; `ValidatePanel.test.tsx`). Live-verified at journey steps
   c1 (flat `ok:true`) and d3 (componentized `ok:true`, 0 runtime diagnostics). ✅
4. **One set of semantics for historical & forward replay.** One `SessionEngine.step`
   (`quantize/engine/backtest.py`) driven two ways (`quantize/engine/forward.py`); the field-for-field
   backtest↔forward consistency battery is `tests/test_forward_replay.py` (M8; LEARNING_LOG M8). The
   API exposes both via one service path (`quantize/api/routes/runs.py`). ✅
5. **Deterministic backtest reproduces goldens.** `tests/goldens/strategy_a_backtest.json` +
   `strategy_b_backtest.json` (+ the trace goldens), byte-compared by `tests/test_reference_backtests.py`
   under `--update-goldens` discipline, with the `.gitattributes` LF pin. ✅
6. **User inspects value/trades/returns/drawdown + structured decision reasons.**
   `web/src/components/ResultsView.tsx` (valuations chart via `SvgLineChart.tsx`, `total_return`,
   `max_drawdown`, `final_cash`, fills + evaluations tables — EVERY number read verbatim from the
   record) and `web/src/components/TraceView.tsx` + `web/src/trace/group.ts` (per-instant trees, nested
   by component, mirroring `quantize/tracing/tree.py`). Tests `ResultsView.test.tsx`,
   `TraceView.test.tsx`, `trace/group.test.ts`. Live-verified at journey steps c3/c4 (flat record +
   10-event trace) and d6 (componentized trace with `component_path == ["mom"]`). ✅
7. **A subgraph saved as a reusable component (real compositional object).** THE M12 core, delivered
   across the slices: **M12.2** extraction as a pure transform (`web/src/document/extract.ts`) proven
   by the oracle `web/src/document/extract.test.ts` (extracting `{ret, rk, sel}` reproduces
   `component_momentum.json` + `strategy_a_component.json` modulo minted ids); **M12.1** HTTP
   reachability (`quantize/api/service.py::load_component_catalog` + `routes/validate.py`;
   `tests/api/test_component_execution.py` — validate/backtest/forward/trace of componentized ≡ flat
   over HTTP); **M12.3** rendering/placement/connection (`web/src/components-cache/index.tsx`,
   `Palette.tsx`, `Canvas.tsx`); **M12.4** read-only inspection (`Inspector.tsx` exposed-param form,
   `ComponentDrawer.tsx` internal-graph drawer); **M12.5** the extraction UI + two-phase commit
   (`ExtractDialog.tsx`, `App.tsx::commitExtraction`). Runtime is M3
   (`quantize/components/resolve.py`); component immutability is `quantize/persistence/documents.py`
   (409 on divergence). Live-verified end to end at journey steps d1–d6 (extraction path built by hand
   over HTTP: component saved 201, componentized strategy saved 201 + validated `ok:true` + backtested
   with facts EQUAL to the flat run). ✅
8. **Strategy modified & saved as a new version.** Pure reducers (`web/src/document/store.ts`) + save
   (`web/src/api/client.ts::saveStrategy`, `web/src/components/StrategyPanel.tsx`) against
   `quantize/api/routes/strategies.py` (monotone version, immutable per version, 409 on divergent
   re-save); `tests/api/test_strategy_component_endpoints.py`, `web/src/components/StrategyPanel.test.tsx`.
   Extraction itself produces a rewritten strategy saved as a new version (journey step d2). ✅
9. **Unit / integration / e2e tests pass.** 887 pytest + 200 web, both gates green (above). Per policy
   (CLAUDE.md:128) e2e = headless pytest: `tests/test_reference_backtests.py`,
   `tests/test_forward_replay.py`, and the `tests/api/*` suite drive full strategies through the real
   boundary. Additionally the §3 journey (incl. the componentized path) was executed LIVE over HTTP
   against a uvicorn instance in M12.6b (transcript below) — a stronger discharge than a mocked walk. ✅
10. **A documented path to custom math/Python components — without pretending it is built.**
    `docs/ARCHITECTURE.md` §7 ("Future boundaries") and `docs/STRATEGY_LANGUAGE.md` §7/§10 name the
    future `implementation.kind` values (`sandboxed`/`model`/`external`) in the IR spec; the README's
    "Scope & caveats" section surfaces the pointer and states plainly they are a preserved seam, not a
    feature. v0 ships a fixed node set only. ✅

### Live journey verification (§3, over HTTP — no browser)

Browser automation is out of policy (CLAUDE.md:128; M11 D11), so the "manual walkthrough" was
discharged as a LIVE HTTP script against a real uvicorn (`--port 8137`, throwaway DB, since deleted).
No mocks; every step hit the wire. All 11 steps passed:

| Step | Action | Outcome |
|------|--------|---------|
| b | `seed_demo.seed(...)` | dataset `84de0d8b…`, strategies `1111…`(A)/`3333…`(B), window 2025-07-31..2025-08-29 |
| c1 | validate `strategy_a` | `ok:true`, warmup 126 |
| c2 | backtest flat A | 201, run_id minted |
| c3 | GET flat run record | `ok:true`, `total_return` 0.025015130971708377, `final_cash` 0.0 |
| c4 | GET flat trace (2025-07-31) | 200, 10 events |
| d1 | POST `component_momentum.json` | 201, `aaaaaaaa…@1.0.0` |
| d2 | POST `strategy_a_component.json` | 201, `bbbbbbbb…` v1 |
| d3 | validate componentized (exercises M12.1 wiring) | `ok:true`, 0 runtime diagnostics, warmup 126 |
| d4 | backtest componentized | 201, run_id minted |
| d5 | componentized record vs flat | `ok`/`total_return`/`final_cash`/`valuations`/`fills` all EQUAL; the two records differ ONLY in `run_id` + `strategy_id` |
| d6 | GET componentized trace (2025-07-31) | 200, 10 events, 5 carry `component_path == ["mom"]` |

The frontend **production build** (`npm --prefix web run build`) succeeded (211 modules, `tsc --noEmit`
+ `vite build` clean). The visual GUI click-through remains a **founder step** (browser automation is
out of policy); every editor interaction in §3 is covered headlessly by the 200 web tests — Canvas
(`Canvas.test.tsx`, `Canvas.selection.test.tsx`, `Canvas.drop.test.tsx`, `Canvas.extraction.test.tsx`),
ExtractDialog (`ExtractDialog.test.tsx`), Inspector (`Inspector.test.tsx`), ComponentDrawer
(`ComponentDrawer.test.tsx`), Palette (`Palette.test.tsx`), flow/store/extract
(`flow.test.ts`/`store.test.ts`/`extract.test.ts`), and App extraction wiring
(`App.test.tsx`/`App.extraction.test.tsx`). No browser was driven and none is claimed.

### Invariant sweeps (web/src)

- **Hand-declared domain types: NONE.** `ComponentDefinition`/`ExposedPort`/`ExposedParam`/
  `ComponentRef`/`ComponentRefNode` are imported from generated `@quantize/quantize-ir` everywhere
  (`extract.ts`, `components-cache/index.tsx`, `flow.ts`). The only local declarations are `type
  PortType = ExposedPort['type']` (a derived ALIAS of the generated field) and `ExposedParamRequest`
  (a UI-input options shape `{nodeId, paramKey, exposedName}`, NOT the domain `ExposedParam`).
- **Type-compatibility logic: NONE beyond the M11 allow-set.** The only `.kind`/`.dtype` touch is
  `catalog/index.ts::portTypeKey` (builds a lookup KEY for the server-provided allow-list; decides
  nothing). No `is_compatible`/`dtype ===` in any `.tsx`.
- **Client-side metric math: NONE.** `ResultsView`/`SvgLineChart`/`RunPanel`/`TraceView` read
  `total_return`/`max_drawdown`/`final_cash`/`valuations`/`portfolio_value` VERBATIM from the record
  and only format/scale-to-pixels for display (invariant 5 upheld; file headers assert it).

### Honest-claims verification (§2.9)

Each of the five claims is test- or artifact-backed: (1) one IR runs identically in backtest & forward
replay → `tests/test_forward_replay.py`; (2) every decision explainable via hierarchical traces →
trace goldens + `TraceView`/`trace/group.ts`, live-verified `component_path` nesting at d6; (3)
backtests deterministic + golden-pinned → `tests/goldens/*` + `.gitattributes` LF pin; (4)
strategies/components are real versioned objects (compositional, not visual groups) → the extraction
oracle + `test_component_execution.py` (componentized ≡ flat) + 409-immutability; (5) invalid
strategies fail loudly with structured, UI-highlighted diagnostics → `test_validate_endpoint.py` +
`ValidatePanel`. The avoid-list (§2.10) is honoured by the README "Scope & caveats" section.

### Debt posture (E13)

The four M11-review PLAUSIBLE items (blunt highlight-clear, useFetch skip-mode, `parseFiniteNumber`
home, dataset-list reload flash) remain ACCEPTED MVP debt — all audited safe/cosmetic; none was
touched pre-emptively (no slice needed that exact code). Fix-in-M12 required list: EMPTY, as planned.

### Flip-point outcomes (§13)

- **E4 (nested ComponentRefNodes inside a selection): KEPT (supported).** Implementation revealed no
  edge-case blowup; `extractComponent` copies nested refs into the definition and drops them from the
  strategy only when unused outside, covered by the nested-ref case in `extract.test.ts`. Extraction
  never needs a "no components in selection" error path.
- **E12 (seed form): KEPT as the script `scripts/seed_demo.py`** (derives the dataset from
  `tests/market_fixture.build_market_fixture()`), NOT swapped for a committed static
  `examples/demo_dataset.json`. Proven by `tests/test_seed_demo.py` (in-process TestClient) and
  re-exercised live at journey step b.

### Post-MVP handoff

Per §13, after this closeout the branch awaits founder review and the product enters **founder-led
validation**: 3–5 quantitatively-literate testers walk the README journey on their own machines;
signal = (a) they reach a successful backtest unassisted, (b) they can explain WHY their strategy
traded from traces alone, (c) they attempt a component extraction unprompted. Feedback lands as
issues; the next engineering phase is chosen from the globally-deferred list by observed demand, not
roadmap momentum.

**STOP boundary honoured:** no merge, PR, or push beyond the single M12.6b closeout commit. The MVP is
complete.
