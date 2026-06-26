# LEARNING_LOG.md — Quantize

A running record of engineering concepts introduced, files studied, and hands-on exercises
completed by the founder. The goal is to build engineering ability *through* this project, not to
treat the founder as a passive PM. Each milestone appends an entry.

How to use this log: when a milestone introduces a concept, we (1) explain the concept in the
context of this repo, (2) point to the file(s) where it lives, (3) give a short reading path, and
(4) propose one small change for the founder to implement by hand. The founder fills in predictions
and outcomes.

---

## M0 — Foundation & decisions (2026-06-23)

**Concepts introduced (conceptual only — no code yet):**

- **Intermediate Representation (IR) as source of truth.** The strategy is *data*, edited by a UI
  and evaluated by a runtime — neither owns it. Why it matters: it decouples the visual layer from
  execution and makes versioning, reuse, and multiple runtimes possible.
  *Where:* `docs/STRATEGY_LANGUAGE.md` §1.
- **Separating semantics from presentation (`ui.*`).** Coordinates and collapse-state are not part
  of what a strategy *means*. *Where:* `docs/STRATEGY_LANGUAGE.md` §1; invariant in `CLAUDE.md`.
- **Look-ahead bias and the session-level engine.** The defining correctness hazard of backtesting,
  and how processing one evaluation instant over an as-of data view **structurally constrains**
  temporal access (and is tested) — without claiming look-ahead is impossible.
  *Where:* `docs/ADRS/0003-...md`, `docs/STRATEGY_LANGUAGE.md` §6.
- **Session-level event lifecycle vs. evaluation schedule.** Why valuation, fills, and stateful
  updates run on session cadence while graph evaluation runs only when scheduled.
  *Where:* `docs/ARCHITECTURE.md` §3.
- **Adapter pattern at the engine seam.** One engine; Clock/MarketData/Broker/Storage swapped to
  get backtest vs. forward replay. *Where:* `docs/ARCHITECTURE.md` §3.
- **A type lattice for ports** distinguishing structural shape from financial meaning, with one
  central compatibility function. *Where:* `docs/STRATEGY_LANGUAGE.md` §2.
- **Single source of truth across languages** (Pydantic → JSON Schema → TS) and why duplicated types
  rot. *Where:* `docs/ADRS/0001-...md`.
- **Architecture Decision Records (ADRs).** Why we write down decisions, alternatives, and
  consequences. *Where:* `docs/ADRS/`.

**Reading path (recommended order):** `docs/PRODUCT.md` → `docs/STRATEGY_LANGUAGE.md` §§1–2,6 →
`docs/ARCHITECTURE.md` §§1–3 → `docs/ADRS/0003` then `0001`.

**Exercise (no code; pen-and-paper):** On paper, draw Strategy B as nodes and typed edges using only
the v0 node taxonomy (`STRATEGY_LANGUAGE.md` §3) and label each edge with its port type. Predict:
which single edge in your drawing would the type system *reject* if you accidentally fed a
`TimeSeries[Number]` into a port expecting `CrossSection[Number]`, and which node fixes that?
*Prediction:* ______. *Outcome (after M2):* ______.

**Status:** concepts introduced; first coding exercises arrive with M1 (the IR models) and M2 (a
node implementation you will extend by hand).

---

## Course — Module 1: Repository & Git foundations (2026-06-25) — DEMONSTRATED

Founder demonstrated (graded correct in lesson + module assessment):

- **The three trees** — working tree → staging area → commit history — and that "working tree clean"
  means all three agree.
- **Purpose of the staging area** — a curation/review checkpoint before the more-permanent commit;
  lets you confirm exactly what is recorded (catch stray files, avoid omissions) and compose a commit
  from a chosen subset of edits.
- **commit / branch / tag / remote / HEAD** — a commit is an immutable snapshot (hash); a branch is a
  movable label that advances with each commit; a tag is a fixed label; `origin` is the remote
  (GitHub); HEAD is the currently checked-out branch.
- **Branch vs tag behavioral difference** — branch moves on commit, tag stays pinned; correctly
  mapped `main` (branch) and `m0-foundation` (tag). *(Corrected during lesson: `main` is the local
  branch; `origin/main` is the remote-tracking ref; `origin` = GitHub, not the local machine.)*
- **Why isolate M1 on `feat/m1-ir-schema`** — in pointer terms: the first M1 commit moves the
  `feat/m1-ir-schema` label to the new commit while `main` stays pinned at `dc2366d`, protecting the
  approved M0 baseline.
- **Reading a diff** — `-`/`+`/context/`@@` hunk headers; a `-foo`/`+bar` pair is a changed line;
  `git diff` shows unstaged (working vs staging), `git diff --cached`/`--staged` shows what will be
  recorded (staging vs last commit) — the pre-commit review used to reject unrelated/scope-creep
  changes.

