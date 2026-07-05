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

## M1 Walkthrough + M2 Readiness (2026-06-29) — DEMONSTRATED

Full operational review of the merged M1 implementation across seven lessons, then M2 concept
preparation. Goal was supervisory understanding (trace, locate, predict, judge), not line-by-line
recall.

**Demonstrated:**
- **Strict / portable data** — parse vs. mutate vs. serialize as three distinct moments; why the
  canonical serializer (`to_ir_dict`/`to_ir_json`) re-validates portability rather than trusting
  in-memory state; `extra="forbid"` and `strict` numerics fail at *parse*; bool rejected as a number
  two ways (strict governed fields vs. the explicit guard in `_to_finite_number`).
- **Semantic projection** — only `ui` is non-semantic; `extensions` is semantic by default; 6/6 on
  equality prediction incl. the `extensions`-present and node-rename traps.
- **Testing & independent review** — the test families; the headline that M1 had 54 passing tests
  *and* three Codex BLOCKERS simultaneously (silent defaults, serialization NaN→null, bool coercion);
  deterministic tools vs. model self-review vs. independent (Codex) review as defense in depth.
- **Source vs. derived artifacts** — generated `schema/quantize.schema.json` + `ts/quantize-ir.d.ts`
  (and `requirements.lock.txt`/`package-lock.json`) are tool-produced; the codegen chain
  `Pydantic → JSON Schema → TypeScript` and the staleness gate (`codegen check`).

**Operational (reinforced):**
- **The M1/M2 boundary.** Needed repeated correction before stabilizing on the single test:
  *"can I answer this from the document + a constant alone? → M1; do I need the node-type registry?
  → M2."* Final reflexive mapping: `schema_version` unsupported → **M1/constant**; duplicate/dangling
  /cycle → **M1/scan**; `type_id` unknown → **M2/registry**; port-name existence + type compatibility
  → **M2/registry**. Edge endpoint `(node_id, port_name)`: left = M1, right = M2.

**M2 readiness gate — passed (6/6):** structural-vs-semantic; why `type_id` stays an open string;
registry maps `(type_id, type_version) → descriptor`; node params belong to the descriptor, not the
central IR; `is_compatible` centralized as one shared function so editor and validator can't drift;
M2 *resolves* meaning, M3 *runs* it.

**Files studied:** `quantize/schema/{primitives,types,nodes,document,schedule,version,serialization,
semantics,components}.py`; `quantize/validation/{structural,errors}.py`; `quantize/codegen/
{schema,typescript,pipeline}.py`; generated `schema/quantize.schema.json` + `ts/quantize-ir.d.ts` +
`ts/fixtures/usage.ts`; representative `tests/*` and `tests/fixtures/*`; `docs/reviews/
M1_1_CODEX_REVIEW.md`; `pyproject.toml`, `.github/workflows/ci.yml`, `package.json`.

**Watch:** tendency to answer "how is X centralized?" with the *behavior* instead of the
*architecture* (one source of truth → no drift) — relevant throughout M2 (registry, `is_compatible`,
descriptor model).

**Status:** M1 understanding operational-to-demonstrated across all stages; **founder cleared to
supervise M2** (registry + semantic validation). Next: M2.1 registry + descriptor model.

---

## M2.1 — Node Registry & Descriptor Model (2026-06-29)

First M2 slice, executed founder-supervised (founder directed the design via brainstorming; agent
implemented; independent Codex review). Founder hand-implementation begins from M3/M4.

**Concepts introduced:**
- **The registry pattern (open/closed).** A registry maps a key to a registered description so the
  system is *open* for new node types (add a registration) but *closed* for modification (no central
  switch to edit) — invariant 7. Here `(type_id, type_version) → NodeDescriptor`. This is the other
  half of M1's open `type_id`: M1 leaves the string meaningless; the registry gives it meaning.
- **Static descriptor vs. full node contract.** `NodeDescriptor` (in `quantize/registry/descriptor.py`)
  is the *static, editor-facing subset* — identity, typed input/output ports, metadata — **not** the
  executable contract (parameter schema, evaluate, trace schema, purity, warm-up), which lands later.
- **Dependency injection + Protocol (capability separation).** Consumers depend on a narrow read-only
  `NodeRegistryView` Protocol that **omits `register()`**, so a validator can resolve but never mutate
  the catalog → deterministic validation (same document + same view ⇒ same diagnostics). mypy proves
  the concrete `NodeRegistry` satisfies the Protocol.
- **Exact-version resolution + non-throwing results.** `resolve()` matches the *exact* pinned
  `(type_id, type_version)` — never latest/range/fallback — and returns a typed `NodeResolution`
  (`OK` / `UNKNOWN_TYPE` / `VERSION_UNAVAILABLE`) rather than raising, so M2.2 can accumulate
  deterministic diagnostics. Registration misuse (a duplicate key) *does* fail loud.
- **Errors vs. diagnostics (the M2.1 split).** Registration is a programming act → raise
  (`DuplicateRegistrationError`); resolution is a query over user data → return a result. Descriptor
  construction failures are ordinary Pydantic `ValidationError`s, not registry errors.
- **Runtime infra is neither source-of-truth nor derived.** Descriptors are authored in code and
  never persisted/serialized, so they do **not** touch the Pydantic IR → JSON Schema → TypeScript
  codegen chain; the staleness gate is irrelevant to them (confirmed: `codegen check` clean, no
  `schema/`/`ts/` diff).

**Founder design decisions (made during brainstorming):** split `InputPortSpec`/`OutputPortSpec`
(`required` on inputs only); `port_type` over `type`; frozen Pydantic descriptors + a separate narrow
injection Protocol; **defer `parameter_schema`** after the report showed `jsonschema` is dev-only and
using it at runtime would be an out-of-scope dependency change (deferring also yields a deeply
immutable descriptor); required `metadata`; infrastructure exceptions only.

**Codex review fixes applied:** hardened `NodeResolution.__post_init__` to reject non-enum status and
empty `VERSION_UNAVAILABLE` (BLOCKER); made `required` a strict bool so `"false"` is rejected, not
coerced (MEDIUM); added frozen-mutation tests for `NodeDescriptor`/`NodeMetadata` (LOW).

**Files studied / created:** `quantize/registry/{descriptor,registry,errors,__init__}.py`;
`tests/{test_registry,test_registry_descriptor,test_registry_fixtures,registry_fixtures}.py`;
`docs/plans/2026-06-29-m2-registry-design.md` (design) + `2026-06-29-m2-registry.md` (plan);
`docs/reviews/M2_1_CODEX_REVIEW.md`.

