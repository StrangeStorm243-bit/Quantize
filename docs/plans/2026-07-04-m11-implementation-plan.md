# M11 — Editor (the first legible screen) — Implementation Plan (2026-07-04)

> Plan-of-record for M11, authored by the planning session (no production code written).
> **For the implementer (Opus):** execute the slices IN ORDER as bounded packets (§10); each is
> test-first and independently green. Decisions in §4 are RESOLVED — do not re-derive them.

## 1. Baseline

- Branch `main` @ `cd788b1` (= `origin/main`), clean tree. M10 merged via PR #13
  (`GET /v1/node-types` descriptor API); evidence: `docs/plans/2026-07-03-m10-implementation-plan.md`
  §Closeout, `docs/LEARNING_LOG.md` M10 entry. 867 tests, both gates green at merge.
- Gates: `./scripts/gate.ps1` / `bash scripts/gate.sh` (pytest → ruff → format → mypy → node24 →
  codegen check → tsc). Node 24 via `./scripts/node24.ps1`. Python `.venv/Scripts/python.exe`.
- Relevant modules: `quantize/api/` (15 endpoints under `/v1`, see `tests/api/test_hardening.py`),
  `quantize/api/dto/*` (frozen strict DTOs), codegen bundles `schema/quantize{,-api}.schema.json` +
  `ts/quantize-{ir,api}.d.ts` (generated, staleness- and compile-gated). No frontend exists.
  Root `package.json` is codegen-only (engines `>=24 <25`).
- **M11 roadmap text (docs/MVP_PLAN.md:254-265, verbatim):** "Editor (the first legible screen).
  Objective: Build→Test→Run→Inspect→Modify in the browser. React + React Flow: add nodes, connect
  compatible ports, incompatible connections rejected with a clear reason (via the shared
  compatibility metadata), edit parameters (from M10 metadata). Validate, Run (backtest + forward
  replay), view results (portfolio value, trades, returns, drawdown). Click a date / order /
  decision → render its structured trace (with component hierarchy). Save as a new version.
  Frontend imports generated TS types; contains no numerical logic. Dependencies: M9, M10.
  Risks: UI temptation to embed logic (mitigate: invariant + review)."
- **M12 boundary (MVP_PLAN.md:269-278):** component authoring/extraction UI (select subgraph →
  `ComponentDefinition`, expose ports/params, reuse via pinned `ComponentRef`, collapse/expand).
  M11 must NOT build component authoring, a component palette, or subgraph selection.

## 2. M11 definition

**User-visible outcome:** a browser app where the founder can create/load a strategy, build its
graph on a canvas (palette from the M10 catalog, typed ports, compatibility-checked connections
with clear rejection reasons), edit parameters via schema-driven forms, validate with highlighted
structured diagnostics, save as a new version, upload/select a dataset, run backtest AND forward
replay, view results (portfolio value chart, returns, drawdown, trades), and click a session date
to inspect its structured trace with component hierarchy.

**Done means:** every roadmap checkmark above works end-to-end against the real API on localhost;
the frontend imports ONLY generated TS types (no hand-duplicated domain types); zero numerical /
portfolio / compatibility logic in TS (compatibility = allow-list lookup; all numbers rendered
from server records); frontend tests green; gates (extended with web stages) green on both
scripts; CLAUDE.md run-frontend command filled; LEARNING_LOG M11 entry written.

**Exclusions (owning milestone/decision):** component authoring UI, component palette entries,
collapse/expand → M12. Auth/users/collab/Postgres/workers/live data/brokerage → deferred (ADR-0004,
MVP_PLAN globally deferred). Backend CORS change → not needed (D3). Browser e2e (Playwright),
charting libraries, ajv client validation, i18n, routing library, state library → not in M11 (D6,
D9, D11). Structured cycle-membership diagnostic field → deferred unless founder asks for
full-cycle highlight (M10 plan exclusion stands; editor highlights `subject` node).

## 3. User journey (the vertical proof)

open app → palette (from `GET /v1/node-types`) → new strategy (or load via
`GET /v1/strategies` → `.../versions/{v}`) → drag nodes, connect ports (allow-list feedback;
incompatible drop shows "TimeSeries[Number] → CrossSection[Number] is not an allowed connection"
composed from catalog labels) → edit params (form from verbatim `parameter_schema`) → Validate
(`POST /v1/strategies/validate`; diagnostics highlight node/edge via `loc`/`subject`) → Save as
new version (`POST /v1/strategies`; 409 → prompt) → upload dataset (`POST /v1/datasets`) or pick
one (`GET /v1/datasets`, new in S1) → Run backtest + forward (`POST /v1/runs/...`) → results
(`GET /v1/runs/{id}`: valuations SVG chart, total_return, max_drawdown, fills table) → click a
session date → trace (`GET /v1/runs/{id}/trace?session_date=`), grouped by
(timestamp, component_path, node_id), structured payloads rendered.

