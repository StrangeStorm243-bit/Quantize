# CLAUDE.md — Quantize

Guidance for Claude (and the founder) working in this repository. Read this before changing code.
The normative specs are `docs/PRODUCT.md`, `docs/STRATEGY_LANGUAGE.md`, `docs/ARCHITECTURE.md`,
and `docs/ADRS/`.

## What this project is

A visual operating system for quantitative trading. A strategy is a **versioned, serializable JSON IR**
(the persisted instance and semantic source of truth) that **one session-level engine** evaluates for
historical backtesting and forward/paper replay using **the same node implementations and semantics**,
with **structured decision tracing**. The visual canvas is only an editor for the IR.

### Source-of-truth hierarchy (use consistently)
1. The versioned **JSON strategy document** — persisted instance & semantic source of truth.
2. The published **JSON Schema** — language-neutral structural contract for a schema version.
3. **Pydantic** — the v0 authoring/generation/parsing/validation implementation.
4. **Registry rules + runtime invariants** — semantic validation.
5. **Generated TypeScript types** — consume the schema; never hand-maintained.

## Repository commands

> Filled in as milestones land. Keep this section current — it is the first thing a new agent reads.

- **Python:** canonical **3.14** (toolchain-gate-verified, M1.0; tested range `>=3.13,<3.15`).
- **Create env:** `python -m venv .venv` then activate (`.venv\Scripts\activate` on Windows /
  `source .venv/bin/activate` on POSIX). Direct interpreter on Windows: `.venv/Scripts/python.exe`.
- **Install (dev):** `python -m pip install -e ".[dev]"`. Pinned lock: `requirements.lock.txt`
  (regenerate with `python -m pip freeze --exclude-editable > requirements.lock.txt`).
  `requirements.lock.txt` records the exact package versions used by the canonical development
  environment (Python 3.14). CI installs those pinned versions to reduce dependency drift.
  Artifact-level and cross-platform reproducibility are **not guaranteed yet** because hash pinning
  and platform-aware locking are deferred; the lock is canonical to 3.14 and is not portable to other
  Python versions verbatim.
- **Run tests:** `pytest` (runtime; frontend tests from M11).
- **Lint:** `ruff check .` · **Format check:** `ruff format --check .` · **Type-check:** `mypy`.
- **Full gate (canonical):** `./scripts/gate.ps1` — pytest, ruff check, format check, mypy, Node-24
  activation, `codegen check`, `npm run typecheck`, fail-fast, from any cwd. Run it before claiming
  a milestone or slice done. POSIX sibling: `bash scripts/gate.sh` — identical stage set and order;
  change both scripts together.
- **Node:** baseline **24 LTS** (`.nvmrc`; `engine-strict`). The system Node may differ, and
  non-interactive shells do not load the user profile, so a bare `node`/`npm`/`tsc`/codegen call can
  resolve to the wrong Node. Before any Node-dependent command, run `./scripts/node24.ps1` in the
  same shell process — it locates fnm without a profile, activates Node 24, and asserts `v24.*`
  (fails loudly otherwise). Interactive terminals may auto-initialize fnm. Install locked deps with
  `npm ci` under Node 24; never run the Node toolchain under Node 25+.
- **Run backend / API (M9):** `uvicorn quantize.api.app:create_app --factory --host 127.0.0.1
  --port 8000` (localhost binding is the documented default — no auth exists by design; the DB
  path is `QUANTIZE_DB_PATH`, default `quantize.db`). `GET /v1/node-types` (M10) serves the
  read-only node-type descriptor + parameter-form + compatibility metadata (M11 editor
  prerequisites).  ·  **Run frontend (editor):** _TBD (M11)_
- **Generate JSON Schema + TS types (codegen):** `python -m quantize.codegen generate` (emits
  `schema/quantize.schema.json` + `ts/quantize-ir.d.ts`; needs Node 24 on PATH for the TS step).
  Verify without writing: `python -m quantize.codegen check`. TypeScript compile gate: `npm run
  typecheck` (`tsc --noEmit`). Output is deterministic and byte-stable (LF; see `.gitattributes`),
  committed, and CI’s `codegen` job fails if the committed artifacts are stale. The committed JSON
  Schema is the exported structural contract; the `.d.ts` is a **derived** artifact — never hand-edit
  it, regenerate instead.

## Architectural invariants (do not violate without an ADR)

1. **The persisted JSON IR document is the source of truth.** The canvas, React, and React Flow are
   disposable views. `ui.*` is **preserved through round-trip** but **excluded from execution and
   semantic equality** — never discarded, never affects results. Two documents differing only in
   `ui.*` are semantically identical.
2. **One engine + one evaluator + one set of node implementations.** Backtest and forward replay
   differ **only** in adapters (Clock, MarketData, Broker/Fills, Storage). Never write a second
   implementation of a node or rule for "the other mode." **The strategy graph terminates in
   `PortfolioTargets`; the engine — not the graph — owns reconciliation** (`current portfolio +
   PortfolioTargets + policy → OrderList`). There is **no** order-generation graph node.