**Exercise for next time (M3/M4 onward, hand-implemented):** the M2.2 semantic validator that consumes
`NodeRegistryView` over a real `StrategyDocument` — resolve each node, accumulate diagnostics in the
M1.2 deterministic style. *Prediction to make first:* which resolution status maps to which diagnostic
code, and at which layer (M2) does it sit?

**Status:** M2.1 implemented, gate green (185 tests; ruff/format/mypy clean), Codex review addressed,
founder-approved. Next: M2.2 (semantic validation) — first founder hand-implementation slice.

---

## M2.2 — Semantic Validation (registry resolution + wiring by name) (2026-06-30)

Second M2 slice, executed founder-supervised (founder directed the design via brainstorming; agent
implemented; independent Codex review). Founder hand-implementation begins from M3.

**Concepts introduced:**
- **The third validation layer.** `parse (Pydantic) → structural (M1.2, registry-free) → semantic
  (M2.2, registry-dependent)`. Each layer needs what the one below produces; semantic runs on an
  already-parsed, structurally-valid document and must **not** rerun structural checks.
- **The "exists" split, completed.** On an edge endpoint `(node_id, port_name)`, M1 answered "does the
  *node* exist?" (scan). M2.2 now answers "does the *port* exist on the node's type?" — only the
  registry can, so this is the port-half you drilled, finally implemented (`semantic.py`).
- **DRY across layers via a read-only Protocol.** The deterministic `(loc, code, subject)` sort was
  extracted to `validation/diagnostics.py` behind a `HasLocCodeSubject` Protocol whose members are
  **read-only properties** — so *frozen* dataclasses (`StructuralError`, `SemanticDiagnostic`) satisfy
  it. A plain-attribute Protocol would have rejected frozen types (caught by mypy). The structural
  refactor was **behavior-preserving**, proven by the unchanged M1.2 tests.
- **Distinct result type, deliberate naming.** `SemanticDiagnostic`/`SemanticValidation` mirror the
  structural shape but stay separate; the field is `diagnostics` (not `errors`) to leave room for
  future warning/info findings — v0 keeps `ok = not diagnostics`.
- **Errors vs. diagnostics, again.** Registration misuse raises; *resolution outcomes over user
  documents* (unknown type, version unavailable, bad port, unconnected required input) are accumulated
  diagnostics, never exceptions.