## 4. Ratified decisions — DO NOT REOPEN

| # | Decision | Selected contract | Evidence / reason | Consequence |
|---|---|---|---|---|
| D1 | Frontend location & toolchain | New top-level `web/` with its own `package.json` (React 18, `@xyflow/react`, Vite, TypeScript, vitest, @testing-library/react — nothing else), `engines >=24 <25`. Root package.json stays codegen-only. | Root pkg is deliberately minimal (codegen); mixing editor deps in would couple the codegen CI lock to UI churn. | Two `npm ci` targets; gate/CI grow web stages (D8). |
| D2 | Generated types reach `web/` by direct import | `web/tsconfig.json` path alias `@quantize/*` → `../ts/*`; import `NodeCatalogResponse`, `StrategyDocument`, etc. from the committed `.d.ts`. NEVER copy or re-declare; no npm packaging. | CLAUDE.md invariant 4; `ts/*.d.ts` are compile-gated since M10.4. | A codegen regen immediately type-checks the web app; drift impossible. |
| D3 | Dev connectivity: Vite proxy, no CORS | `web/vite.config.ts` proxies `/v1` → `http://127.0.0.1:8000`. NO backend CORS middleware. Frontend uses relative `/v1/...` URLs. | M9 plan said CORS "arrives with M11, scoped"; a proxy needs ZERO backend change and matches the future same-origin serving story. | Backend untouched for connectivity; run cmd = uvicorn + `npm run dev`. |
| D4 | Canonical state = one in-memory `StrategyDocument` | A single document store holds the parsed `StrategyDocument` (generated type). All semantic mutations go through pure reducer functions (`addNode`, `removeNode`, `connect`, `disconnect`, `setParams`, `setNodeUi`) in `web/src/document/`. React Flow nodes/edges are DERIVED via one mapping module (`document ↔ ReactFlow`); RF interaction events dispatch reducers. Node positions live in `node.ui.position {x,y}` (instance `ui.*`, preserved round-trip, excluded from semantics). | CLAUDE.md invariant 1; ADR-0002. Avoids a second graph model whose semantics drift. | Save serializes the store document verbatim; load replaces it; RF is disposable view state. |
| D5 | Compatibility = allow-list lookup, labels for reasons | Editor tests a candidate edge by structural equality of `(source.port_type, destination.port_type)` against the catalog `compatibility` pairs (data). Rejection message composed from the two catalog `label`s. No type logic in TS. | M10 shipped the pairs + labels for exactly this; CLAUDE.md invariant 5. | New port types/widenings flow from the server with zero TS change. |
| D6 | Param forms: schema-subset renderer, server-authoritative validation | Form controls derived from the guarded 14-keyword schema subset (integer/number inputs with min/max, boolean checkbox seeded by `default`, string, unique-string-array chip editor for `tickers`, two-branch `oneOf` toggle for `fixed_weight`). Unrenderable constructs → raw-JSON textarea fallback. NO ajv; authoritative validation = `POST /v1/strategies/validate` (debounced/on-demand), whose `invalid_parameters` `loc` carries the param path. | M10's keyword-guard test bounds the renderer; validate endpoint is run-faithful with structured `loc`. Avoids a dep and a second validator. | Client shows basic constraint hints; server verdict is the truth. Renderer widening = reviewed act paired with the guard test. |
| D7 | Identity & save semantics | Save ALWAYS bumps `strategy.version` (ui-only edits under same version 409 by design — M9 founder decision #1). New strategy: editor mints `strategy.id` (uuid v4) and fills provenance with the fixed pre-auth placeholder user uuid `00000000-0000-0000-0000-000000000001` (constant in `web/src/config.ts`, documented as pre-auth). 409 on save → dialog offering bump-and-retry. | M9 contract (byte-idempotent 200 / conflict 409); no auth exists by design. | Placeholder uuid is swapped at the auth milestone; documents remain valid IR. |
| D8 | Gate/CI extension | `scripts/gate.ps1` + `gate.sh` (change together) append two stages after tsc: `web typecheck` (`tsc --noEmit` in web/) and `web test` (`vitest run`). CI adds a `web` job (Node 24, `npm ci` in web/, typecheck + test + `vite build`). Gate does NOT run `vite build` (CI-only; keeps local gate fast). | CLAUDE.md: pytest line already promises "frontend tests from M11". | Every slice from S2 on must keep web stages green. |
| D9 | Results rendering: no chart library | Valuations = one hand-rolled SVG polyline component (pure presentation, points from server `valuations`); returns/drawdown/total shown from record fields; fills/evaluations as tables. NO client-side computation of returns/drawdown (already in the record). | Invariant 5 (no numerics); YAGNI on a chart dep. | If richer charts are wanted later, a lib swap is additive. |
| D10 | Trace rendering: client-side grouping only | `GET /v1/runs/{id}/trace?session_date=` flat events grouped in TS by `(timestamp, component_path, node_id)` into a tree (pure presentation, mirrors server `tracing/tree.py` ordering); known event types (`select.selected`, `transform.excluded`, `engine.orders_proposed`, `engine.note`, `rank.assigned`, ...) get tailored rows keyed on machine tokens; unknown types render generic structured payload. No prose parsing. | M10 planning ratified grouping-as-presentation (G7); payload reason fields are machine tokens. | New event types degrade gracefully to the generic renderer. |
| D11 | Frontend testing = vitest + RTL, hand-mocked fetch | Unit tests for reducers/mapping/compat-lookup/form-renderer/api-client with a tiny fetch mock; component tests via @testing-library/react + jsdom. No msw, no Playwright, no network in tests. Fixtures = small typed literals + the committed `tests/goldens/node_catalog.json` (read as a file fixture) so the palette test tracks the real catalog. | No-network test rule; msw is a dep with no payoff at this size. | E2E deferred; the vertical journey is proven manually + by the API tests already covering the server half. |
| D12 | One backend addition: `GET /v1/datasets` list | New endpoint returning `DatasetList{datasets: tuple[DatasetListRow,...]}` (row: dataset_id, dataset_fingerprint, calendar_fingerprint, sessions, assets, saved_at). Additive repository query (no migration), DTO rides the API codegen bundle, hardening endpoint set updated. | Genuine gap: runs need a `dataset_id` but datasets are undiscoverable across sessions (only POST + GET-by-id exist); strategies/runs both have list endpoints — this is the one asymmetry. localStorage-only discovery would make the client a second source of truth for server state. | The ONLY backend change in M11. Flip-point: founder may veto → S6 falls back to upload-only + localStorage memo. |
| D13 | UI composition | Single-page app, no router: left palette, center React Flow canvas, right inspector (params/validation), bottom tabbed panel (Strategies / Datasets / Runs / Results / Trace). Plain CSS (one stylesheet); no UI framework. | Smallest legible screen; routing adds nothing at one screen. | M12 adds panels, not architecture. |

## 5. Architecture delta (from M10)

New: `web/` (Vite React app) + one backend endpoint (D12). Nothing else changes server-side.

```
web/src/
  api/client.ts        typed fetch wrappers for every /v1 endpoint (generated types in/out)
  config.ts            placeholder user uuid, constants
  document/            store.ts (StrategyDocument + reducers)  flow.ts (doc ↔ ReactFlow mapping)
  catalog/             catalog fetch + compat lookup (pair set) + label helpers
  components/          Palette, Canvas, Inspector/ParamForm, ValidatePanel, StrategyPanel,
                       DatasetPanel, RunPanel, ResultsView (SvgLineChart), TraceView
  App.tsx, main.tsx

data flow:
  /v1/node-types ──► catalog (palette, port badges, compat pairs, labels, param schemas)
  StrategyDocument store ──reducers──► doc ──mapping──► ReactFlow view ──events──► reducers
  doc ──serialize──► POST /v1/strategies | /validate     diagnostics(loc,subject) ──► highlights
  POST /v1/datasets, GET /v1/datasets ──► dataset_id ──► POST /v1/runs/{backtest,forward}
  GET /v1/runs/{id} ──► ResultsView      GET .../trace?session_date ──► group ──► TraceView
```

## 6. Contract/API delta

- **New:** `GET /v1/datasets` → `DatasetList` (rows as in D12). DTOs in `quantize/api/dto/datasets.py`
  (additive), root appended to `_API_ROOT_MODELS`, artifacts regenerated, `_SAMPLES` +
  forbid-unknown + TS-presence lists extended, `test_hardening.py` endpoint set updated.
  `saved_at` string, same convention as `StrategyListRow.saved_at`.
- **No other public-contract change.** No M9/M10 DTO reshaped; IR bundle byte-unchanged; no
  OpenAPI export; frontend consumes existing contracts verbatim.

## 7. State & persistence delta

- Backend: one additive SQL SELECT in `DatasetRepository` (list). **No migration** (v2 schema has
  the columns; verify at S1 — if a needed column like a timestamp is absent, list rows omit
  `saved_at` rather than migrate; STOP only if the table lacks even identity columns).
- Frontend: in-memory document store (D4); `localStorage` allowed ONLY for UX convenience
  (last-opened strategy id, last dataset id) — never as a source of truth.
- `ui.position` written into node `ui.*` (already round-trip-preserved, semantics-excluded).

## 8. Long-term product check

D4 keeps the persisted IR canonical (Figma-like canvas stays a view — later collab/multi-client
sits behind the same document store seam). D5/D6 keep the expressive ceiling server-owned: new
port kinds (Matrix), richer schemas (formulas, optimizer configs) arrive as catalog data + schema
constructs, degrading to the raw-JSON fallback until the renderer is deliberately widened.
D10's generic trace renderer absorbs new event types. Nothing here needs a rewrite for components
(M12 renders `ComponentRef` nodes from `/v1/components` data through the same mapping seam),
sandboxed code, or hosted deployment (same-origin serving replaces the dev proxy). Overbuild
avoided: no state/chart/router/validation libraries, no e2e infra, no CORS/auth surface.

## 9. Implementation slices (ordered; each gate-green and Codex-reviewable)

Branch `feat/m11-editor` off `origin/main` (`cd788b1`) — fetch first. One commit per slice,
`M11.x: <summary>`. Standing stop conditions for EVERY slice: IR bundle byte-change; M9/M10 DTO
reshape; any engine/node/migration change; any pre-existing golden movement; hand-editing a
generated artifact; any numerical/portfolio/compatibility LOGIC in TS.

- **M11.1 — `GET /v1/datasets` (backend, D12).** Repository list query + route + `DatasetListRow`/
  `DatasetList` DTOs + codegen regen + contract/hardening/endpoint tests. Only backend slice.
- **M11.2 — web scaffold + typed API client + gate extension (D1,D2,D3,D8).** `web/` Vite app,
  tsconfig alias to `../ts`, vitest+RTL wiring, `api/client.ts` covering every endpoint with
  generated types, fetch-mock tests, gate.ps1/gate.sh web stages, CI `web` job, CLAUDE.md
  run-frontend command.
- **M11.3 — document store + flow mapping (D4).** Reducers over `StrategyDocument`; `ui.position`
  handling; doc↔ReactFlow mapping; round-trip tests (incl. ui.* preservation + verbatim unknown
  fields); serialization equals loaded bytes for an untouched doc.
- **M11.4 — catalog, palette, canvas, connections (D5).** Catalog fetch/context; palette;
  React Flow canvas rendering mapped nodes (typed handles, labels, required badges);
  drag-to-add (dispatch addNode with schema `default`-seeded params); connect gated by pair
  lookup with composed rejection reason; delete node/edge.
- **M11.5 — param forms + validate + save/load/version (D6,D7).** Schema-subset ParamForm (incl.
  oneOf toggle, tickers chip array, raw-JSON fallback); Inspector; ValidatePanel calling
  /validate, rendering per-layer diagnostics, highlighting via `loc`/`subject`; StrategyPanel
  (list/load/new); save-as-new-version with 409 dialog.
- **M11.6 — datasets, runs, results (D9,D12).** DatasetPanel (upload JSON → POST, list via S1,
  select); RunPanel (backtest + forward forms: initial_cash, sessions, dataset); run list;
  ResultsView (SVG valuations chart, record stats, fills/evaluations tables).
- **M11.7 — trace explorer + closeout (D10).** TraceView (session-date picker from record
  evaluations; fetch + group + tree with component hierarchy; tailored known-event rows, generic
  fallback); final sweep (no numerics/no hand-typed domain types greps for web/), LEARNING_LOG
  M11 entry, CLAUDE.md final wording, both gates + CI green, plan closeout.

## 10. Opus execution packets (standalone; execute strictly in order)

### Shared preamble (applies to every packet; read once per packet)
Repo C:\GitHubProjects\Quantize. Baseline for M11.1: branch `feat/m11-editor` off **`origin/main`**
(`cd788b1`) after `git fetch origin` (local refs can be stale). Later packets start where the
previous one committed. Read FIRST: this plan's §4 (ratified decisions — do not re-derive) and the
packet itself; read the listed authoritative files before coding. TDD: write the packet's tests,
watch them fail, implement, go green. Python: `.venv/Scripts/python.exe -m pytest <paths>`.
Node MUST be 24: run `./scripts/node24.ps1` in the same shell before any npm/node/tsc/vite/vitest
command. Gate = `./scripts/gate.ps1` AND `bash scripts/gate.sh` — BOTH green before "done"
(867 py tests baseline; web stages exist from M11.2 on). Standing stops (any → HALT and report):
IR bundle (`schema/quantize.schema.json`, `ts/quantize-ir.d.ts`) byte-change; reshaping any
existing DTO; engine/node/migration change; pre-existing golden movement; hand-editing generated
artifacts; numerical/portfolio/compatibility LOGIC in TS; anything ambiguous the plan doesn't
resolve. One commit, message `M11.x: <summary>` + trailer
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. NO push/merge/PR. Completion report:
files changed; test counts before/after; actual gate output (both scripts); deviations (expect
none); self-review results.

### Packet M11.1 — `GET /v1/datasets` list endpoint (backend only)
Read: `quantize/persistence/datasets.py`, `quantize/api/routes/datasets.py`,
`quantize/api/dto/datasets.py`, `quantize/api/routes/strategies.py` (list pattern),
`quantize/codegen/schema.py:79-97`, `tests/api/test_dataset_upload.py`,
`tests/api/test_api_contract.py`, `tests/api/test_hardening.py:68-87`.
Scope: (1) `DatasetRepository.list()` — additive SELECT over the datasets table returning
identity/summary columns, deterministic order (by saved-at desc then dataset_id, or dataset_id if
no timestamp column exists — check the v2 migration in `quantize/persistence/migrations.py`; if
the table lacks a timestamp, OMIT `saved_at` from the row DTO rather than migrate). (2) DTOs
`DatasetListRow` (dataset_id, dataset_fingerprint, calendar_fingerprint, sessions, assets,
saved_at if available) + `DatasetList{datasets: tuple[...]}` on `_Dto`, additive in
`dto/datasets.py`. (3) Route `GET /v1/datasets` on the existing datasets router (no DB schema
change; per-request `Database` handle exactly like the sibling GET). (4) Append `DatasetList` to
`_API_ROOT_MODELS`; `./scripts/node24.ps1` then `.venv/Scripts/python.exe -m quantize.codegen
generate`; commit regenerated `schema/quantize-api.schema.json` + `ts/quantize-api.d.ts`
(IR pair MUST be untouched). (5) Tests: repository list (empty; two datasets; ordering; row
fields match `describe()`), endpoint happy path via `client`+`db` fixtures (upload two → list
returns both), `_SAMPLES` entry + forbid-unknown + TS-presence additions, add `"/v1/datasets"`
GET to the hardening endpoint set (path already present for POST — verify how openapi keys it;
the set is by PATH so it may already contain `/v1/datasets`; if so no set change — assert methods
via the route test instead).
Acceptance: gates green; `codegen check` clean; endpoint returns uploaded datasets with correct
identities. Exclusions: no pagination/filtering; no frontend. Stop: any migration needed.
Focused: `.venv/Scripts/python.exe -m pytest tests/api/ tests/test_persistence_datasets.py -q`.

### Packet M11.2 — web scaffold + typed API client + gate extension
Read: root `package.json`, `tsconfig.json`, `ts/quantize-api.d.ts` (interface names/shapes),
`ts/quantize-ir.d.ts` (StrategyDocument), `scripts/gate.ps1`, `scripts/gate.sh`,
`.github/workflows/ci.yml`, CLAUDE.md Repository commands, plan §4 D1/D2/D3/D8/D11.
Scope: (1) `web/` Vite React-TS app (npm create vite pattern, engines `>=24 <25`); deps ONLY:
react, react-dom, @xyflow/react; dev: typescript, vite, @vitejs/plugin-react, vitest, jsdom,
@testing-library/react, @testing-library/jest-dom, @types/react{,-dom}. Commit `web/package-lock.json`.
(2) `web/tsconfig.json` strict, path alias `@quantize/*` → `../ts/*` (also vitest/vite resolve
alias). (3) `web/vite.config.ts` with `/v1` proxy → `http://127.0.0.1:8000` (D3). (4)
`web/src/api/client.ts`: typed wrappers for EVERY endpoint (meta, node-types, strategies
save/list/versions/load/validate, components list/load, datasets upload/list/get, runs
backtest/forward/list/get/trace) using generated types for params/results; single `ApiError`
handling path (non-2xx → typed error with code/message from the envelope); relative URLs.
(5) Tests (vitest, hand-mocked global fetch per D11): client builds correct method/URL/body and
parses typed results; error envelope path; NO network. (6) Gate: append `web typecheck`
(`npx tsc --noEmit` in web/) and `web test` (`npx vitest run`) stages to BOTH gate scripts
(after tsc stage; keep fail-fast + stage echo style); CI: new `web` job (Node 24 via .nvmrc,
`npm ci` in web/, typecheck, vitest run, `vite build`). (7) CLAUDE.md: fill "Run frontend
(editor)" = `cd web && npm run dev` (with uvicorn note) and note the web gate stages.
Acceptance: `npm run dev` serves a placeholder App; both gates green INCLUDING new stages;
CI yaml valid. Exclusions: no canvas/palette/panels yet. Stop: any need to alter root
package.json beyond nothing (root stays untouched); alias cannot resolve generated types.
Focused: in web/ `npx tsc --noEmit && npx vitest run`.

### Packet M11.3 — document store + ReactFlow mapping
Read: `ts/quantize-ir.d.ts` (StrategyDocument/RegisteredNode/Edge/ui), `ts/fixtures/usage.ts`
(shape examples), plan §4 D4/D7, `tests/fixtures/strategy_a.json` (real doc), @xyflow/react
Node/Edge types (web/node_modules).
Scope: `web/src/document/store.ts` — a plain reducer module: state = `StrategyDocument`; pure
functions `addNode(doc, {typeId, typeVersion, params, position}) → doc` (mints node id
`n_<uuid>`; writes `ui: {position}`), `removeNode` (drops incident edges), `connect(doc,
{from:[node,port], to:[node,port]}) → doc` (append edge; NO validity logic here — gating is the
canvas's job via D5), `disconnect`, `setParams`, `setNodeUi`; `newStrategyDocument(name)` per D7
(uuid id, version 1, placeholder provenance from `web/src/config.ts`, current schema_version
read from a meta fetch or constant "0.1.0" — pin constant, assert against `/v1/meta` at runtime
with a console warning on mismatch, not a crash); React `useReducer` wrapper hook.
`web/src/document/flow.ts` — `toFlow(doc, catalog) → {nodes, edges}` (RF node data: type_id,
display_name, ports with labels; position from `ui.position` defaulting to a simple grid) and
event mappers back to reducer actions. Round-trip law: `toFlow` is read-only; ONLY reducers
change the doc.
Tests-first: reducers preserve unknown/extra document fields verbatim (load strategy_a.json
fixture (copy into web test fixtures or read via vite raw import from ../../tests/fixtures —
prefer a small committed copy `web/src/testing/strategy_a.json` with a comment naming the source
of truth), mutate ui only, JSON round-trip equals original except the touched field);
addNode/removeNode/connect/disconnect behavior incl. incident-edge cleanup; ui.position
write/read; `newStrategyDocument` passes the generated-type checker and has version 1;
toFlow maps every node/edge and default-positions nodes without ui.
Acceptance: gates green (py + web). Exclusions: no rendering/components, no compat gating.
Stop: any temptation to normalize/strip fields the IR carries (verbatim preservation is the law).
Focused: `npx vitest run src/document`.

### Packet M11.4 — catalog, palette, canvas, connections
Read: plan §4 D5/D13, `tests/goldens/node_catalog.json` (real payload), M11.3 modules,
@xyflow/react docs in node_modules README (Handle/NodeTypes/onConnect APIs).
Scope: `web/src/catalog/index.ts` — fetch `GET /v1/node-types` once (context/provider), expose:
node list, `paramSchema(typeId)`, `portsOf(typeId)`, `isAllowed(sourcePortType, destPortType)`
(structural-equality membership test against the `compatibility` pairs — implement as a Set keyed
by `JSON.stringify` of the canonicalized `{kind,dtype?}` pair; DATA lookup only), `labelOf(portType)`
(from `port_types` entries; fall back to a local template ONLY if absent — it never is).
`web/src/components/Palette.tsx` — catalog entries grouped by `type_id` namespace prefix
(derivation, not a contract), drag source. `Canvas.tsx` — React Flow instance over
`toFlow(doc, catalog)`; custom node component showing display_name + typed handles (required
badge on required inputs); drop from palette → `addNode` with `default`-seeded params (walk the
schema's `properties.*.default`s; absent → omit key); `onConnect` → `isAllowed` ? dispatch
`connect` : show rejection toast/inline message: `"<srcLabel> → <dstLabel> is not an allowed
connection"`; node/edge deletion → reducers; node drag end → `setNodeUi` position.
Tests-first: isAllowed agrees with the committed golden's 9 pairs (positive) and rejects a known
bad pair (TimeSeries[Number]→CrossSection[Number]); palette groups/lists the 13 golden entries;
addNode default-seeding (rank gets `{descending:true}`, moving_average gets `{}` since `window`
has no default); RTL smoke: canvas renders a small doc's nodes; connect handler dispatches vs
rejects with the composed message.
Acceptance: gates green; manual: build a two-node valid connection in the browser, see rejection
on an invalid one. Exclusions: param editing UI, validation, persistence panels. Stop: any
compatibility rule expressed as TS conditionals over kinds/dtypes (allow-list membership ONLY).
Focused: `npx vitest run src/catalog src/components`.

### Packet M11.5 — param forms, validate, save/load/version
Read: plan §4 D6/D7, `quantize/api/dto/validate.py` (diagnostic shape), golden catalog param
schemas (oneOf/tickers/defaults), `tests/api/test_strategy_component_endpoints.py` (save
semantics: 201/200/409).
Scope: `ParamForm.tsx` — renderer over the 14-keyword subset per D6: number/integer (min/max/
exclusiveMinimum hints), boolean, string(minLength), unique-string array chip editor, two-branch
oneOf toggle (const literal vs number), required markers from schema `required`; anything else →
raw JSON textarea bound to the param key; onChange → `setParams` (values kept as JSON — no
coercion beyond input type). `Inspector.tsx` — selected node: identity, description, ParamForm.
`ValidatePanel.tsx` — button → `POST /v1/strategies/validate` with the serialized doc; render
structural/semantic/runtime arrays (code + message + subject), `warmup_sessions` on ok; clicking
a diagnostic highlights: `loc ("nodes", i, ...)` → select node i; `("edges", i, ...)` → highlight
edge i; runtime `node_path` → select node by id. Invalid-while-editing is NORMAL (200 ok:false).
`StrategyPanel.tsx` — list (`GET /v1/strategies`), load version (list versions → GET version →
replace store doc), "New strategy" (D7), Save: serialize doc; POST; 201/200 → refresh list; 409 →
dialog "version exists with different content — save as version N+1?" → bump `strategy.version`
and retry once.
Tests-first: ParamForm renders rank/fixed_weight/fixed_list schemas correctly (checkbox seeded
true; oneOf toggle switches "equal"↔number; chip add/remove keeps uniqueness) and falls back to
raw JSON on an unknown construct; validate response mapping → diagnostic list + correct highlight
target computed from loc; save flow: mocked 409 then success after bump; load replaces doc
verbatim (byte-compare JSON).
Acceptance: gates green; manual: edit rank param, validate an incomplete graph, see
required_input_unconnected highlighted; save v1, edit, save v2. Exclusions: datasets/runs/trace.
Stop: adding ajv or any client-side re-validation beyond input-control constraints.
Focused: `npx vitest run src/components/ParamForm src/components/ValidatePanel src/components/StrategyPanel` (adjust to actual test paths).

### Packet M11.6 — datasets, runs, results
Read: plan §4 D9/D12, `quantize/api/dto/datasets.py` + `dto/runs.py` (request/response shapes),
`tests/api/test_run_endpoint.py` (windowed run params that work: strategy A,
2025-07-31..2025-08-29), `tests/api/test_results_traces_endpoints.py`.
Scope: `DatasetPanel.tsx` — file input reading a dataset JSON → `POST /v1/datasets` (201/200 both
fine; show identities), list via `GET /v1/datasets` (M11.1), select active dataset (remember in
localStorage as convenience only). `RunPanel.tsx` — forms for backtest (strategy id+version from
current doc; dataset; initial_cash; optional first/last_session) and forward (same + required
last_session); submit → run_id; runs list (`GET /v1/runs?strategy_id=`) with ok/mode/total_return;
select run → ResultsView. `ResultsView.tsx` — `GET /v1/runs/{id}`: `SvgLineChart` (pure component:
points scaled from `valuations`; axes min/max labels only), stat row (total_return, max_drawdown,
final cash — rendered, never computed), fills table (session, side, asset, qty, price, scaled),
evaluations table (session, targets, orders, fill_session). `replay_verifiable` badge.
Tests-first: SvgLineChart maps a known valuations array to expected polyline points (pure fn
test); RunPanel builds correct request bodies (incl. forward's required last_session); ResultsView
renders stats/tables from a fixture record (typed literal from `ts/quantize-api` shapes);
DatasetPanel upload→list refresh with mocked client.
Acceptance: gates green; manual vertical: upload the reference dataset JSON (construct from
`tests/` market fixture via the API once), run backtest + forward on strategy A window, see chart
+ tables. Exclusions: trace view; verify endpoint (M9.9 stays deferred). Stop: computing ANY
derived number client-side (returns, drawdown, PnL — all come from the record).
Focused: `npx vitest run src/components/DatasetPanel src/components/RunPanel src/components/ResultsView` (adjust).

### Packet M11.7 — trace explorer + closeout
Read: plan §4 D10, `quantize/api/dto/runs.py` (TraceResponse/TraceEvent), `quantize/tracing/tree.py`
(grouping/ordering contract to mirror), `tests/goldens/trace_strategy_a_componentized.json`
(component_path examples), `quantize/engine/trace.py` + node payload docs for known event fields,
`docs/LEARNING_LOG.md` (entry format), this plan (closeout).
Scope: `TraceView.tsx` — session-date picker (dates from the selected run record's evaluations);
`GET /v1/runs/{id}/trace?session_date=`; group flat events by (timestamp, component_path, node_id)
into a nested tree mirroring server ordering (pure fn in `web/src/trace/group.ts`); component
hierarchy shown as nesting; tailored renderers keyed on event_type/machine tokens for:
`select.selected` (n/selected/unselected), `transform.excluded` (asset + reason token),
`rank.assigned`, `engine.orders_proposed` (orders + omitted with dust/hold reasons),
`engine.orders_filled` (scaled flag), `engine.note` (code); everything else → generic
key/value payload renderer. NO prose parsing anywhere.
Closeout: sweep tests/greps — (a) `web/src` contains no hand-declared domain interfaces
duplicating `ts/*.d.ts` names (grep for `interface StrategyDocument|NodeCatalogResponse|
PortType` etc. in web/src → none); (b) no compatibility conditionals (grep web/src for
`kind ===` outside the catalog lookup module → review hits); (c) run BOTH gates end-to-end;
(d) `docs/LEARNING_LOG.md` M11 entry (concepts: document-as-store with derived views; allow-list
data vs logic; schema-driven forms; presentation grouping of traces — with Where pointers,
reading path web/src/document → catalog → components, one by-hand exercise + prediction);
(e) CLAUDE.md final run-frontend wording; (f) append Closeout to this plan (gate outputs, final
py+web test counts, deviations, flip-point D12 state).
Tests-first: group() reproduces the tree shape for a fixture event list including a
component_path nesting case; tailored renderer picks the right component per event_type and
falls back generically for an unknown type.
Acceptance: BOTH gates green end-to-end; the full §3 journey works manually in the browser;
closeout written. Exclusions: M12 (component authoring/palette/collapse), trace-tree backend
endpoint (client grouping stands per D10). Stop: any server change.
Focused: `npx vitest run src/trace` then both gates.

## 11. Codex review strategy

- Focused independent review after **M11.1** (public contract) and **M11.3** (state architecture —
  the drift-risk core).
- Focused review after **M11.5** (save/version + validation UX = contract-sensitive).
- Full-diff review + fix verification after **M11.7** (whole milestone) before any merge request.
- Reviews check specifically: invariant 4 (no hand TS domain types), invariant 5 (no logic in
  frontend), D4 single-source-of-truth, M12 scope leaks.

## 12. Final Fable review

One bounded final review after M11.7: inspect `web/src/document/` + `api/client.ts` against D4/D2,
grep-sweeps from M11.7, the M11.1 contract vs M9 conventions, and roadmap-checkmark coverage.
No multi-agent fleet.

## 13. Founder decisions

None blocking. One flip-point: **D12** (`GET /v1/datasets`) — veto makes M11.6 upload-only with a
localStorage memo; one-slice change.

## 14. Continuation checkpoint

- **Plan COMPLETE**: sections 1–14 all written, including all seven Opus packets (§10) and the
  Phase-6 self-review (no corrections required beyond in-packet conditionals). Baseline: main @
  `cd788b1`, clean, M10 merged (PR #13), 867 tests.
- Remaining work: **none for planning**. Next action: begin execution with Packet M11.1 on a new
  branch `feat/m11-editor` off `origin/main` (fetch first), per §10's shared preamble.
- Founder flip-point outstanding (non-blocking): D12 (`GET /v1/datasets`) — veto before M11.1
  starts converts M11.6 to upload-only + localStorage memo and drops M11.1.
