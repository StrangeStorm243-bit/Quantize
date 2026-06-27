# M1 Implementation Plan — IR Schema, Structural Validation, Codegen

**Status:** Approved-with-corrections; awaiting final Codex review of this plan + the M0 spec diff.
**Branch:** `feat/m1-ir-schema`. **Predecessor:** M0 baseline `dc2366d` (tag `m0-foundation`).
**This document is authoritative for M1 scope.** It records the decisions from the pre-M1 contract
audit (areas A–J). Where it refines an M0 spec, the corresponding minimal edit is also applied to the
authoritative M0 document; full detail lives here.

---

## 1. Objective and exclusions

**Objective.** Build the Quantize IR as Pydantic v2 models; generate a language-neutral **JSON
Schema** and **TypeScript types** deterministically (after a compatibility spike); implement
**structural-only validation**; ship valid + negative **fixtures** and tests. The IR must be
**generic and extensible** — a structurally valid document can reference an unknown future node type;
M1 accepts its structure, M2 (registry) rejects unresolved types.

**In scope (M1).** Pydantic IR models; strict persisted-JSON policy; `semantic_projection`; JSON
Schema + TS codegen with a staleness gate; structural validation (the M1 column of §4); valid
reference-strategy fixtures (A, B) and negative/boundary fixtures; tests; toolchain + CI.

**Out of scope (M1) — only the seam is preserved, nothing built:** node registry / catalog /
descriptors of any kind; semantic validation; engine, evaluator, adapters, reconciliation; UI;
market-data price fixture; AI block generation; arbitrary Python / formula DSL / sandboxing; model
artifacts; containers/workers; external services; custom-node publishing; marketplace; user-created
port types; incremental recomputation; distributed backtesting; non-`graph` component implementation
kinds.

---

## 2. Audit decisions (A–I) as applied

- **A. `type_version` is REQUIRED** for ordinary registered node instances. Every ordinary node
  identifies `type_id` **and** `type_version`. A saved strategy never resolves an unspecified version
  to "latest." The **reserved `component` node** uses a *different* mechanism: it carries `ref` (to a
  `component_refs` entry); its version is the pinned **`ComponentRef.version`** (the component-
  definition version), which is **not** a node-contract version and must not be confused with it.
- **B. Component implementation seam:** the v0 graph implementation is wrapped in an explicit
  discriminator `{ "kind": "graph", ... }`. Additional kinds (`formula`, `builtin`, `sandboxed`,
  `model`, `external`) are **future schema additions, not implemented in M1**; no placeholders.
- **C. Strict JSON + extension semantics:** governed models use `extra="forbid"`; values are a finite
  recursive `JsonValue` (NaN/Infinity rejected); portable round-trip. **`ui`** = explicitly
  presentation-only, **non-semantic** (removed by `semantic_projection`). **`extensions`** =
  namespaced, preserved, and **semantic by default** (kept by projection; affects document
  identity). Only fields documented presentation-only may be removed by projection; unknown
  extensions never silently change execution without affecting semantic comparison.
- **D. NodeCatalog deferred to M2.** M1 structural validation consults **no** node catalog, test
  catalog, implementation registry, or descriptor registry.
- **E. Market-data price fixture deferred** to slice **`M3-PRE — Market-Data Fixture`** (§8).
- **F. Toolchain:** **Node 24 LTS** (reject Node 25 EOL line). Python version decided empirically in
  M1.0 (§6) — test the pinned toolchain on installed 3.14 first; fall back to 3.13 only on documented
  evidence; or a tested 3.13–3.14 range with one canonical artifact-producing version.
- **G. Rename:** `semantic_equal` → **`semantic_projection(document)`** + **`documents_semantically_
  equal(a, b)`**, defined narrowly (§5). No isomorphism/algebraic-equivalence claims.
- **H. Component recursion boundary (resolved):** **Option 1.** M1 adds a bounded, structural
  `validate_component_set(definitions)` that detects direct **and** transitive recursion **within a
  caller-supplied set** of `ComponentDefinition`s. It does **not** fetch/resolve from any store.
  Precise input contract in §5. A single standalone definition validated alone can detect only
  **direct** self-reference; transitive cycles require the supplied set; references outside the
  supplied closure are **unresolved** and deferred to M2/M3 (not claimed as cycle-checked).
- **I. Datetime portability:** persisted datetimes (incl. `provenance.created_at`) are
  timezone-aware, normalized to **UTC**, serialized as **RFC 3339**; naive datetimes are rejected.

---

## 3. Final field-level IR shape

**Global config (governed models):** `extra="forbid"`; floats `allow_inf_nan=False`; `params`/`ui`/
`extensions`/`schema` hold generic `JsonValue`.

