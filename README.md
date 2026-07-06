# Quantize

A **local, single-user visual operating system for quantitative trading**. A strategy is authored
once as a single, versioned, serializable **JSON IR document** — the persisted instance and semantic
source of truth — and then *operated* without being rewritten between modes: **one session-level
engine** evaluates that document for historical **backtesting** and **forward/paper replay** using
**the same node implementations, the same semantics, and structured decision tracing**. A browser
editor is the canvas for building and running strategies; the canvas is a disposable view, never the
source of truth.

> **Core promise:** turn a systematic, rules-based strategy into a visual, runnable system — build it
> from typed nodes and reusable components, validate it, version it, and run deterministic backtests
> and forward/paper replays over uploaded daily-bar data, inspecting *why* every decision was made.

See [`docs/PRODUCT.md`](docs/PRODUCT.md) for the product thesis and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/STRATEGY_LANGUAGE.md`](docs/STRATEGY_LANGUAGE.md),
[`docs/MVP_PLAN.md`](docs/MVP_PLAN.md), and [`docs/ADRS/`](docs/ADRS) for the normative specs.

## What Quantize does (the honest claims)

- **One IR, two modes.** A single strategy document runs identically in historical backtest and in
  forward/paper replay — proven field-for-field by a backtest↔forward consistency test, because both
  modes drive **one** engine core and differ only in adapters (clock, market data, fills, storage).
- **Every decision is explainable.** Runs emit structured, schema-versioned **decision traces**;
  the editor renders them as per-instant trees, nested by component, so you can see exactly why a
  strategy selected, ranked, weighted, or skipped each asset.
- **Backtests are deterministic.** Results are byte-reproducible and pinned to committed golden
  files; a number that changes is a reviewed diff, never a surprise.
- **Strategies and components are real versioned objects.** A component is a standalone, immutable
  `ComponentDefinition` referenced by a pinned `ComponentRef` and evaluated **compositionally** at
  runtime — a real object with provenance, not a visual grouping of nodes.
- **Invalid strategies fail loudly.** Structural and semantic validation produce structured
  diagnostics with machine codes; the editor highlights the offending nodes/edges rather than
  failing silently or best-effort guessing.

## Quickstart

Prerequisites: **Python 3.14** (tested range `>=3.13,<3.15`) and **Node 24 LTS** (`.nvmrc`).

**1. Backend (API).** From the repo root:

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
python -m pip install -e ".[dev]"
uvicorn quantize.api.app:create_app --factory --host 127.0.0.1 --port 8000
```

The API binds to localhost with **no authentication** — that is the security boundary by design
(single user, one local workspace). The SQLite DB path is `QUANTIZE_DB_PATH` (default
`quantize.db`).

**2. Frontend (editor).** In a second shell, with Node 24 active (on Windows run
`./scripts/node24.ps1` first in the same shell to activate it):

```bash
cd web
npm ci
npm run dev
```

Vite serves the editor and proxies its `/v1/...` requests to the API on port 8000 (no CORS — same
localhost boundary), so start the backend first.

**3. Seed the demo data.** With the API running, populate your workspace with the deterministic
synthetic dataset and both reference strategies:

```bash
python scripts/seed_demo.py            # defaults to http://127.0.0.1:8000
```

It prints the `dataset_id`, the saved strategy ids, and a **suggested backtest window**
(`2025-07-31..2025-08-29`). It is idempotent — re-running it is a harmless no-op.

**4. Walk the journey.** In the editor:

1. **Load a strategy** (e.g. *ETF Momentum Rotation*) — the canvas shows its typed node graph.
2. **Select the seeded dataset** and **run a backtest** over the suggested window.
3. Open the **results** and the **decision trace** to see why each rebalance traded.
4. **Extract a component**: select a connected subgraph, turn it into a named, versioned component,
   and let the strategy be rewritten to use it — with identical run results.
5. **Reuse it**: drag the component from the palette into another strategy, edit its exposed
   parameters, and inspect its internals read-only.

## Scope & caveats

Quantize is an MVP for **research and education**, not a trading system. Specifically:

- **No live trading, brokerage, or real money.** There is no broker connection and no order routing
  to any venue. Runs are historical backtests and simulated forward/paper replay only.
- **No real or current market data.** The engine runs over the small **synthetic fixture dataset**
  and any **daily-bar data you upload** locally. There is no live, EOD, or vendor data feed.
- **Backtest results do not predict real performance.** They are deterministic evaluations of a
  strategy over the data you provide, for understanding logic and behavior — not a forecast of
  returns, and not investment advice.
- **Single-user, localhost-only by design.** The API has **no authentication**; localhost binding is
  the boundary. There is no multi-user, hosted, or secured operation, and none is implied.
