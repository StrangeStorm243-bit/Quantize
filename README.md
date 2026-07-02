# Quantize

A **visual operating system for quantitative trading**. A strategy is authored once as a single,
versioned, serializable **JSON IR document** — the persisted instance and semantic source of
truth — and then *operated* without being rewritten between modes: **one session-level engine**
evaluates that document for historical backtesting and forward/paper replay using **the same node
implementations, the same semantics, and structured decision tracing**. The visual canvas (a later
milestone) is only an editor for the IR; it is a disposable view, never the source of truth.

> **Core promise:** turn an existing systematic strategy into a visual, runnable system without
> rewriting it between backtesting and paper execution.

See [`docs/PRODUCT.md`](docs/PRODUCT.md) for the product thesis and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/STRATEGY_LANGUAGE.md`](docs/STRATEGY_LANGUAGE.md),
[`docs/MVP_PLAN.md`](docs/MVP_PLAN.md), and [`docs/ADRS/`](docs/ADRS) for the normative specs.

## Source-of-truth hierarchy

1. The versioned **JSON strategy document** — persisted instance & semantic source of truth.
2. The published **JSON Schema** ([`schema/quantize.schema.json`](schema)) — the language-neutral
   structural contract for a schema version.
3. **Pydantic** — the v0 authoring/parsing/validation implementation (not "the canonical IR").
4. **Registry rules + runtime invariants** — semantic validation.
5. **Generated TypeScript types** ([`ts/quantize-ir.d.ts`](ts)) — consume the schema; never
   hand-maintained. CI fails on stale generated types.

## What has been built

The MVP is being built as a spine — **IR + one engine + tracing + persistence** — proven end to
end on two reference strategies before any UI. Milestones M1–M8 are complete (M8 in review); the
whole surface is exercised by a byte-stable golden + consistency test suite (the full gate reports
**677 passing tests**, green on Python 3.13 and 3.14, Windows and Linux). There is **no frontend
yet** — the editor is M11.

| Milestone | What it delivers |
|---|---|
| **M1** | IR schema + **structural** validation + codegen (JSON Schema **and** TypeScript types) + reference fixtures. Structurally valid documents referencing an unknown future `type_id` are *accepted* here (the extensible-block seam). |
| **M2** | Node **registry** (self-registering, no switch statements) + **semantic** validation + the core node set. An unknown `type_id` is rejected here, not at structural load. |
| **M3** | Single-instant **graph evaluator** + compositional **component** resolution (components are standalone, immutable, evaluated compositionally — direct/transitive recursion rejected) + the deterministic market-data fixture. |
| **M4** | Session-level **execution engine**: schedule firing, ADR-0005 order reconciliation (`PortfolioTargets` → `OrderList`, owned by the engine, not a graph node), deterministic simulated fills + costs, Strategy A historical run + committed golden. |
| **M5** | Strategy B (fixed sleeves + cash remainder) + `risk.max_weight` redistribution + golden. |
| **M6** | Structured, **schema-versioned trace construction**: per-node payload contracts over the M2 trace-event envelope, assembled into deterministic per-instant trace trees. |
| **M7** | **Persistence**: SQLite behind a repository layer (Postgres-ready schema), migrations from the first persistence commit, durable schema-versioned storage of strategy documents, run records, and trace streams with canonical bytes + SHA-256 content hashes, and retrieval without rerunning. |
| **M8** | Deterministic **forward/paper replay** and **backtest↔forward consistency**: the backtest loop body is extracted verbatim into one engine core that both modes drive, so an exhausted forward replay equals the backtest field-for-field. M7-loaded records/traces serve as the stored-facts oracle. |

### The node set (v0)

Nodes self-register with a uniform contract; adding a type is one self-contained registration.
The v0 set (all **pure** — output is a deterministic function of inputs at the evaluation instant):

- **universe** — `universe.fixed_list`
- **data** — `data.price`
- **transform** — `transform.trailing_return`, `transform.moving_average`, `transform.latest`,
  `transform.rank`
- **logic** — `logic.greater_than`
- **portfolio** — `portfolio.select_top_n`, `portfolio.equal_weight`, `portfolio.fixed_weight`,
  `portfolio.apply_mask`
- **risk** — `risk.max_weight`
- **output** — `output.target_portfolio` (the graph terminates in `PortfolioTargets`)

### Architectural invariants (the ones that shape everything)

- The persisted JSON IR document is the source of truth; the canvas, React, and React Flow are
  disposable views. `ui.*` is preserved through round-trip but excluded from execution and
  semantic equality.
- **One engine + one evaluator + one set of node implementations.** Backtest and forward replay
  differ **only** in adapters (Clock, MarketData, Broker/Fills, Storage) — never a second
  implementation of a node or rule for "the other mode."
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
  codegen/       JSON Schema + TypeScript type generation
  registry/      node descriptors (registry, not switch statements)
  runtime/       node binding, runtime values, diagnostics
  nodes/         the core node implementations
  evaluator/     single-instant graph evaluation + component resolution
  engine/        session engine (one loop body), reconciliation, fills, forward replay
  market/        exchange calendar + availability-gated market data
  tracing/       trace-event envelope, payload specs, per-instant trees
  persistence/   SQLite repository + migrations (M7; Postgres-targeted)
  validation/    structural + semantic validation
docs/            PRODUCT, ARCHITECTURE, STRATEGY_LANGUAGE, MVP_PLAN, ADRs, plans, learning log
schema/          committed JSON Schema (the exported structural contract)
ts/              committed generated TypeScript types (derived; never hand-edited)
tests/           unit, golden, contract, and end-to-end consistency tests + fixtures
```

## Toolchain & commands

- **Python:** canonical **3.14** (tested range `>=3.13,<3.15`).
- **Node:** baseline **24 LTS** (`.nvmrc`, `engine-strict`); used for the codegen TypeScript step
  and the type-check gate.

Run from the repo root, after `python -m venv .venv` and activating it
(`.venv\Scripts\activate` on Windows / `source .venv/bin/activate` on POSIX):

```bash
python -m pip install -e ".[dev]"     # install (dev); pinned lock: requirements.lock.txt
pytest                                 # tests
ruff check .                           # lint
ruff format --check .                  # format check
mypy                                   # type-check
python -m quantize.codegen generate    # regenerate JSON Schema + TS types (needs Node 24)
python -m quantize.codegen check       # verify committed artifacts are current
npm run typecheck                      # tsc --noEmit
```

**Full gate (canonical, run before claiming a slice done):** `./scripts/gate.ps1` — runs pytest,
`ruff check`, `ruff format --check`, `mypy`, Node-24 activation, `codegen check`, and
`npm run typecheck`, fail-fast, from any cwd. Before any Node-dependent command in a non-interactive
shell, run `./scripts/node24.ps1` in the same process to activate Node 24.

The committed JSON Schema and `.d.ts` are deterministic and byte-stable (LF), committed, and CI's
`codegen` job fails if they are stale. The `.d.ts` is a **derived** artifact — regenerate, never
hand-edit.

## Not yet built (the roadmap ahead)

**M9** API boundary + strategy/component versioning · **M10** registry-descriptor + parameter-form
metadata API · **M11** the editor (first legible screen) · **M12** component authoring/extraction
UI. Deferred as *seams, not work*: live/EOD data adapters, a real broker, marketplace, social,
payments, AI generation, and multi-user — none are in the MVP, but the boundaries are preserved so
they can land later without rewrites.