**Portable value type**
```
JsonValue = None | bool | JsonInt | float(finite) | str | list[JsonValue] | dict[str, JsonValue]
   # JsonInt = integer within the JS-safe range [-(2^53-1), 2^53-1]; larger magnitudes MUST be strings
   # NaN / +Inf / -Inf rejected on parse AND serialize
   # Tests assert generated JSON never emits NaN, Infinity, or an out-of-safe-range integer
```

**Primitives & identity**
- `NodeId`, `RefId`, `PortName` = constrained non-empty `str`
- `EntityId` = uuid `str`
- `SemVer` = `str` matching `MAJOR.MINOR.PATCH`
- `TypeId` = open namespaced `str`: either the reserved literal `"component"`, or a dotted pattern
  `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` (≥1 dot, e.g. `transform.rank`). Non-empty; **not** an enum.
- `Utc` = timezone-aware datetime, normalized to UTC, RFC-3339 serialized (naive rejected)
- `Count` = strict positive integer (rejects bool/float; `minimum:1` in schema) — used by versions
- `NonNegativeFinite` = number accepting int/float JSON, rejecting bool/NaN/∞ (`minimum:0`) — bps
- **Entity-specific fork refs** (HIGH-5): `StrategyForkRef = { id:EntityId, version:Count }` (strategy
  integer version) and `ComponentForkRef = { id:EntityId, version:SemVer }` (component SemVer)

**Closed / governed (v0)** — discriminated, not extensible by users in M1:
- `Schedule` (on `kind`): `{kind:"daily"} | {kind:"weekly"} | {kind:"monthly"}`
- `PortType` (on `kind`): `Scalar{kind,dtype∈Number|Integer|Boolean}` · `AssetSet{kind}` ·
  `CrossSection{kind,dtype∈Number|Boolean}` · `TimeSeries{kind,dtype=Number}` · `PortfolioTargets{kind}`.
  Used inside `ComponentDefinition.exposed_*`. **`OrderList` is engine-only and is NOT a constructible
  graph/component port type** — it cannot appear in any persisted strategy/component port (HIGH-4).
- `ExecutionPolicy` = `{ policy:"close_signal_next_session_open", valuation:"session_close",
  transaction_costs:{ model:"bps", bps:NonNegativeFinite } }`
- `Visibility` = `private | unlisted_readonly | unlisted_duplicable`
- `Implementation` (on `kind`): v0 only `{kind:"graph", graph:Graph}`

**Open / extensible**
- `type_id` is a `TypeId` (open, namespaced; NOT a closed enum). `"component"` is the one **reserved**
  governed type.
- `params`, `ui`, `extensions`, `ExposedParam.schema` are generic `JsonValue` maps.

**Node — a two-variant structural union** (`NodeInstance`, discriminated on whether `type_id` is the
reserved `"component"`; schema-visible, generic — not a closed node enum):
- `RegisteredNode` = `{ id:NodeId, type_id:RegisteredTypeId(dotted), type_version:SemVer,
  params:JsonObject, ui?:JsonObject, extensions?:JsonObject }` — `type_version` **required**, no `ref`.
- `ComponentRefNode` = `{ id:NodeId, type_id:"component", ref:RefId, params:JsonObject, ui?, ext? }` —
  `ref` **required**, no `type_version`.
- `params` is **required** (may be `{}`); `ui`/`extensions` optional. Validate a bare node via
  `NodeAdapter`.
- `Edge` = `{ from:[NodeId, PortName], to:[NodeId, PortName] }` (`from` via Pydantic alias)
- `Graph` = `{ nodes:list[NodeInstance], edges:list[Edge] }` (both **required**)

**Document & components**
- `StrategyDocument` = `{ schema_version:SemVer, strategy:StrategyMeta, execution_policy:ExecutionPolicy,
  schedule:Schedule, nodes:list[NodeInstance], edges:list[Edge], component_refs:list[ComponentRef],
  extensions:dict[str,JsonValue]? }` — `nodes`/`edges`/`component_refs` are **required** (may be `[]`).
- `StrategyMeta` = `{ id:EntityId, version:Count, name:str, description:str?,
  provenance:Provenance[StrategyForkRef] }`
- `Provenance[F]` (generic) = `{ owner:EntityId, creator:EntityId, contributors:list[EntityId]
  (required), forked_from:F?, visibility:Visibility, duplicable:bool, created_at:Utc }`. Strategy docs
  use `Provenance[StrategyForkRef]`; component definitions use `Provenance[ComponentForkRef]`.
