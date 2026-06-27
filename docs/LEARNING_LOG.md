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

## Course — Module 4: Graphs & Port Types (2026-06-26) — DEMONSTRATED

Founder demonstrated (graded across lessons + assessment):

- **Graph vocabulary** — node (computational box: id/type/params), port (named, typed in/out
  connection point), edge (directed connection from an output port to an input port). Directed graph;
  a strategy must be a **DAG** (Directed Acyclic Graph); a self-edge or cycle is un-evaluable (no
  valid start) and is rejected by M1 structural validation.
- **Valid evaluation order** — produced a topological order for Strategy A (`u, px, ret, rk, sel, ew,
  cap, tp`); identified that adding `rk → ret` forms the cycle `ret → rk → ret`.
- **The v0 type lattice** — `Scalar[Number/Integer/Boolean]`, `AssetSet`, `CrossSection[Number/
  Boolean]`, `TimeSeries[Number]`, `PortfolioTargets`, `OrderList` (engine-only). Dimensional
  intuition: Scalar 0-D, CrossSection 1-D (per asset, one instant), TimeSeries 2-D (per asset × time;
  the "tell" vs. CrossSection is the timestamp/time axis).
- **Port name vs. port type** — a port has a *name* (`values`, `assets`, `series`, `targets`) and a
  *type* (`CrossSection[Number]`, `AssetSet`, …); the dtype bracket holds only Number/Integer/Boolean
  (a mask is `CrossSection[Boolean]`).
- **Shape vs. financial meaning** — same shape ≠ interchangeable; `CrossSection[Number]` and
  `PortfolioTargets` share a shape but differ in meaning, so a deliberate weighting node
  (`equal_weight`/`fixed_weight`) must convert `AssetSet → PortfolioTargets`.
- **Compatibility rules** — exact match by default; one explicit widening `Scalar[Integer] →
  Scalar[Number]`; no implicit meaning changes. Type compatibility is **M2 semantic** validation.
- **Hand-type-checking** — type-checked Strategy A and Strategy B edge by edge (all exact matches).
- **Type-correct ≠ financially correct** — the validator guarantees types fit (pipes match) but never
  that the strategy is financially sound (right liquid); financial correctness is proven by tests.

**Files studied:** `STRATEGY_LANGUAGE.md` §§2–4, §9; `ADR-0002`; `CLAUDE.md` invariant 5 + test
requirements.
**Corrections made during learning:** DAG = Directed Acyclic Graph (not "directive… group"); port
*name* vs *type*; dtype bracket = Number/Integer/Boolean (mask → Boolean); the meaning-change node is
the weighting node (`fw`/`ew`); a type-correct-but-financially-wrong edge has **matching** types.
**Status:** Module 4 complete and demonstrated. Ready for Module 5 (Time & execution semantics).

---

## Course — Module 7: Validation & Schemas (2026-06-26) — DEMONSTRATED

Taken out of order (before Modules 5–6) to prepare directly for M1. Founder demonstrated:

- **The M1/M2 sorting test** — *does the rule need the node-type registry?* Yes → **M2 semantic**;
  checkable from the document's shape alone → **M1 structural**. The registry is specifically the
  catalog of node types (their ports, params, port-types).
- **M1 structural checklist** (no registry): `schema_version` supported; field shapes; **plain-field
  enums** (e.g. `schedule.kind ∈ daily/weekly/monthly`); unique ids; edge endpoints reference
  existing node ids (dangling); no self-edges; acyclic; `component_refs` shape (pinned versions, no
  duplicate ref-ids, no missing refs, no direct/transitive recursion); JSON round-trip; `ui`
  preserved; semantic equality excludes `ui`.
- **M2 semantic checklist** (registry): node `type` exists; input/output **port names exist**;
  required ports connected; **port-type compatibility** (`is_compatible`); parameter schemas valid;
  node-specific invariants.
- **The "exists" split** — "does node id `px` exist?" is M1 (scan the document); "does port `series`
  exist on `data.price`?" is M2 (needs the type). Same word, opposite layers.
- **Codegen pipeline** — `Pydantic (authored) → JSON Schema (contract) → TypeScript (generated)`;
  the IR's shape is changed in exactly one place (Pydantic); TS is generated **from the schema**, not
  directly from Pydantic.
- **Stale-types gate** — CI regenerates and compares to committed files; mismatch → fail (enforces
  invariant 4); hand-edits to generated files are always caught. Codegen must be **deterministic**,
  else regeneration differs every run and the gate fires false failures and becomes useless.
- **Test families** — *contract* (reference strategies validate across Pydantic + schema), *round-
  trip* (parse → re-serialize, preserving `ui`), *`ui`/semantic-equality* (`ui`-only change →
  semantic-equal True while byte-equal False), *negative/structural* (invalid fixtures rejected with
  clear errors). The two reference strategies are the **must-work core** payloads, not edge cases.
- **Negative testing** — proving the validator correctly says "no" is half the job; "valid passes"
  alone is insufficient.