**Files studied:** the live repository, `CLAUDE.md` (Working process), `AGENTS.md` (Review criteria).
**Status:** Module 1 complete and demonstrated. Ready for Module 2 (Product Architecture).

---

## Course — Module 2: Product Architecture (2026-06-26) — DEMONSTRATED

Founder demonstrated (graded across lessons + assessment):

- **The layers** — editor (thin replaceable React/TS view, no logic), API (thin FastAPI JSON
  boundary), Python runtime (all math/strategy/validation), persistence (SQLite via repository),
  adapters (swappable seam). Correct one-phrase ownership for each.
- **The two frontend invariants** — (5) no business logic in the frontend → prevents editor/runtime
  result mismatch (drift) as code evolves; (6) only JSON crosses the API boundary → language-neutral,
  decoupled from pandas/Python implementation details.
- **Runtime split: strategy graph vs. engine** — the graph does per-instant math over past+present
  data (never future) and terminates in `PortfolioTargets`; the engine owns time, reconciliation
  (`current portfolio + targets + policy → OrderList`), fills, valuation, tracing.
- **Why orders are engine-owned, not a graph output** — two users with identical `PortfolioTargets`
  but different current portfolios get different `OrderList`s; orders depend on engine-only state.
- **The adapter seam** — an adapter is a swappable implementation behind a fixed interface; Clock +
  MarketData differ between backtest and forward replay, while the nodes/evaluator/reconciliation/
  tracing stay byte-for-byte identical, which is why the two modes share semantics and cannot drift.
- **Placement skill** — reliably placed behaviors into editor / API / strategy graph / engine
  (incl. distinguishing MarketData from Clock as two engine-side adapters).

**Files studied:** `ARCHITECTURE.md` §§1–3, §7; `ADR-0001`; `ADR-0003`; `ADR-0005`; `CLAUDE.md`
invariants 2, 5, 6.
**Corrections made during learning:** stopped conflating "fixed interface" (an adapter concept) with
engine outputs (`OrderList`); `origin` = remote, not local machine (carried from Module 1).
**Status:** Module 2 complete and demonstrated. Ready for Module 3 (the strategy IR).

---

## Course — Module 3: The Strategy IR (2026-06-26) — DEMONSTRATED

Founder demonstrated (graded across lessons + assessment):

- **IR as source of truth** — a strategy *is* a versioned JSON document (intermediate representation
  living between editor and runtime, owned by neither); the canvas/editor is a disposable view that
  serializes to and renders from the IR. The JSON is the truth; the picture is a rendering of it.
- **`ui.*` semantics** — `ui.*` (e.g. node x/y) is preserved through save/round-trip but **excluded
  from semantic equality**; two documents differing only in `ui.*` are the same strategy. A complete
  runnable strategy can be written with no `ui` fields at all — proof it is non-semantic.
- **Serialization / deserialization / round-trip** — in-memory object ↔ JSON text; a correct
  round-trip preserves content including `ui.*`.
- **Two version axes** — `schema_version` is bound to the IR *format* (evolved by the Quantize team,
  independent of users); `strategy.version` counts a *user's* saved revisions. Orthogonal.
- **Fail loud** — an unsupported `schema_version` must raise a clear error, never best-effort-parse,
  because silently dropping/misreading a field could produce wrong-but-plausible financial results.
  Migrations are explicit, named, tested.
- **Five-level source-of-truth hierarchy** — (1) JSON document, (2) published JSON Schema, (3)
  Pydantic (v0 implementation, *not* authoritative), (4) registry + runtime invariants, (5) generated
  TS (derived consumer, *not* authoritative). Pydantic could be rewritten in another language without
  changing the truth.
- **Generation pipeline vs. authority** — generation is the 3-link chain `Pydantic → JSON Schema →
  TypeScript types`, with the **JSON Schema** as the language-neutral contract; this is distinct from
  the 5-level authority ranking.
- **Structural vs. semantic validation** — JSON Schema enforces *structural* rules (shape: "`n` is an
  integer", "`nodes` is a list"); the registry/runtime enforces *semantic* rules (meaning: "node type
  `transform.rank` exists", "these ports are compatible"). Node-type existence is semantic and only
  the registry can answer it — the M1/M2 boundary.

**Files studied:** `STRATEGY_LANGUAGE.md` (Source-of-truth hierarchy, §1, §8, §9); `ADR-0001`;
`ADR-0002`; `CLAUDE.md` invariants 1, 4, 9; `ARCHITECTURE.md` §1.
**Corrections made during learning:** structural vs. semantic labels (initially inverted); node-type
existence is semantic (not structural); generation pipeline is 3 artifacts, not the full hierarchy.
**Status:** Module 3 complete and demonstrated. Ready for Module 4 (Graphs & port types).

---

> Template for future entries:
>
> ## M<n> — <title> (<date>)
> **Concepts introduced:** …
> **Files studied:** …
> **Reading path:** …
> **Exercise (implement by hand):** … *Prediction:* … *Outcome:* …
> **Status:** …