- `ComponentRef` = `{ id:RefId, component_id:EntityId, version:SemVer }` (version **required**, pinned)
- `ComponentDefinition` = `{ component_id:EntityId, version:SemVer, schema_version:SemVer, name:str,
  description:str?, component_refs:list[ComponentRef], implementation:Implementation,
  exposed_inputs:list[ExposedPort], exposed_outputs:list[ExposedPort],
  exposed_params:list[ExposedParam], provenance:Provenance[ComponentForkRef],
  extensions:dict[str,JsonValue]? }` — `component_refs` and all `exposed_*` are **required** (may be `[]`).
- `ExposedPort` = `{ name:str, type:PortType, maps_to:[NodeId, PortName] }`
- `ExposedParam` = `{ name:str, binds_to:[NodeId, str], schema:dict[str,JsonValue] }`

**Canonical serialization (required persistence path).** Persist IR models only via `to_ir_json` /
`to_ir_dict` (`quantize/schema/serialization.py`) — never a bare `model_dump_json`. They dump in
Python mode, recursively revalidate portability, normalize datetimes to RFC 3339, emit IR aliases
(`"from"`), and **raise** on any non-portable state (NaN/∞, JS-unsafe int, mutated/unsupported value)
rather than rewriting it to `null`. Strict governed numerics (`Count`, `NonNegativeFinite`) reject
booleans; all contract collections are required (no silent defaults). Constraints are schema-visible
(`TypeId`/`EntityId` patterns, bounded recursive `JsonValue`, the two-variant node union).

**Version axes (four, never collapsed):** (1) `schema_version` — IR format; (2) `strategy.version` —
user revision (int); (3) **node `type_version`** — node-contract version (SemVer, per ordinary node
instance); (4) `ComponentDefinition.version` / pinned `ComponentRef.version` — component-definition
version. Axis 3 and axis 4 are distinct and must not be conflated.

---

## 4. M1 vs M2 validation responsibility

| Check | M1 structural (no registry/catalog) | M2 semantic (registry) |
|---|---|---|
| Document structure / required fields | ✅ | |
| Unknown fields on governed models → reject (`extra="forbid"`) | ✅ | |
| Values are portable JSON (no NaN/Inf); datetimes tz-aware/UTC/RFC3339 | ✅ | |
| `schema_version` present & supported | ✅ | |
| Unique node ids / unique ref ids | ✅ | |
| Edge endpoints reference existing node ids | ✅ | |
| No self-edges; graph is a DAG (no cycles) | ✅ | |
| `type_id`/`type_version` present per the node model rule | ✅ (presence/shape only) | |
| `component` node ⇒ `ref` present & matches a `component_refs` id | ✅ | |
| `component_refs` shape: pinned versions, no dup ref-ids, no missing local refs | ✅ | |
| Component **direct** recursion (definition references own `component_id`) | ✅ | |
| Component **transitive** recursion within a **supplied** definition set | ✅ (`validate_component_set`) | |
| Node `type_id` **exists**; `type_version` **available** | | ✅ |
| Port **names** exist; required ports connected; port-**type compatibility** | | ✅ |
| Node-specific **parameter** validation (vs descriptor) | | ✅ |
| Component **resolution** (fetch) / implementation availability / executability | | ✅ / M3 |

---

## 5. `semantic_projection` and `validate_component_set` — precise specs

**`semantic_projection(document) -> CanonicalForm`**
- **Precondition:** operates only on a **structurally valid** document; an invalid document is
  **rejected explicitly** (raises), never silently projected.
- **Removes** (presentation-only): `ui` on every node. (Only fields documented presentation-only are
  removed.)
- **Preserves** (semantic): `type_id`, `type_version`, `params`, node identities, `edges`,
  `schedule`, `execution_policy`, `component_refs`, `ref`, and **`extensions`** (semantic by default).
- **Canonicalizes declared-non-semantic ordering:** `nodes` sorted by `id`; `edges` sorted by
  `(from_node, from_port, to_node, to_port)`; `component_refs` sorted by `id`; object keys sorted;
  finite-float canonical formatting. (List order of these governed collections is declared
  non-semantic.)
- **`documents_semantically_equal(a, b)` := `semantic_projection(a) == semantic_projection(b)`.**
- **No** claim of graph isomorphism, algebraic, or mathematical equivalence — it is a documented
  field projection + canonical ordering, nothing more.