- **Custom Python / math / ML nodes are a documented path, not a feature.** v0 ships a fixed set of
  typed nodes. Sandboxed-Python, model, and external node implementations are a *preserved seam* in
  the IR and architecture (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §7 "Future boundaries"
  and [`docs/STRATEGY_LANGUAGE.md`](docs/STRATEGY_LANGUAGE.md) §7/§10) — they are not implemented.

Domain boundaries for the MVP: US-listed stocks & ETFs, daily bars, long-only, no leverage, no
shorting, no options/futures, no intraday/HFT, scheduled daily/weekly/monthly evaluation.

## Source-of-truth hierarchy

1. The versioned **JSON strategy document** — persisted instance & semantic source of truth.
2. The published **JSON Schema** ([`schema/quantize.schema.json`](schema)) — the language-neutral
   structural contract for a schema version.
3. **Pydantic** — the v0 authoring/parsing/validation implementation (not "the canonical IR").
4. **Registry rules + runtime invariants** — semantic validation.
5. **Generated TypeScript types** ([`ts/`](ts)) — consume the schema; never hand-maintained. CI
   fails on stale generated types.

## Status

The MVP is built as a spine — **IR + one engine + tracing + persistence + API + editor** — proven
end to end on two reference strategies. **Milestones M1–M12 are complete** (M12 delivers the
component authoring/extraction UI and MVP closeout). At the time of writing the suite reports **904
Python tests** (`pytest`) and **220 web tests** (`vitest`), green on Python 3.13/3.14 and Windows/
Linux, with byte-stable golden and backtest↔forward consistency coverage.

For the full milestone breakdown (M1 IR + structural validation through M12 component UI), see
[`docs/MVP_PLAN.md`](docs/MVP_PLAN.md).

### Architectural invariants (the ones that shape everything)

- The persisted JSON IR document is the source of truth; the canvas, React, and React Flow are
  disposable views. `ui.*` is preserved through round-trip but excluded from execution and semantic
  equality.
- **One engine + one evaluator + one set of node implementations.** Backtest and forward replay
  differ **only** in adapters — never a second implementation of a node or rule for "the other mode."
- Temporal access is structurally constrained and tested: each evaluation sees only data available
  ≤ the evaluation instant. v0 implements exactly one execution policy
  (`close_signal_next_session_open`: evaluate after session D's close → fill at the next valid
  exchange session's open).
- No business logic in the frontend; no Python objects (pandas/numpy DataFrames/arrays) across API
  contracts — contracts are plain JSON DTOs.

## Repository layout

```
quantize/
  schema/        IR Pydantic models + canonical serialization + version gate
  validation/    structural + semantic validation
  registry/      node descriptors (registry, not switch statements)
  compatibility.py  the single is_compatible port-type rule (shared by validator + editor)
  nodes/         the core node implementations
  runtime/       node binding, runtime values, diagnostics
  components/    standalone component definitions + compositional resolution
  evaluator/     single-instant graph evaluation + preflight
  engine/        session engine (one loop body), reconciliation, fills, forward replay
  market/        exchange calendar + availability-gated market data
  tracing/       trace-event envelope, payload specs, per-instant trees
  persistence/   SQLite repository + migrations (Postgres-targeted)
  codegen/       JSON Schema + TypeScript type generation
  api/           the FastAPI HTTP boundary (/v1) — plain JSON DTOs
web/             the browser editor (Vite + React + TypeScript)
scripts/         seed_demo.py (onboarding) + gate/toolchain scripts
docs/            PRODUCT, ARCHITECTURE, STRATEGY_LANGUAGE, MVP_PLAN, ADRs, plans, learning log
schema/          committed JSON Schema (the exported structural contracts)
ts/              committed generated TypeScript types (derived; never hand-edited)
tests/           unit, golden, contract, and end-to-end consistency tests + fixtures
```

## Toolchain & commands

Run from the repo root (venv activated). Python:

```bash
pytest                                 # tests
ruff check .                           # lint
ruff format --check .                  # format check
mypy                                   # type-check
python -m quantize.codegen generate    # regenerate JSON Schema + TS types (needs Node 24)
python -m quantize.codegen check       # verify committed artifacts are current
```

Web (Node 24 active): `npm --prefix web run typecheck` and `npm --prefix web run test`.

**Full gate (canonical, run before claiming a slice done):** `./scripts/gate.ps1` (PowerShell) or
`bash scripts/gate.sh` (POSIX) — pytest, `ruff check`, `ruff format --check`, `mypy`, Node-24
activation, `codegen check`, `tsc`, web typecheck, and web test, fail-fast, from any cwd. Before any
Node-dependent command in a non-interactive shell, run `./scripts/node24.ps1` in the same process to
activate Node 24.

The committed JSON Schemas and `.d.ts` files are deterministic and byte-stable (LF), committed, and
CI's `codegen` job fails if they are stale — the `.d.ts` files are **derived** artifacts; regenerate,
never hand-edit.
