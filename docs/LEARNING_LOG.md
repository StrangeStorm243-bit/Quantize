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

> Template for future entries:
>
> ## M<n> — <title> (<date>)
> **Concepts introduced:** …
> **Files studied:** …
> **Reading path:** …
> **Exercise (implement by hand):** … *Prediction:* … *Outcome:* …
> **Status:** …