- **Two subtle rules.** (1) **Per-endpoint** component skip: an edge touching a component node skips
  only that endpoint; a resolved registered endpoint is still checked. (2) **No-cascade**
  connectivity: a required input counts as connected by *any* edge targeting it, even if the source
  failed resolution — avoiding noisy cascades (type-compat is M2.3's job).
- **Test against doubles.** A `build_reference_registry()` of descriptor doubles (port *names* from
  the committed strategies, plausible lattice *types*) proves Strategy A and B wirings resolve by name
  without needing the real node implementations.

**Founder design decisions (brainstorming):** parallel `SemanticDiagnostic` with M1.2 untouched;
extract the shared sort helper (Approach A); broaden `errors.py` docstring; explicit semantic
precondition; `diagnostics` over `errors`; include **both** reference strategies; reference registry
is test-only doubles with real lattice port types so M2.3 can reuse it.

**Codex review fixes applied:** added the Edit-1 component-endpoint tests (BLOCKER — proves
per-endpoint skip); version-unavailable test now asserts the message lists available versions;
determinism test now asserts the exact `(loc, code, subject)` order.

**Files studied / created:** `quantize/validation/{diagnostics,semantic,errors,structural}.py`;
`tests/{test_semantic_validation,registry_fixtures}.py`;
`docs/plans/2026-06-30-m2-semantic-validation{-design,}.md`.

**Exercise (M3 onward, hand-implemented):** M2.3's single shared `is_compatible(output_type,
input_type)` over the `PortType` lattice (exact match + the one widening `Scalar[Integer] →
Scalar[Number]`; no implicit meaning changes) and a per-edge compatibility check reusing
`build_reference_registry()`. *Prediction to make first:* which Strategy A/B edge would the lattice
reject if a `TimeSeries[Number]` fed a port expecting `CrossSection[Number]`, and which node fixes it?

**Status:** M2.2 implemented, gate green (200 tests; ruff/format/mypy clean), Codex review addressed,
founder-approved. Next: M2.3 (single shared `is_compatible` + per-edge port-type compatibility).

---

## M2.3–M2.4 — Compatibility, parameter validation, trace envelope (M2 completion) (2026-06-30)

The remaining M2 contract/validation surface, executed founder-supervised (founder directed each
design via brainstorming; agent implemented; independent Codex review per slice). The **12 node
implementations** and **node-specific validation** are deferred to the M3 phase / first real node.
Founder hand-implementation begins at M3.

**Concepts introduced:**
- **The single shared compatibility function (invariants 4/5/7).** `quantize/compatibility.py`'s
  `is_compatible(source, destination)` is the *only* place edge compatibility is decided, so the
  validator and the future editor cannot drift. It is an **allow-list**: exact match (via `PortType`
  value-equality) plus the one explicit widening `Scalar[Integer] → Scalar[Number]`; everything else
  (the "no implicit meaning change" cases) falls through to `False`. Allow-list, not deny-list — you
  don't enumerate every forbidden pairing.
- **Gating to avoid cascades.** Port-type compatibility is checked only when *both* endpoints resolve
  *and* both named ports exist; a missing port yields only `unknown_*_port`, never also
  `incompatible_port_types`. This completes the "exists" split: `from_[0]` (node id) is M1,
  `from_[1]` (port name + type) is M2.
- **A value-object that makes a contract true.** `JsonSchemaSpec` (M2.4) guarantees
  *construction validates → `errors()` never raises*. The Codex review proved why that matters:
  `check_schema` accepts an unresolvable `$ref`, which then throws mid-`iter_errors` — so construction
  must also reject references (v0 schemas are self-contained) and non-portable content (schemas are
  language-neutral JSON for the editor). A documented invariant is only real if construction enforces
  every precondition the method relies on.
- **Parameter validation with structured diagnostics.** `errors()` returns `JsonSchemaIssue`
  (`path`, `json_path`, `message`), so the validator builds precise `loc`s like
  `("nodes", i, "params", "n")` and accumulates rather than throwing.
- **An approved, documented dependency change.** Promoting `jsonschema` from a dev-only to a runtime
  dependency was a deliberate, founder-approved scope expansion (runtime semantic validation must ship
  it) — not a silent drift. Lock regenerated; mypy comment updated.
- **The trace-event envelope as a fixed contract.** `quantize/tracing/events.py::TraceEvent`
  (`run_id, timestamp, node_id, component_path, event_type, payload`) is *fixed at M2* so nodes can
  declare a `trace_schema` for the payload; construction (M6) and persistence (M7) build on the shape.
  Reusing the IR primitives means trace data obeys the same portable-JSON rules as the IR.
- **YAGNI in practice.** `node_validate` was designed, then deferred — a Python-only hook with no
  production consumer would have a speculative diagnostic contract. It arrives with the first real node
  that needs a rule JSON Schema cannot express.

**Codex review fixes applied (across the slices):** non-enum/empty `NodeResolution` hardening (M2.1
follow-on); component-endpoint per-endpoint tests; tightened diagnostic-contract assertions; and the
`JsonSchemaSpec` construction hardening (reference + non-portable rejection) that made the
errors-never-raises contract real.

**Files studied / created:** `quantize/compatibility.py`; `quantize/registry/schema_spec.py`;
`quantize/registry/descriptor.py`; `quantize/validation/{semantic,errors}.py`;
`quantize/tracing/events.py`; `tests/{test_compatibility,test_schema_spec,test_trace_events,
test_semantic_validation,registry_fixtures}.py`; `pyproject.toml`; design/plan docs dated 2026-06-30.

**Exercise (M3 onward, hand-implemented):** see the M3 prep — the graph evaluator. *Prediction to make
first:* given Strategy A's topological order `u, px, ret, rk, sel, ew, cap, tp`, which node first needs
**warm-up** history, and why can't its `CrossSection` be computed at the very first session?

**Status:** M2 complete for its **registry + validation contract** (resolution, version, port-name,
required connectivity, port-type compatibility, parameter validation; trace envelope fixed). Deferred:
node-specific validation, the 12 node implementations. Gate green (237 tests; ruff/format/mypy/codegen
clean). Founder-approved. Next: **M3-PRE → M3** (graph evaluator) — first founder hand-implementation.

---

## M3-PRE + M3 — Market data, graph evaluator, the 12 nodes, component runtime (2026-07-01)

Executed as an autonomous agent build sprint at the founder's direction (the earlier
hand-implementation plan was overridden); this entry is the compact learning handoff.

**System map (evaluation of one instant):** `MarketDataSet.as_of(instant)` builds the
availability-gated `DataView` (the temporal boundary) → `evaluate_strategy` pre-flights by
*calling* the M1/M2 validators plus the new M3 checks (component resolution, component-endpoint
wiring, ambiguous fan-in, the single-terminal rule) → deterministic topological order (Kahn +
lexicographic tie-break) → each node resolves through the `ImplementationCatalog` by exact
`(type_id, type_version)`, is invoked with a `NodeInvocation` (effective params, typed inputs,
view, bound trace sink), and its outputs are checked against its descriptor → component nodes
recurse into their internal graphs under `path + instance_id` (never flattened) → the value on
the one `output.target_portfolio` node's input is the run's `PortfolioTargets`.

**Concepts introduced:**
- **Availability-time gating as a construction property.** `DataView` doesn't *filter* on each
  query; it is *built* to contain only knowable observations, so a node holding one cannot read
  the future through it. The dataset contract additionally rejects data available before it
  exists. Calibrated claim: constrained and tested, not impossible.
- **Descriptors vs. bindings.** The M2 descriptor says what a node *is* (ports, params); the M3
  `NodeImplementation` says what it *does* (evaluate, warm-up, purity). The catalog registers
  both together so the validator and the executor can never disagree.
- **Domain-carrying values.** `CrossSectionValue`/`TimeSeriesValue` keep the bound asset domain
  separate from the present values, making missing-data exclusion visible (and making
  `logic.greater_than`'s domain-preserving false-not-omitted rule structurally honest).
- **Two missing-data regimes, one per node family** (ratified M0 defaults): comparison preserves
  the domain (missing → false + trace); scoring/selection excludes per node rule (+ trace);
  nothing is forward-filled anywhere ("latest" means *at* the latest calendar session — a stale
  price is never substituted).
- **Compositional component evaluation.** Resolution fetches the pinned closure, rejects direct
  + transitive recursion over the *fetched* set (completing M1's bounded check), verifies port
  mappings/param bindings statically, and produces an instance tree with *effective params*
  (copies — persisted documents are never mutated). Evaluation recurses; traces carry the
  component-instance path.
- **Fail loud at the right layer, runtime edition.** Pre-flight accumulates diagnostics with the
  original stable codes; execution stops at the first failing node with a structured
  `RuntimeDiagnostic` (never converting a defect into a missing value).

**Files studied / created:** `quantize/market/{calendar,data}.py`;
`quantize/runtime/{values,binding,diagnostics}.py`; `quantize/components/resolve.py`;
`quantize/evaluator/{plan,evaluate,errors}.py`; `quantize/nodes/*`;
`quantize/tracing/recorder.py`; `tests/market_fixture.py`, `tests/runtime_fixtures.py`,
`tests/component_fixtures.py`, `tests/node_harness.py`, and the M3 test files;
`tests/fixtures/{component_momentum,strategy_a_component}.json`.

**Reading path (one complete trace):** run
`tests/test_reference_strategies_eval.py::test_strategy_a_targets_at_the_main_instant` and follow
Strategy A's order `u → px → ret → rk → sel → ew → cap → tp`: fixed universe → visible closes →
`GROWTH**126 − 1` per asset → ranks (QQQ 1 … TLT 6) → top 3 → 1/3 each → 0.4 cap (no-op) →
targets `{IWM: ⅓, QQQ: ⅓, SPY: ⅓}`, cash ≈ 0. Then the IWM-missing-session variant to watch a
missing close ripple through exclusion → selection → targets, with the `transform.excluded`
trace event explaining it.

**Important tests:** `test_market_data.py` (availability vs. session-date gating);
`test_evaluator.py` (mechanics + determinism + state isolation); `test_component_*` (resolution
faults, nesting, hierarchy traces); `test_nodes_*` (hand-computed node math, incl. the two-pass
waterfall `{0.6,0.3,0.1}→{0.4,0.4,0.2}`); `test_reference_strategies_eval.py` (both strategies,
look-ahead at one minute before the close, componentized-A ≡ flat-A).

**Known limitations:** no engine loop/orders (M4); per-value runtime metadata and detailed trace
payloads deferred (M4/M6); core nodes declare no `trace_schema` yet (M6); `logic.greater_than`
has no scalar right operand; moving average is O(sessions × window) per asset (fine at fixture
scale; vectorization stays fenced).

**Exercise (implement by hand, after review):** add `transform.lowest`/`min` semantics to a copy
of `_latest_evaluate` — or better: write `portfolio.select_bottom_n` as a *new registration* in a
scratch branch. *Prediction to make first:* which existing test file must change not at all, and
which single function in `quantize/nodes/portfolio.py` would you NOT be able to reuse (answer:
none — the catalog builder is the only integration point; check yourself against
`tests/test_nodes_descriptors.py::test_catalog_holds_the_twelve_core_nodes_plus_terminal`).

**Status:** M3-PRE + M3 implemented; Codex-audited (approved after corrections, applied); full
gate green (459 tests; ruff/format/mypy/codegen/tsc clean). Not committed. Next after acceptance:
**ADR-0005** (order reconciliation) then **M4** (session engine + Strategy A golden).

---

## M4 — Session engine, ADR-0005 reconciliation, fills, Strategy A golden (2026-07-02)

Autonomous build sprint over the founder-ratified ADR-0005 and the pre-M4 audit's plan mandate.
Plan-of-record: `docs/plans/2026-07-02-m4-engine-plan.md` (adversarially reviewed before code).

**System map (one session, ARCHITECTURE §3):** OPEN — apply fills queued by the previous
evaluation via `fills.apply_orders` (Broker(sim) seam) through a view taken AT the open →
CLOSE — mark-to-market (`_mark_to_market`, documented carry rule with recorded `StaleMark`s) →
CLOSE — if `schedule_fires` ∧ warm-up gate ∧ fill session in window: M3 `evaluate_strategy` →
`reconcile` (ADR-0005 verbatim) → queue orders for `next_session_after`. The queue is empty at
every evaluation instant, so ADR R16 holds structurally.

**Concepts introduced:**
- **Planning price ≠ fill price, by construction.** Reconciliation sizes at session-D closes
  (the only knowable prices at the instant); fills read the D+1 open through an
  availability-gated view that exposes that open but NOT that session's close. The fixture's
  `open_i = close_{i−1}` identity makes the two equal, so the goldens isolate the 5-bps cost
  drag — and a dedicated synthetic test proves real drift is visible when opens differ.
- **The cost-drag scaling signature.** A fully-invested rebalance costs `PV·1.0005 > cash`, so
  the canonical LAST buy scales down (ADR D11.3) on every rebalance — visible in every Strategy A
  fill event as `scaled=True` on SPY.
- **Reporting vs trading data rules.** Valuation may carry the most recent visible close
  (recorded, never silent — the IWM-missing session marks stale and the run continues); trading
  never may (reconciliation fails atomically on a missing same-session close).
- **Pure schedule firing.** "Last valid session of week/month" is defined over the calendar's
  session set — Good-Friday weeks fire Thursday; the truncated final ISO week fires Tuesday
  2026-06-30 (pinned deliberately).
- **Result immutability as the Storage seam.** `BacktestResult` is a frozen in-memory record
  (calendar+timezone echoed; five engine instants recorded); persistence is M7's job.

**Files:** `quantize/engine/{schedule,state,orders,reconcile,fills,metrics,records,backtest,
errors}.py`; additive `market/calendar.next_session_after` + `DataView` opens; `scripts/
{node24,gate}.ps1`; `tests/{test_engine_*,test_market_open_access,test_reference_backtests,
engine_harness,golden_utils,conftest}.py`; `tests/goldens/strategy_a_backtest.json`.

**Reading path:** `test_engine_reconcile.py` (ADR examples A–H as executable truth) →
`engine/backtest.py` module docstring → `test_reference_backtests.py::
test_strategy_a_first_rebalance_hand_computed` (1,000,000 all-cash → ⅓ each of IWM/QQQ/SPY sized
at the 2025-07-31 closes, filled at the 08-01 open, SPY scaled by the cost drag; total return
+31.6% over the fixture, max drawdown < 0.1 bps).

**Exercise (after review):** predict, then verify with the golden, WHY Strategy A produces
corrective orders at every month-end after the first even though the target trio never changes
(answer: the cost drag makes realized weights lag targets by ~5 bps of traded notional, and the
three growth rates diverge realized weights between rebalances).

**Status:** M4 implemented; Codex-audited (request-changes round: engine-unsupported bps cost
factor now fails structured, run records carry the full calendar + actual-fill instants — all
applied); full gate green (571 tests; ruff/format/mypy/codegen/tsc clean). Golden file generated
under `--update-goldens` discipline; the branch is uncommitted pending founder acceptance. Next
after acceptance: **M5** (Strategy B golden + cap redistribution depth).

---

## M5 — Strategy B golden + cap-overflow coverage (2026-07-02)

A deliberately small milestone on the M4 engine: no production code changed — tests, goldens,
one `.gitattributes` line, and the plan (`docs/plans/2026-07-02-m5-strategy-b-plan.md`).

**Concepts introduced:**
- **Line-ending pins are part of golden discipline.** A fresh Windows checkout CRLF-normalized
  the M4 golden and broke its byte comparison locally while CI (Linux/LF) stayed green — the
  mirror image of the earlier libm `pow` lesson (CI red, local green). Committed byte-compared
  artifacts need BOTH platform-stable math (cumulative products, no libm) and a
  `.gitattributes` `text eol=lf` pin. `tests/goldens/*.json` is now pinned like the codegen
  artifacts.
- **Strategy B's cash identity, end-to-end.** At every evaluation, target cash is exactly
  `0.25 × PV` (the masked VNQ sleeve) — asserted across all 36 weekly evaluations, with the
  first rebalance fully hand-computed: buy 250,000/close each of AGG/EFA/SPY, spend
  750,000×1.0005 = 750,375, cash 249,625, nothing scaled. Total return +7.41% (blended slow
  growers, 75% invested) — hand-plausible.
- **What "overflows the cap" can mean in a v0 graph.** Every v0 portfolio constructor emits
  EQUAL weights, so an in-graph overflow always caps every asset simultaneously — the waterfall's
  no-eligible-capacity rule (excess to cash, cap never violated). Exercised through the full
  engine: top-2 momentum at 0.5/0.5 under a 0.4 cap → {0.4, 0.4} + 0.2 cash, `risk.cap_applied`
  trace event visible in the run record. The unequal-weight PROPORTIONAL waterfall remains
  unit-level coverage (M3 + a new tie case: equal eligible receivers split excess exactly in
  half) until a node that produces unequal weights exists.

**Files:** `.gitattributes` (goldens LF pin); `tests/test_engine_cap_overflow.py`;
`tests/goldens/strategy_b_backtest.json`; Strategy B section of
`tests/test_reference_backtests.py`; one tie test in `tests/test_nodes_risk.py`.

**Exercise (after review):** from the Strategy B golden, explain why the weekly corrective
orders are an order of magnitude smaller than Strategy A's monthly ones (answer: drift scales
with both the inter-asset growth spread AND the rebalance interval — B's weekly cadence and
narrower growth spread both shrink it).

**Status:** M5 implemented; full gate green (579 tests; ruff/format/mypy/codegen/tsc clean).
Awaiting review. Not committed. Next after acceptance: **M6** (structured trace construction).

---

## M6 — Structured trace construction (2026-07-02)

Schema-versioned payload contracts over the untouched M2 envelope, deterministic per-instant
trace trees, and the tracing on/off switch. Plan-of-record:
`docs/plans/2026-07-02-m6-trace-construction-plan.md` (adversarially reviewed before code; the
`engine.` namespace reservation, the outputs-produced relabeling of `transform.computed`, and
the reverse-coverage test all came out of that review).

**Concepts introduced:**
- **Traces record, never recompute.** Every payload field is read from a value production
  execution already computed (node locals, `ReconciliationOutcome`, `Fill`, `PortfolioState`) —
  tracing that re-derives a decision is a second implementation waiting to drift.
- **Version inside the payload.** The envelope is a fixed M2 contract, so each payload carries a
  const-pinned `"v"` — schema evolution without envelope churn. Every node declares
  per-event `TraceEventSpec`s beside its emitter (no central switch); `trace_schema` (the M2
  field, "used at M6") is now the derived `oneOf`.
- **Namespaces where identity can't discriminate.** `NodeId` can't express an uncollidable
  sentinel, so engine events are separated by the reserved `engine.` EVENT-TYPE namespace, enforced at
  the emission boundary (the node sink refuses `engine.*` outright), by validation (identity
  must be exactly `engine` at top level), and by tree separation — a user node literally
  named `engine` keeps its own tree node and cannot spoof engine events.
- **Structured distinctions as first-class facts:** genuinely-false vs defaulted-on-missing
  (`logic.evaluated`), unranked vs ranked-but-unselected (`select.excluded` vs
  `select.selected.unselected`), proposed vs omitted orders (dust/hold plan rows) vs scaled
  fills.
- **Reverse coverage.** Beyond "everything emitted is declared and valid," the suite asserts
  every DECLARED spec is exercised somewhere — a declared-but-dead contract fails loudly.
- **On/off equivalence as a falsifiable claim:** `collect_trace=False` runs compare equal to
  traced runs on every field except `trace` (full-object `dataclasses.replace` comparison).

**Files:** `quantize/tracing/{spec,tree,validate}.py`; `quantize/engine/trace.py`; additive
`descriptor.trace_events`; `TraceRecorder.emit_at`/`enabled`; all node modules; engine events in
`backtest.py`; `tests/test_trace_{spec,tree,goldens}.py`; three trace goldens.

**Reading path:** `test_trace_goldens.py::test_strategy_b_first_evaluation_tree_golden` — the
`gt` node's `logic.evaluated` shows VNQ genuinely failing the trend test (not missing), `mask`
zeroes it, `tp` finalizes the three 0.25 sleeves, and the engine proposes the three buys with
zero omissions; then open `tests/goldens/trace_strategy_b_first_evaluation.json` and read the
same story as bytes.

**Exercise (after review):** predict which tree the componentized Strategy A's
`transform.excluded` for IWM lands in and under whose children — then check
`test_trace_tree.py::test_nested_component_tree_identity_and_events`.

**Status:** M6 implemented; full gate green (603 tests; ruff/format/mypy/codegen/tsc clean).
Awaiting self-review + founder review + Codex audit. Not committed. Next after acceptance:
**M7** (persistence + migrations + durable result/trace storage).

---

## M7 — Persistence, migrations, durable run/trace storage (2026-07-02)

SQLite behind a repository layer per ADR-0004 (stdlib `sqlite3`, zero new dependencies), with
migration discipline from the first persistence commit. Plan-of-record:
`docs/plans/2026-07-02-m7-persistence-plan.md` — three adversarial reviews BEFORE code caught
two genuine data-loss bugs in the design (silently loading unsupported IR `schema_version`s;
dropping the evaluation/scheduled-fill instants along with the calendar) and pinned the SQLite
transaction configuration.

**Concepts introduced:**
- **The stdlib sqlite3 transaction trap.** The driver's legacy `isolation_level` mode issues
  implicit BEGINs and historically auto-commits around DDL — the only deterministic
  configuration is `isolation_level=None` plus explicit `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`
  (`quantize/persistence/database.py`). Migration DDL + its bookkeeping INSERT, and the run
  record + its whole trace stream, are each ONE atomic unit — fault-injection tests prove a
  mid-stream failure persists nothing.
- **Two version axes, both gated.** Persistence formats (`record_format`/`trace_format`,
  migrated forward-only at LOAD through an explicit registry) are independent of the IR's own
  `schema_version` (gated against M1's supported set — `model_validate` checks SemVer SYNTAX
  only, a distinction the plan review caught).
- **Never-silently-lossy as a mechanism, not discipline:** every migration declares its
  `dropped_keys`; a generic registry test fails on any undeclared key disappearance.
- **Facts, not recomputation.** `PersistedRunRecord` copies what the engine DID — including the
  evaluation/scheduled-fill instants, the `returns` series, dust/hold plan rows, and failure
  diagnostics with node paths. The calendar is an engine INPUT and is not persisted.
- **Artifact identity = content hash of the EXACT stored bytes** (M1 `to_ir_json`, insertion
  order — never re-sorted); duplicates are idempotent no-ops, divergent saves under an existing
  key are structured conflicts, and there is no update API: persisted artifacts are immutable.
- **Corruption is loud:** tampered bytes fail the recorded hash; a gapped trace `seq` is
  CORRUPT, never a silently shorter stream; a database AHEAD of the code refuses to open.

**Reading path:** `tests/test_persistence_runs.py::test_format_zero_row_migrates_through_the_production_load_path`
(the migration seam end-to-end), then `save_run` in `quantize/persistence/runs.py`.

**Exercise (after review):** predict what happens when the same run is saved into two separate
databases and the stored bytes are compared — then check
`test_persisted_artifacts_are_deterministic_across_databases` and explain why `saved_at`
doesn't break it.

**Status:** M7 implemented; full gate green (657 tests after two Codex correction rounds). Awaiting self-review + founder review +
Codex audit. Not committed. Next after acceptance: **M8** (forward/paper deterministic replay +
backtest↔forward consistency), consuming `load_run`/`load_trace` as its stored-facts oracle.

---

## M8 — Deterministic forward replay + backtest↔forward consistency (2026-07-02)

The same engine, driven two ways. Plan-of-record:
`docs/plans/2026-07-02-m8-forward-replay-plan.md` — both adversarial plan reviewers
independently converged on the same blocker (the window-tail edge) before a line of code.

**Concepts introduced:**
- **Extraction as the consistency proof.** `run_backtest`'s loop body moved VERBATIM into
  `SessionEngine.step` (`quantize/engine/backtest.py`); the backtest drives it over the whole
  window, `ForwardReplay` (`quantize/engine/forward.py`) drives the SAME step one session at a
  time. The modes cannot diverge in behavior because there is only one behavior — the
  extraction gate was the full 657-test suite passing untouched, goldens included.
- **Bounded replay is a semantic choice, not a convenience.** The engine's tail rule (an
  evaluation whose fill would land beyond the window is suppressed with a note) requires a
  KNOWN end; an open-ended driver would instead queue an order that dangles. v0 forward
  replay REQUIRES `last_session`; open-ended tails are deferred with the live-data adapter.
- **The calibrated claim, instantiated.** ARCHITECTURE §3 hedges consistency on data-source/
  history/environment differences — all null in v0 (same fixture, same `as_of` gating). Full
  field-for-field equality (same run_id, bounded window, advanced to exhaustion) is therefore
  the STRONGEST valid form of "agreement on overlapping decisions," and it holds for
  Strategies A and B — targets, orders, fills, valuations, notes, metrics, final state, and
  the trace with its separately-modeled instants.
- **Stored facts as the oracle.** The battery saves the backtest via M7, REOPENS the database,
  and compares the forward run against the LOADED record and trace — never recomputed facts
  relabeled as stored ones.
- **Restart determinism:** a checkpoint taken WITH pending overnight orders (they legitimately
  span an `advance()` boundary) resumes deterministically — twice, identically — and equals
  both the uninterrupted replay and the backtest.
- **The test-only stateful accumulator** (STRATEGY_LANGUAGE §5; `tests/stateful_fixture.py`,
  never the product registry): identical state trajectories across modes, with each firing's
  last-visible-session doubling as a direct lookahead witness (an evaluation at k never saw
  k+1). It proves TIMING equivalence; checkpointable node state stays deferred.

**Exercise (after review):** predict what `run_backtest(last_session=k)` and a forward replay
bounded to the same k each do when k is an evaluation day whose fill would land at k+1 — then
read `test_bounded_forward_equals_bounded_backtest` and the plan's amendment 1.

**Status:** M8 implemented; full gate green (677 tests after self-review + Codex round 1). Awaiting self-review + founder review +
Codex audit. Not committed. Next after acceptance: **M9** (API boundary).

---

> Template for future entries:
>
> ## M<n> — <title> (<date>)
> **Concepts introduced:** …
> **Files studied:** …
> **Reading path:** …
> **Exercise (implement by hand):** … *Prediction:* … *Outcome:* …
> **Status:** …


## Pre-M9 remediation sprint (2026-07-03)

**Concepts introduced:**
- *Warm-up as an exact contract:* declared warm-up = visible sessions required STRICTLY BEFORE
  the evaluation session (gate fires at `visible > total`). The spec itself carried an
  off-by-one for `moving_average` (declared `window`, correct is `window - 1`) and `latest`
  (`1` -> `0`); the correction moved Strategy B's first evaluation one week earlier
  (2025-10-17, the first session where a 200-window MA exists). Lesson: a convention is only a
  contract when BOTH ends (declaration and gate) are pinned to the same sentence.
- *Exact-output optimization:* two cliffs fixed WITHOUT changing a single output byte — a
  run-scoped positive point cache for MA (a computed point is immutable because visibility is
  monotone in the cutoff; absent points are re-attempted for late-arriving data), and an
  incremental visibility cursor answering the engine's three per-session point queries instead
  of materializing the full as-of view. Proofs: memo-on/off bit-exact repr comparison, cursor
  property-equality vs `as_of` under adversarial availability, and unchanged persisted-record
  hashes. 1000 sessions x 100 assets full run: ~133 s -> 11.6 s.
- *Honest provenance:* run records (format 2) now carry dataset/calendar content fingerprints;
  legacy rows migrate to an EXPLICIT `unknown` — identity is recorded or declared absent, never
  fabricated.
- *Boundary discipline completed:* every SQLite failure is structured (`corrupt_database`,
  `database_locked` at begin/statement/commit/query phases, `integrity_violation`); no module
  outside `database.py` imports sqlite3 (tripwire-tested); `-0.0` canonicalizes to `0.0` at the
  single serialization choke point.

**Files studied:** `quantize/nodes/transform.py` (warm-up lambdas + memo), `quantize/market/
data.py` (`MarketDataCursor`), `quantize/runtime/binding.py` (`EvaluationMemo`),
`quantize/persistence/provenance.py`, `database.py`, `docs/plans/2026-07-03-pre-m9-remediation-
plan.md`, `docs/plans/2026-07-03-m9-api-plan.md`.

**Exercise (implement by hand):** add a `transform.median` node declaring its warm-up under the
pinned convention. *Prediction:* window W needs W-1 — same as the MA, because a median over W
sessions is computable exactly when W are visible.

**Status:** remediation sprint complete on `fix/pre-m9-remediation`; both gates green
(PowerShell + POSIX); awaiting founder review + Codex audit. Not committed.


## M9 — API boundary + strategy/component versioning (2026-07-03)

**Concepts introduced:**

- *Thin-boundary translation.* The API is a translation layer — HTTP → governed DTO (or raw IR
  document) → an EXISTING domain service → a governed result → HTTP — with **zero** business logic
  in `quantize/api/`. Every computation is an existing engine/persistence entrypoint (`run_backtest`,
  `ForwardReplay`, `RunRepository.save_run`, `run_document_preflight`); the boundary owns nothing
  numerical (tested: no pandas/numpy in `quantize/api/`). *Where:* `quantize/api/service.py`,
  `quantize/api/routes/`.
- *The no-second-implementation proof, made HTTP.* The validate endpoint runs the SAME
  `run_document_preflight` the evaluator runs; a 3-way parity test asserts endpoint codes ==
  preflight codes == real-run rejection codes over the invalid corpus. To make this possible, M9.1
  extracted the evaluator's five document checks into a shared `preflight.py` returning NATIVE
  per-layer diagnostics (structural/semantic carry `loc`; runtime carries `node_path`) — a pure
  refactor proven byte-identical to the old inline path.
- *Per-request resource ownership.* Handlers are synchronous `def` (threadpool) and open their own
  `Database` in their own body (`with Database(...) as db:`) — guaranteeing sqlite3's same-thread
  contract with a deterministic close and no shared mutable state. The raw request body reaches a
  sync handler via an ASYNC dependency (`_raw_body`) so bodies validate straight from bytes on
  pydantic-core's Rust path — a depth-bomb is a clean 400, never a Python `RecursionError` (500).
- *Contract-first DTOs with codegen governance.* A SECOND governed bundle
  (`schema/quantize-api.schema.json` + `ts/quantize-api.d.ts`) rides the existing codegen, staleness
  gated in CI, with contract tests mirroring the IR ones. json2ts needs a reachable root, so the
  API bundle uses a synthetic object root (no natural union) referencing every DTO. DTO modules
  import no fastapi, keeping the codegen job lock-only.
- *Staged validation semantics + honest facts.* HTTP status encodes WHERE a request failed: parse
  (400), unsupported `schema_version` (422, a pre-parse string gate robust to future-version
  documents), immutable-conflict (409), not-found (404). But a run that produces `ok:false` is a
  run FACT, not an HTTP error — it persists and returns 201; the client reads `ok` from
  fetch-results. Fetch-results returns the stored record VERBATIM (embedded `to_ir_json` bytes)
  with `replay_verifiable` beside it, never inside it.

**Files studied:** `quantize/api/app.py` (factory, body-size middleware, lifespan) → `quantize/api/
routes/*` → `quantize/evaluator/preflight.py` → `quantize/api/dto/*` → `quantize/codegen/schema.py`
(second bundle). Also `quantize/api/errors.py` (the per-(endpoint-class, code) taxonomy + context
scrubbing) and `quantize/persistence/datasets.py` (content-addressed store, migration v2).

**Reading path:** start at `create_app` in `app.py` (what is wired, in what order); follow one POST
route (`routes/strategies.py`) through `parsing.load_ir_document` to `StrategyRepository`; then read
`routes/validate.py` beside `preflight.run_document_preflight` to see the one implementation with
two call sites.

**Exercise (implement by hand):** add `GET /v1/strategies/{id}/versions/{version}/semantic-equality
?other=<version>` — load both stored versions, compare via the existing semantic-equality (the
`ui.*`-excluding comparison), and return `{equal: bool}`. *Prediction:* two versions differing only
in a node's `ui` field are semantically equal (bytes differ → 409 on save, but semantic-equality is
true) — the same fact that makes the ui-only-edit test a 409. *Outcome:* …

**Status:** M9 implemented on `feat/m9-api-boundary` across packets M9.0–M9.8; both gates green
(PowerShell + POSIX), 825 tests. M9.9 (replay-verify endpoint) deferred per founder decision #3.

---

## M10 — Registry-descriptor + parameter-form metadata API (2026-07-04)

**Concepts introduced:**

- *Derived contracts vs. sources of truth.* The node catalog is **generated from the registry per
  request** and **never persisted** — the route builds a fresh `build_core_catalog()` and projects
  descriptors on every GET. Because the catalog cannot be stored, it cannot drift from the registry
  that produced it: this is the concrete mitigation for "descriptor/registry divergence." Contrast
  with the persisted IR document (a genuine stored source of truth needing migrations): a projection
  has no such lifecycle. *Where:* `quantize/api/routes/catalog.py`, `quantize/registry/export.py`.
- *Content hashing as identity.* `catalog_digest` is a SHA-256 over the canonical JSON of the
  projection **body** (the `compatibility`/`node_types`/`port_types` object, sorted keys, tight
  separators) — deliberately **excluding** the `api_version`/`schema_version` labels and the digest
  itself. It gives the M11 editor a cache key that changes **exactly when the metadata changes** and
  not otherwise, so a client can skip re-rendering when the hash is unchanged. *Where:*
  `quantize/registry/export.py` (`catalog_digest`).
- *Closed type lattices.* The 8-member `PORT_TYPE_LATTICE` and the derived 9-pair compatibility
  allow-list are **enumerable** only because the `PortType` union is *closed* (a fixed set of
  `kind`/`dtype` Literals). A closure test derives the full variant set from the union's type
  annotations and asserts equality with the pinned tuple — so a future `Matrix`/new-dtype
  registration **fails loud** there instead of silently under-reporting the lattice. The
  compatibility list is enumerated by calling the single shared `is_compatible` over the lattice's
  cartesian product — derived data, never a re-encoded rule. *Where:* `quantize/schema/types.py`
  (the union + `render_port_type`), `quantize/registry/export.py`, `quantize/compatibility.py`.
- *Verbatim JSON Schema as the form contract.* Each node's `parameter_schema` is served **as-is** —
  the exact Draft 2020-12 fragment the node declares (`JsonSchemaSpec.document`, a deep copy), not a
  flattened field list. So rich parameter shapes survive intact: `portfolio.fixed_weight`'s `oneOf`
  and `universe.fixed_list`'s array would be destroyed by a flat form-field DTO, and are exactly why
  the payload promises "a self-contained JSON Schema document," not a keyword list. Defaults live
  only in the schema's `default` keyword — no parallel defaults field. *Where:*
  `quantize/registry/schema_spec.py` (`document`), `quantize/api/dto/catalog.py` (`NodeTypeDto`).

**Files studied:** `quantize/registry/descriptor.py` (the `NodeDescriptor` model, built for this in
M2) → `quantize/registry/export.py` (lattice, `compatible_pairs`, `catalog_digest`) →
`quantize/api/dto/catalog.py` (the six governed DTOs) → `quantize/api/routes/catalog.py` (the pure
projection handler). Also `quantize/registry/schema_spec.py` (the new `document` accessor exposing
the held schema) and `quantize/schema/types.py` (the closed `PortType` union + `render_port_type`).

**Reading path:** start at `export.py` to see the pure derivation primitives (what the lattice is,
how compatibility is enumerated from `is_compatible`, how the digest is computed); then read
`schema_spec.py`'s `document` property (the one enabling change in `registry/` — why a deep copy);
then `dto/catalog.py` (the wire shapes, all frozen/extra-forbid); finally `routes/catalog.py` to see
those three composed per request with no DB and no numerics. Confirm the seam: the endpoint calls
domain functions, it does not re-implement them.

**Exercise (implement by hand):** in a **scratch branch**, add a hypothetical widening
`Scalar[Boolean] -> CrossSection[Boolean]` to `is_compatible` in `quantize/compatibility.py`, then
run `pytest`. *Prediction:* exactly THREE tests fail — the compatible-pairs count/shape test in
`tests/test_registry_export.py` (9 → 10 pairs), the endpoint compatibility-enumeration/count test in
`tests/api/test_catalog_endpoint.py`, and the committed golden `tests/goldens/node_catalog.json`
(the extra pair changes the pinned body). Note the parity test
(`test_compatibility_equals_is_compatible_enumeration`) does NOT fail — it re-derives from the same
mutated `is_compatible`, so it stays green: that is the point of derived-not-duplicated data. Then
revert the branch. *Outcome:* … (left for the founder to run and record).

**Status:** M10 implemented on `feat/m10-descriptor-api` across packets M10.1–M10.4; both gates
green (PowerShell + POSIX), 866 tests. This is a **projection** endpoint — no persistence, no
migration, no engine change; the catalog is derived from the registry per request.

---

## M11 — The visual editor: Build → Test → Run → Inspect → Modify (2026-07-04)

**Concepts introduced:**

- *Document-as-store with derived React-Flow views (D4).* The canonical strategy is the **persisted
  JSON IR**, held in a single `useReducer`-style store; every mutation routes through **pure
  reducers** and React Flow's nodes/edges are **derived** from the document on each render, never a
  parallel source of truth. Dragging a node writes `ui.*` back through a reducer; `ui.*` round-trips
  but is excluded from execution/equality (invariant 1). This is the frontend expression of the
  source-of-truth hierarchy: the view is disposable, the document is not. *Where:*
  `web/src/document/store.ts` (reducers), `web/src/document/flow.ts` (document → RF projection),
  `web/src/App.tsx` (the store owns `doc`; `selectedNodeId`/`highlightedEdgeIndex` are *derived* view
  state, never a second document).
- *Compatibility as allow-list DATA, not frontend logic (D5, invariant 5).* The editor gates a
  connection by **looking up a pair in the server-provided compatibility allow-list** (from
  `GET /v1/node-types`), never by re-implementing `is_compatible` in TypeScript. There is **no**
  `kind`/`dtype` conditional in the app — the one `is_compatible` lives in Python and ships to the
  client as enumerated data. *Where:* `web/src/catalog/` (the fetched catalog + `portTypeKey`
  lookup), consumed by the canvas connection guard.
- *Schema-driven forms + structured diagnostics (D6).* Parameter forms are **rendered from each
  node's verbatim JSON Schema** (the `oneOf`/array shapes survive intact — no flat field DTO), and
  validation highlights are resolved **purely from a diagnostic's `loc`/`node_path`**, NEVER by
  parsing its human message. A structural `("nodes", i, …)` maps to the node at index `i`; a runtime
  `node_path[0]` maps to a node id. *Where:* `web/src/components/ParamForm.tsx`,
  `web/src/components/ValidatePanel.tsx` (see its header comment: "HIGHLIGHTING IS STRUCTURED — we
  NEVER parse a message").
- *Presentation-only trace grouping that MIRRORS the server (D10).* The trace explorer regroups the
  flat event stream **client-side**, reproducing `tracing/tree.py`'s exact ordering: identity is
  `(component_path, node_id)`, hierarchy follows component-path **prefixes**, siblings keep
  **first-emission** order (a JS `Map`'s insertion order — never sorted), and **engine-origin events
  (`engine.` prefix) form a separate root placed AFTER all node roots**. Grouping is *presentation*,
  not a re-decision — it only rearranges events the engine already emitted. Tailored renderers key on
  the machine `event_type` token and read **structured payload fields** (`reason`, `omitted` dust/hold
  rows, `scaled`); an unknown `event_type` degrades to a generic key/value renderer. No prose is ever
  parsed. *Where:* `web/src/trace/group.ts` (the pure twin of `build_trace_trees`),
  `web/src/components/TraceView.tsx` (the renderers + session picker).
- *The persisted IR stays the single source of truth across an interactive editor.* Every server
  concern (catalog, strategies, datasets, runs, results, traces) is **fetched, never mirrored**: the
  App holds only the current *selections* (dataset id, run id) the panels coordinate over. Session
  dates for the trace picker come from the **run record's** `evaluations[].session_date`, not a client
  guess. *Where:* `web/src/api/client.ts` (pure typed transport, imports every shape from
  `@quantize/*` — declares no domain type of its own), `web/src/components/{DatasetPanel,RunPanel,
  ResultsView,TraceView}.tsx`.

**Files studied:** `web/src/document/store.ts` + `flow.ts` (the canonical store and its RF
projection) → `web/src/catalog/index.ts` (the fetched allow-list + port-type keys) →
`web/src/components/*` (ParamForm, ValidatePanel, Canvas, DatasetPanel, RunPanel, ResultsView) →
`web/src/trace/group.ts` + `web/src/components/TraceView.tsx` (the presentation grouping and tailored
renderers), against the server contract in `quantize/tracing/tree.py`.

**Reading path:** start at `web/src/document/store.ts` to see the pure reducers and why the document
is canonical; then `web/src/document/flow.ts` to see the RF view *derived* (not stored); then
`web/src/catalog/` to see compatibility arrive as data; then `web/src/components/ParamForm.tsx` /
`ValidatePanel.tsx` for schema-driven forms + structured (never message-parsed) diagnostics; finally
`web/src/trace/group.ts` beside `quantize/tracing/tree.py` — read both `build_trace_trees` and
`groupTrace` side by side and confirm the client mirrors the server (engine-root-after-node-roots,
first-emission sibling order) rather than re-deciding anything.

**Exercise (implement by hand):** in a **scratch branch**, add a second trace event to the
`groupTrace` fixture in `web/src/trace/group.test.ts` at the **same** `(component_path, node_id)` as
an existing one but emitted LAST in input order, then run `npx vitest run src/trace`. *Prediction:*
the two events collapse into the **same** `TraceNode` (identity is `(component_path, node_id)`, not
per-event), appended to that node's `events` in emission order, and the node's **position among its
siblings does not move** (first-emission order is fixed by when the node *first* appeared, not its
last event). Then, as a contrast, change the added event's `event_type` to start with `engine.` and
predict where it lands (a separate engine root, after all node roots) before re-running. *Outcome:* …
(left for the founder to run and record).

**Status:** M11 implemented on `feat/m11-editor` across packets M11.1–M11.7; both gates green
(PowerShell + POSIX), **875 Python tests + 119 web (vitest) tests**. One additive backend endpoint
(`GET /v1/datasets`, D12) landed in M11.1; everything else is the `web/` Vite React editor. A
live-browser end-to-end pass of the full §3 journey (Build → Test → Run → Inspect → Modify) remains
for the founder to walk through manually.