**Files studied:** `STRATEGY_LANGUAGE.md` (Failing loud, §4, §7); `MVP_PLAN.md` M1 + M2; `ADR-0001`;
`CLAUDE.md` invariant 4 + test requirements; `ARCHITECTURE.md` §6.
**Corrections made during learning (recurring):** a plain-field **enum** is M1 structural (not M2);
type-compatibility and param-validity are M2; "exists" splits node-id (M1) vs port (M2); TS is
generated from the JSON Schema, not directly from Pydantic.
**Status:** Module 7 complete and demonstrated. Modules 5 (time/execution) & 6 (engine ownership)
deferred until before the engine milestones (M3–M4). Founder positioned to scope/supervise M1.

---

## M1.2 — Structural validation (2026-06-27)

**Concepts introduced:**
- **Validation layers ("fail loud — at the right layer").** Pydantic (M1.1) checks each model in
  isolation: required fields, value types, `extra="forbid"`, portable JSON. It *cannot* see across
  elements. M1.2 adds the **cross-element** invariants: id uniqueness, edge endpoints existing,
  acyclicity, local component-ref resolution, component-set recursion. M2 (later) adds *semantic*
  checks that need the registry (does `type_id` exist? do ports match?). Same document, three layers.
- **The extensibility seam.** A node with an unknown future `type_id` (`ai.generated.block`) is
  **structurally valid** at M1 and only rejected at M2. The validator must never inspect `type_id`
  meaning — that would collapse the seam and break invariant 9.
- **Diagnostic policy (accumulate, with one representative per cycle).** Independently-detectable
  structural errors are **accumulated** (unsupported `schema_version`, duplicate ids, dangling
  endpoints, self-edges, unresolved component refs) so a future editor can highlight many faults at
  once. The deliberate exception is cycles: the validator emits **one deterministic representative**
  `graph_cycle` per graph (and one `component_cycle` per supplied component set) — it does **not**
  enumerate every cycle. Determinism needs an explicit sort key (`loc`, then `code`, then `subject`)
  because Python set/dict iteration order must never leak into output.
- **Supported `schema_version` is M1 structural.** Plan §4 lists "`schema_version` present &
  supported" in the M1 column. The single source of truth is `quantize/schema/version.py`
  (`CURRENT_SCHEMA_VERSION`, `SUPPORTED_SCHEMA_VERSIONS`) — no string literal is duplicated. An
  unsupported version fails loud (`unsupported_schema_version`) instead of being best-effort-parsed.
  Note the layering: M1.2 checks this on an **already-parsed** document; a *future* raw-document
  loader/migration layer (not built) may read `schema_version` *before* picking a parser.
- **Cycle detection (three-colour DFS).** white = unseen, grey = on the current path, black = done.
  A back edge to a **grey** node is a cycle. Self-edges and dangling edges are excluded from the
  adjacency so they aren't double-reported as cycles. Visiting roots and neighbours in **sorted**
  order makes the *reported* cycle deterministic.
- **Recursion-depth as a real failure mode.** A recursive DFS crashes (`RecursionError`) on a long
  acyclic chain (~1000+ nodes). We rewrote it with an **explicit stack** so depth is bounded by heap,
  not the call stack — a robustness fix surfaced by the diff review, now guarded by a 2000-node test.
- **Bounded component-set validation (decision H / plan §5).** `validate_component_set` builds a
  dependency graph over `(component_id, version)` from each definition's `component_refs` and finds
  direct + transitive cycles **within the supplied set only**. It never fetches from a store. Three
  outcomes: closed-valid, **acyclic-but-incomplete** (refs outside the set → `unresolved_refs`, not
  failures), and cyclic. The middle outcome is the subtle one — "incomplete" ≠ "invalid".

**Files studied:** `quantize/schema/{nodes,document,components,primitives}.py` (the models being
validated); `docs/plans/M1_IMPLEMENTATION_PLAN.md` §4 (M1/M2 table) + §5 (component-set spec);
`AGENTS.md` invariants 8–9.
**Reading path:** `quantize/validation/errors.py` (the result shapes) → `structural.py`
`validate_strategy_document` (the simple case) → `_validate_graph` (shared graph checks) →
`_find_cycle` (the algorithm) → `validate_component_set` (the dependency-graph case).
**Exercise (implement by hand):** write a failing test for a *figure-eight* graph (two cycles sharing
one node) and confirm exactly one `graph_cycle` is reported. *Prediction:* which of the two cycles is
reported, and why? (hint: sorted roots + sorted neighbours in `_find_cycle`). Then trace it to check.
A second, conceptual one: is a `max_nodes` cap an M1 structural check? *Prediction:* no — it needs no
registry but is a *policy/resource* rule, not a well-formedness rule, so it belongs to neither layer
as specified; adding it would be scope creep.
**Status:** M1.2 **founder-approved and committed** on `feat/m1-ir-schema`. Local gate green
(ruff/format/mypy clean, 109 tests). Internal Claude review passes (architecture/test/diff) returned
"approve with nits"; their named corrections plus the Codex `unsupported_schema_version` blocker and
component-set boundary regressions are applied. M1.3 (codegen) not started.

---

> Template for future entries:
>
> ## M<n> — <title> (<date>)
> **Concepts introduced:** …
> **Files studied:** …
> **Reading path:** …
> **Exercise (implement by hand):** … *Prediction:* … *Outcome:* …
> **Status:** …