**`validate_component_set(definitions) -> ComponentSetValidation`** where
`ComponentSetValidation = { ok: bool, errors: list[StructuralError], unresolved_refs: list[Ref] }`.
This distinguishes the **three** outcomes deterministically (MEDIUM-2):
- **valid closed set:** `ok=True`, `errors=[]`, `unresolved_refs=[]`.
- **acyclic but incomplete:** `ok=True`, `errors=[]`, `unresolved_refs=[…]` — refs to
  `(component_id, version)` **outside the supplied set**; these are **not failures** (deferred to
  M2/M3 resolution), only reported.
- **cycle / structural error:** `ok=False`, `errors=[…]` (direct or transitive cycle within the
  supplied closure, or malformed ref).

- **Input contract:** the caller supplies a set of `ComponentDefinition`s. The function builds the
  directed dependency graph over `(component_id, version)` from each definition's `component_refs`
  and detects direct + transitive cycles **within the supplied closure**. It **does not fetch** from
  any store and **does not** consult a node catalog. A single definition validated alone detects only
  **direct** self-reference.

---

## 6. Toolchain decision process (M1.0 gate)

1. Pin a candidate toolchain (Pydantic v2, pytest, ruff, mypy, lock tool, `json-schema-to-typescript`).
2. **Test the pinned toolchain on the already-installed Python 3.14** end-to-end: install, lint,
   type-check, model round-trip, JSON Schema emission.
   - **All pass →** Python 3.14 is the canonical local + CI version.
   - **Concrete incompatibility →** fall back to **Python 3.13**, documenting the exact failing
     dependency + evidence.
   - **Alternative:** a tested **3.13–3.14 range** with **one** canonical version responsible for the
     committed generated artifacts (so codegen output is reproducible).
3. **Node:** Node 24 LTS, declared via `.nvmrc` + `package.json` `engines`, used identically in CI.
4. **Pinning policy:** compatible direct-dependency constraints in `pyproject.toml`; **exact resolved
   versions in the committed lockfile**; exact npm resolution in `package-lock.json`; **identical
   code-generation tool versions locally and in CI**. Do not duplicate unnecessary exact pins across
   files (constraints in `pyproject`, exact resolution only in the lockfiles).
5. **Reproducibility limits (honest scope).** `requirements.lock.txt` records the exact package
   versions used by the **canonical development environment (Python 3.14)**. CI installs those pinned
   versions (on the 3.14 job) to **reduce dependency drift**. **Artifact-level and cross-platform
   reproducibility are NOT guaranteed yet** — hash pinning and platform-aware locking are deferred, so
   a single `pip freeze` does not guarantee identical artifacts across Python versions, OSes, or
   architectures. Because the lock is canonical to 3.14, the **3.13 CI job resolves from `pyproject`
   constraints (a compatibility check)** rather than installing the 3.14-frozen lock verbatim.
6. **`build-system.requires` (hatchling)** is currently **unconstrained and floats independently** —
   an acknowledged limitation; build-backend reproducibility is deferred with the broader hash/
   platform-locking hardening (no new lock tooling now).

---

## 7. Slices, files, and acceptance tests

### M1.0 — Scaffolding, toolchain gate, CI
**Files:** `pyproject.toml`, lockfile (`uv.lock` or `requirements*.txt` w/ hashes), `package.json`,
`package-lock.json`, `.nvmrc`, `quantize/__init__.py`, `quantize/schema/__init__.py`,
`quantize/validation/__init__.py`, `tests/test_smoke.py`, `.github/workflows/ci.yml`, `CLAUDE.md`
(Repository commands).
**Acceptance:** toolchain decision (§6) executed & documented; smoke test passes; `ruff`/`mypy`
clean; CI green on chosen Python + Node 24; deps pinned/locked.

M1.1 is split into **two explicit review checkpoints** (MEDIUM-1) — each is its own commit with its
own acceptance criteria and founder review gate.

#### M1.1a — Primitives & atomic models *(review gate)*
**Files:** `quantize/schema/{primitives,types,schedule,nodes}.py` (`JsonValue`, `TypeId`, `SemVer`,
`Utc`, ids, `Schedule`, `PortType`, `NodeInstance`, `Edge`); `tests/test_primitives.py`,
`test_node_edge_models.py`.
**Acceptance (M1.1a):**
- **Portable JSON (HIGH-5):** `JsonValue` rejects NaN/Inf on parse; serialization never emits
  NaN/Infinity (serialize-side test); integer outside JS-safe range rejected (must be string).
- **`TypeId` (HIGH-3):** non-namespaced/empty ordinary `type_id` (`"rank"`, `""`) rejected;
  `"component"` accepted only for the reserved component node.
- **`PortType` (HIGH-4):** the constructible union excludes `OrderList`.
- **`NodeInstance` rule:** ordinary node without `type_version` rejected; `component` node without
  `ref` rejected; `component` node carrying `type_version` rejected.
