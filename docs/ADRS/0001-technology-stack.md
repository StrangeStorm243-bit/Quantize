# ADR-0001: Technology stack

- **Status:** Accepted (2026-06-23)
- **Deciders:** Founder + principal architect
- **Related:** ADR-0002 (graph representation), ADR-0003 (execution), ADR-0004 (database)

## Context

We need a stack for a visual IDE whose strategy definition is a versioned IR, whose runtime does
serious (and eventually very advanced) numerics, and whose editor is a graph canvas. The two
realistic shapes are (1) a single-language TypeScript system, or (2) a Python numerical runtime
behind a TypeScript editor. The long-term ceiling explicitly includes optimization, statistics,
and ML.

## Decision

**Python runtime + TypeScript editor, with an explicit source-of-truth hierarchy.**

The IR is not "owned" by Pydantic. The hierarchy is, top to bottom:

1. The versioned **JSON strategy document** — the persisted instance and **semantic source of truth**.
2. The published **JSON Schema** — the language-neutral **structural contract** for a schema version.
3. **Pydantic v2** — the v0 implementation that **authors, generates, parses, and validates** the
   schema (an implementation detail of producing #2, not the source of truth itself).
4. **Registry rules + explicit runtime invariants** — **semantic** validation.
5. **Generated TypeScript types** — consume the published schema; **never** hand-maintained.

- **Runtime / numerics:** Python (pandas, numpy as *implementation details*).
- **Schema flow:** Pydantic models → published JSON Schema → generated TypeScript types.
- **API boundary:** FastAPI, thin JSON. No protobuf, no message bus, no distributed services.
- **Editor:** React + TypeScript + React Flow (the canvas is a view; see ADR-0002).
- **Database:** SQLite now, Postgres-ready (see ADR-0004).
- **Tests:** pytest + golden/snapshot fixtures on a small synthetic dataset.

### Binding constraints (enforced)
1. Do **not** manually duplicate strategy-domain types between Python and TypeScript.
2. Provide a **deterministic codegen command** (`schema → json-schema → ts`) and document it.
3. **CI fails if generated TypeScript types are stale.**
4. **Contract tests** prove representative strategy payloads validate consistently.
5. Version the strategy schema from the beginning (`schema_version`).
6. No numerical or portfolio business logic in the frontend.
7. No pandas DataFrames / Python-specific objects as API contracts.
8. Treat pandas/numpy/etc. as runtime implementation details, swappable without API change.
9. Keep editor-only metadata (`ui.*`, node coordinates) distinguishable from executable semantics.
10. Unknown node types and unsupported schema versions **fail clearly**, never silently ignored.

## Alternatives considered

### All-TypeScript (runtime + editor)
- **Pros:** one language, no serialization boundary, one type system, simplest to start, no codegen
  step, easiest for a solo founder to hold in their head.
- **Cons:** forfeits Python's numerical/scientific/ML ecosystem, which the long-term vision
  (optimizers, statistical models, ML inference, custom quant code) directly depends on. Re-platforming
  the runtime later would be a far larger cost than paying the boundary tax now.
- **Verdict:** Rejected — deliberately, not by default. The ceiling is the whole point of the
  product; choosing the language that owns that ceiling for the runtime is worth the boundary cost.

### Python everywhere (incl. a Python-rendered UI)
- **Cons:** graph-canvas UX in Python is weak; React Flow is the pragmatic choice for the editor.
- **Verdict:** Rejected for the editor.

### Heavier transport (protobuf / gRPC / message bus) now
- **Verdict:** Rejected as premature. A single local process + JSON over FastAPI is sufficient for
  a single-user MVP. Revisit only when a demonstrated requirement appears.

## Consequences

- **Positive:** Best path to the complexity ceiling; one source of truth for the IR; the boundary
  is a clean, testable JSON contract; the runtime is fully unit-testable headless before any UI
  exists.
- **Negative / cost accepted:** a serialization boundary and a codegen+CI step. Mitigated by the
  ten constraints above (esp. codegen, the staleness gate, and contract tests).
- **Founder-learning note:** the boundary is itself a teaching surface — it makes the difference
  between "data contract" and "implementation detail" concrete and visible.