3. **Temporal access is structurally constrained and tested — not "impossible."** Each evaluation
   sees only data with availability ≤ the evaluation instant; this is enforced and tested, but does
   not make look-ahead categorically impossible. v0 has exactly **one** execution policy
   (`close_signal_next_session_open`): evaluate after session D close → fill at the **next valid
   exchange session open** ("D+1" = next session, not next calendar day). Represent policy explicitly;
   implement only this one.
4. **Honor the source-of-truth hierarchy.** Pydantic authors the published JSON Schema; TS types are
   generated from the schema. **Never hand-duplicate domain types** across Python and TypeScript. CI
   fails on stale generated types. Pydantic is an implementation, not "the canonical IR."
5. **No business logic in the frontend.** No numerical, portfolio, or type-compatibility logic in
   React. The single `is_compatible` function lives in Python and is shared by validator and editor.
6. **No Python objects in API contracts.** pandas/numpy are runtime implementation details; never
   expose a DataFrame/array across the boundary. Contracts are plain JSON DTOs.
7. **Node registry, not switch statements.** Node types self-register with the uniform contract.
   Adding a type is one self-contained registration.
8. **Components are standalone, real compositional objects.** Each is a separate immutable
   `ComponentDefinition` document; strategies hold pinned `ComponentRef`s. Evaluated compositionally
   (never flattened, no stub/temporary expansion); **direct and transitive recursion rejected**.
   Traces preserve the component hierarchy. Component **runtime** lands before any milestone that
   executes components; component **authoring UI** is a separate, later milestone.
9. **Fail loud — at the right layer.** An **unsupported `schema_version`** fails at **structural
   load (M1)**. An **unknown node `type_id`** fails at **M2 registry-semantic validation** — **not**
   M1: M1 *accepts* a structurally valid document referencing an unknown future `type_id` (the
   extensible-block seam), and M2 rejects the unresolved type. Neither is ever silently ignored or
   best-effort parsed.
10. **Explicit data rules.** No silent forward-fill or data dropping. Any fill/alignment rule is
    documented at the node and asserted in a test.
11. **Vectorization is a fenced future optimization** — admissible only with a test proving identical
    outputs and timing to the incremental path. Until then, the incremental path is the only path.

## Coding standards

- Match the surrounding code's style, naming, and comment density. Prefer clarity over cleverness;
  explicit boundaries over implicit coupling.
- Names should reflect domain meaning (`CrossSection`, `PortfolioTargets`, `eval_date`,
  `data_available_at`) — the founder is learning from these names.
- Keep the six runtime concerns separate: validation · planning · evaluation · result storage ·
  tracing · presentation. Do not mix them in one module.
- Pure vs. stateful nodes: declare purity honestly. **v0 ships no stateful nodes.** A future stateful
  node's state must be serializable/checkpointable, update in topological order, and **declare its own
  cadence** (`every_session` or `evaluation_only`) — there is no single universal cadence.

## Test requirements (financial correctness is non-negotiable)

- **Every mathematical/logic node** has unit tests for: correctness, missing data, date alignment,
  warm-up, and look-ahead safety.
- **Type compatibility:** valid and invalid connections, including both reference strategies' exact
  wirings; rejection messages asserted.
- **Contract tests:** representative payloads validate consistently; stale TS types fail CI.
- **Golden/snapshot:** deterministic fixture → committed golden results; number changes are reviewed
  diffs.
- **End-to-end:** Strategy A and B headless; **backtest↔forward consistency** test (M8).
- **Forward/paper = deterministic incremental replay** over local fixture/uploaded data, one session
  at a time. No network, live feed, or broker in the MVP.
- Tests use the small synthetic fixture only. **No network in tests.**
- **Never claim something works because code was written.** Run the relevant tests and report the
  actual results. If tests fail or a step was skipped, say so plainly.

## Scope discipline (read before adding anything)

- **Do not broaden scope without explicit founder approval.** Build the smallest coherent system.
- Do **not** add asset classes, indicators, or node types "to look broad." Add a node type only when
  a concrete strategy needs it.
- Do **not** introduce distributed infra, microservices, Redis, Kubernetes, message buses, or a
  cloud deployment unless a demonstrated MVP requirement forces it (none does yet).
- Do **not** special-case the named reference strategies in engine code — they must be composed from
  general-purpose primitives.
- The deferred features (marketplace, social, payments, AI generation, real brokerage, multi-user)
  are **paths, not work**. Preserve the seams; build none of it.

## Working process (per milestone)

1. Restate the objective. 2. Explain the architectural choice. 3. List files expected to change.
4. Define acceptance tests. 5. Implement only that milestone. 6. Run format + type-check + tests.
7. Summarize the change. 8. Explain the important code to a developing founder. 9. Name remaining
risks/shortcuts. 10. **Wait for review before starting an unrelated milestone.**

Use Git deliberately: one branch/worktree per task, small commits, descriptive messages, no
unrelated refactors mixed into feature work, no large dependency changes without explanation.

## Founder-learning requirement

The founder is building engineering ability while using agents. For each major component: explain
the relevant concept, show where it appears in this repo, give a short code-reading path, propose
one small change for them to implement by hand, and (when apt) ask them to predict behavior before
revealing it. Update `docs/LEARNING_LOG.md` with concepts introduced, files studied, and exercises
completed. Do not hide complexity to move faster.