- `schedule` rejects an invalid `kind`; governed models reject unknown fields (`extra="forbid"`).

#### M1.1b — Documents, components, fixtures, projection *(review gate)*
**Files:** `quantize/schema/{components,document,semantics}.py`; `tests/fixtures/strategy_a.json`,
`strategy_b.json`; `tests/test_models.py`, `test_roundtrip.py`, `test_semantic_projection.py`,
`test_datetime_portability.py`.
**Acceptance (M1.1b):**
- Strategy A & B parse and validate (contract); each ordinary node carries a namespaced `type_id` +
  `type_version`.
- Round-trip preserves `ui` **and** `extensions`; a `ComponentDefinition` exposing an `OrderList`
  port is rejected (HIGH-4).
- **Seam test:** a structurally valid document referencing an **unknown future namespaced `type_id`**
  is accepted by M1 (rejected later by M2).
- **Datetime:** naive `created_at` rejected; tz-aware round-trips to identical RFC-3339 UTC.
- **Projection:** `ui` change → equal; node/edge reordering → equal; change to **param / type_id /
  type_version / edge / schedule / component ref / `extensions`** → not equal; invalid document →
  projection rejects explicitly.

### M1.2 — Structural validation + negative fixtures
**Files:** `quantize/validation/{structural,errors}.py`; `tests/fixtures/invalid/*.json`;
`tests/test_structural_validation.py`. **No NodeCatalog.**
**Acceptance:** each negative fixture rejected with a clear, structured error — duplicate node id,
dangling edge endpoint, self-edge, cycle, unpinned/missing/duplicate `component_refs` entry, `direct`
component self-reference, `transitive` component cycle (via `validate_component_set` over a supplied
set), `component` node missing `ref`, non-portable JSON value.

### M1.3 — Codegen + staleness gate
**Files:** `quantize/codegen/` (schema + TS), `scripts/codegen.*`, `schema/quantize.schema.json`
(generated, committed), `ts/quantize-ir.d.ts` (generated, committed), `tsconfig.json`,
`tests/test_codegen_determinism.py`, CI staleness step.
**Acceptance (spike first):** the spike covers `$defs`/`$ref`, the discriminated `schedule` and
`PortType` and `Implementation` unions, `additionalProperties:false`, recursive `JsonValue`,
optional/required fields, generic param maps. Then: deterministic JSON Schema; deterministic TS;
**`tsc --noEmit` compiles**; **regeneration produces no git diff**; artifacts committed; generator
version pinned. If the spike fails on a construct, record evidence and choose a pinned fallback
generator before proceeding.

---

## 8. Deferred work (named, so it cannot be forgotten)

- **`M3-PRE — Market-Data Fixture`** (pre-M3 prerequisite slice). Builds the deterministic synthetic
  price dataset + fixture data contract (exchange calendar, timezone, valid sessions, open/close
  instants, open/close prices, data-availability timestamps, ≥1 weekend/holiday boundary, warm-up
  history; no corporate actions). **First consumer:** the `MarketData` adapter / as-of `DataView`
  used by the **M3** graph evaluator (and the M4 engine). **Required before M3 begins.**
- **NodeCatalog / registry / descriptors → M2** (first real consumer is semantic validation).
- **Non-`graph` `Implementation` kinds** (`formula`/`builtin`/`sandboxed`/`model`/`external`) →
  future schema additions, post-MVP.
- **Transitive recursion across un-supplied definitions** → M2/M3 component resolution.

---

## 9. Unresolved decisions

- **Canonical Python version** is resolved empirically by the M1.0 toolchain gate (§6); the plan does
  not pre-commit it. Everything else is decided.

---

## 10. Conflicts with M0 (all additive/deferrals; minimal spec edits applied)

1. `STRATEGY_LANGUAGE.md` §3/§8 — node instance gains required `type_id` + `type_version`; 4th
   version axis added; reference examples (§9) updated.
2. §7 — `graph` wrapped in `implementation` discriminator; transitive-recursion claim qualified to a
   supplied-set operation; `ComponentRef.version` vs node `type_version` distinguished.
3. §1/§2 — strict persisted-JSON policy (`extra="forbid"`, finite `JsonValue`, NaN/Inf rejected),
   `ui` (non-semantic) vs `extensions` (semantic), RFC-3339/UTC datetimes.
4. `MVP_PLAN.md` M1 — NodeCatalog deferred to M2; price fixture deferred to `M3-PRE`.

No M0 decision is reversed; the persisted-document-as-source-of-truth, one-engine, DAG, and
source-of-truth-hierarchy invariants are unchanged.
