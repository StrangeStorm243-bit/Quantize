# STRATEGY_LANGUAGE.md — The Quantize Strategy IR

This document specifies the **Intermediate Representation (IR)**: the serializable, versioned
strategy object. The visual canvas is an *editor* for the IR; the runtime is an *evaluator* of it.

## Source-of-truth hierarchy (read first)

1. **The versioned JSON strategy document** is the persisted instance and the **semantic source of
   truth** for a given strategy.
2. **The published JSON Schema** is the language-neutral **structural contract** for a schema version.
3. **Pydantic** is the v0 implementation that authors, generates, parses, and validates the schema.
4. **Registry rules and explicit runtime invariants** provide **semantic** validation (types,
   ports, node-specific rules).
5. **Generated TypeScript types** consume the published schema and are never hand-maintained.

> `ui.*` fields (coordinates, collapsed state) are **non-authoritative**. They are **preserved**
> through load → validation → serialization → round-trip, but are **excluded from runtime
> execution and from semantic equality**. They are never discarded and never affect results.

---

## 1. Top-level document shape

A strategy document is JSON, validated against the published JSON Schema (authored in Pydantic for
v0). Components are **not embedded**; a strategy references them by pinned reference (see §7).

```jsonc
{
  "schema_version": "0.1.0",          // IR schema version (semantic; engine-checked)
  "strategy": {
    "id": "uuid",                     // stable identity across versions
    "version": 3,                     // monotonic integer, increments per saved revision
    "name": "ETF Momentum Rotation",
    "description": "…",
    "provenance": {
      "owner": "uuid", "creator": "uuid", "contributors": ["uuid"],
      "forked_from": { "id": "uuid", "version": 2 } | null,
      "visibility": "private",        // private | unlisted_readonly | unlisted_duplicable
      "duplicable": false,
      "created_at": "2026-06-23T00:00:00Z"
    }
  },
  "execution_policy": { "policy": "close_signal_next_session_open", "...": "see §6" },
  "schedule": { "kind": "monthly" },          // discriminated variant — see §6 "Schedule semantics"
  "nodes": [ /* §3 */ ],
  "edges": [ /* §4 */ ],
  "component_refs": [ /* §7 — pinned references to standalone ComponentDefinition docs */ ]
}
```

### Persisted-JSON & extension policy

- **Strict governed structures.** Core IR models reject unknown fields (`extra="forbid"` in the v0
  Pydantic implementation). Generic open holders are exactly `params`, `ui`, `extensions`, and a
  component's `ExposedParam.schema`.
- **Portable values.** All persisted values are a finite recursive `JsonValue`
  (`null | bool | JS-safe-int | finite-float | str | list | object`); **NaN and ±Infinity are
  rejected** on both parse and serialize. Integers must lie in the JavaScript-safe range
  `[-(2^53-1), 2^53-1]` (larger magnitudes must be strings), so the TypeScript editor reads them
  losslessly. Round-trip is byte-portable JSON.
- **Datetimes** (e.g. `provenance.created_at`) are **timezone-aware**, normalized to **UTC**, and
  serialized as **RFC 3339**; naive datetimes are rejected.
- **Presentation vs. semantics.** `ui` is **presentation-only and non-semantic** — it is preserved
  through round-trip but **removed by `semantic_projection`** (below) and never affects execution.
  `extensions` is **namespaced, preserved, and semantic by default** — it is kept by
  `semantic_projection` and therefore affects document identity. Only fields documented
  presentation-only may be removed by the projection; an unknown extension may affect future
  executable behavior and so must never change execution without also changing semantic comparison.

### `semantic_projection` (semantic equality of documents)

`semantic_projection(document)` produces a canonical form for comparison; `documents_semantically_
equal(a, b) := semantic_projection(a) == semantic_projection(b)`. It operates only on **structurally
valid** documents (invalid input is rejected explicitly). It **removes** presentation-only fields
(`ui`), **preserves** all executable content (`type_id`, `type_version`, `params`, node identities,
`edges`, `schedule`, `execution_policy`, `component_refs`, `ref`, and `extensions`), and
**canonicalizes declared-non-semantic ordering** (`nodes` by id, `edges` by endpoints,
`component_refs` by id, object keys sorted). It makes **no** claim of graph isomorphism or algebraic
equivalence — it is a documented field projection plus canonical ordering. (Full spec:
`docs/plans/M1_IMPLEMENTATION_PLAN.md` §5.)

### Failing loud — and at the right layer

The structural/semantic split is **normative** and unambiguous (see also §4):

- **Structural** errors (M1, **no registry, no node-type knowledge**): malformed schema; bad endpoint
  field shape; **source/target node ids must exist** (dangling node references); identifier
  uniqueness; prohibited **self-edges**; structural **cycle** rules; `component_ref` /
  `component_refs` **shape**. These are hard load errors. **M1 does NOT check whether a named port
  exists on a node type** — it has no node-type knowledge.
- **Semantic** errors (M2, registry-dependent): **node type exists**; **input/output port names
  exist** on the type; **required ports are connected**; **port types are compatible**; parameter
  schemas are valid; node-specific invariants. These are hard validation errors.
- An unsupported `schema_version` is a hard, explicit load error. Migration is explicit (§8), never
  silent best-effort parsing.

---

## 2. Type system (the port type lattice)

The type system distinguishes **structural shape** from **financial-domain meaning**. It is
deliberately small in v0 — a rigorous extensible contract, not a complete type theory.

### Executable types (v0)

| Type | Shape | Meaning |
|---|---|---|
| `Scalar[Number]` | single float | a single numeric value |
| `Scalar[Integer]` | single int | a single integer (e.g. N, lookback, window) |
| `Scalar[Boolean]` | single bool | a single condition result |
| `AssetSet` | **ordered** set of asset ids | which assets are "in play" (canonical order — see below) |
| `CrossSection[Number]` | one number per asset @ eval instant | e.g. trailing return per asset |
| `CrossSection[Boolean]` | one bool per asset @ eval instant | a mask (≡ "BooleanMask") |
| `TimeSeries[Number]` | per-asset history of numbers | e.g. price history, MA history |
| `PortfolioTargets` | asset → target weight | desired allocation; weights finite, ≥ 0; `Σw ≤ 1`; cash = `1 − Σw` |
| `OrderList` | list of proposed orders | **engine-produced only**; never a user-graph value and **not a constructible exposed-port type** (§3, §6) |

`BooleanMask` is **conceptually** `CrossSection[Boolean]` — one canonical type, not two.

### Compatibility rules
- **Exact match by default**: output `T` connects to input `T`.
- **Explicit widening only**, initially just `Scalar[Integer] → Scalar[Number]`.
- **No implicit meaning changes** — these are rejected and require an explicit transformation node:
  `TimeSeries[*] → CrossSection[*]` (collapsing history is deliberate); `CrossSection[Boolean] →
  AssetSet` (a mask is not a universe); `CrossSection[*] → PortfolioTargets` (weighting is
  deliberate); `PortfolioTargets → Scalar/CrossSection` (a portfolio is not generic numbers).

### Machine-readable representation & the one compatibility function
A port type is a small tagged structure, e.g. `{ "kind": "CrossSection", "dtype": "Number" }`,
`{ "kind": "Scalar", "dtype": "Integer" }`, `{ "kind": "PortfolioTargets" }`. A **single central**
`is_compatible(output_type, input_type) -> Result` is the **only** place edge compatibility is
decided; the graph validator and the editor's connection feedback both call it (the editor via the
API/generated metadata). A documented, machine-checked **compatibility table** accompanies it and is
covered by tests. Incompatible edges yield `{ edge, from_type, to_type, reason }`.

### Alignment rules (asset index & timestamps)
- **Canonical asset order:** `AssetSet`, `CrossSection`, and `TimeSeries` carry asset ids in a
  **canonical deterministic order** (ascending by ticker symbol in v0). Any operation whose result
  depends on order (ranking ties, top-N selection) uses this order, so results are reproducible.
- **Bound asset domain:** values flow over the **bound asset universe**. There is **no general
  intersection/zero-fill rule** — missing-value behavior is **node-specific** and is defined per node
  (see "Missing data and warm-up" below). Values are **never silently forward-filled** and never
  fabricated.
- **Timestamp alignment:** time-indexed values are aligned to the fixture/exchange **calendar**. A
  value at session D is visible only when its `data_available_at` ≤ the current evaluation instant
  (§6). No forward-fill across missing sessions without a node-documented rule.

### Missing data and warm-up (ratified founder default — M0 remediation)
There is **no single universal alignment rule**; missing-value behavior is **node-specific**, and the
two patterns must not be conflated:

**(a) Boolean comparison nodes** (e.g. `logic.greater_than`) — **preserve the full bound asset
domain**:
- The result `CrossSection[Boolean]` contains **every** asset in the bound universe.
- If **either operand is unavailable** for an asset (missing data or unmet warm-up), that asset's
  result is **`false`** — it is **not omitted** from the `BooleanMask`.
- The node **emits trace information** explaining the missing-data exclusion (which asset, which node,
  why).

**(b) Numerical scoring / ranking / selection nodes** (e.g. `transform.rank`, `portfolio.select_top_n`)
— **node-specific exclusion is allowed**:
- An asset lacking the required observations or per-asset warm-up is **excluded from that node's
  scored cross-section** for that evaluation (documented node behavior, not a universal rule).
- Downstream selection may therefore yield **fewer than the requested number** of assets (e.g.
  `select_top_n` returns all that qualify); this is allowed, not an error.
- Any allocation left unused as a result is **cash** (`1 − Σw`).
- The node **emits trace information** explaining each exclusion.

In all cases, exclusion is via the node's documented behavior — never via silent forward-fill,
fabrication, or an implicit cross-node intersection.

### Runtime value metadata
Runtime values are not bare arrays; each carries metadata so the engine can enforce temporal safety
and emit rich traces:

```jsonc
{
  "type": { "kind": "CrossSection", "dtype": "Number" },
  "as_of": "2026-05-29",                         // evaluation instant this value is valid for
  "data_available_at": "2026-05-29T21:00:00Z",   // when inputs became knowable
  "warmup_satisfied": true,
  "values": { "EFA": 0.041, "QQQ": 0.131, "SPY": 0.084, "…": "…" }   // canonical order
}
```

### Registering future types
New types register a `kind` (+ optional `dtype`s) and their compatibility-table entries **without
editing every validator** — the compatibility function is data-driven.

---

## 3. Nodes and the node contract

Every node **type** (not instance) declares a uniform contract enforced by the registry (M2):

```text
type_id              e.g. "transform.trailing_return"  (stable, namespaced)
name, description    human-readable
inputs[]             named, typed input ports
outputs[]            named, typed output ports
param_schema         typed parameters with defaults & validation
purity               "pure" | "stateful"      (all v0 nodes are pure)
supports_incremental bool                     (true required for forward mode)
warmup               declared warm-up length (sessions); may depend on params
validate(node)       structural/parameter validation hook
evaluate(ctx, ...)   evaluation behavior at one evaluation instant
trace_schema         the structured trace events this node emits, each conforming to the
                     minimal trace-event envelope (below)
```

A node **instance** in the IR carries:
`{ "id": "n2", "type_id": "transform.rank", "type_version": "1.0.0", "params": {...}, "ui"?: {...}, "extensions"?: {...} }`.

- **`type_id`** is an open **namespaced** string (never a closed enum) — an ordinary `type_id`
  matches a dotted pattern (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`, ≥1 dot, e.g. `transform.rank`),
  with `"component"` the one reserved non-dotted exception; bare/empty ids like `"rank"`/`""` are
  rejected. **`type_version`** (a `SemVer`) is **required** for ordinary registered nodes — a saved
  strategy never resolves an unspecified version to "latest". `type_id` + `type_version` together pin the **node-contract version** (version axis 3,
  §8) the strategy was authored against; M1 checks their presence/shape, M2 resolves them.
- The **reserved `component` node** (`type_id: "component"`) uses a *different* mechanism: it carries
  `ref` (to a `component_refs` entry) and **no** `type_version`; its version is the pinned
  **`ComponentRef.version`** (the component-*definition* version, axis 4), which is **not** a
  node-contract version. Structural rule: `type_id == "component"` ⇒ `ref` required & `type_version`
  absent; otherwise ⇒ `type_version` required & `ref` absent.
- **`ui`** is explicitly presentation-only and **non-semantic** (removed by `semantic_projection`,
  §1). **`extensions`** is namespaced, preserved, and **semantic by default** (kept by projection;
  affects document identity). See the persisted-JSON policy in §1.

### Minimal trace-event envelope (defined at M2 so registered nodes can declare trace output)

So that a node type can declare its `trace_schema` as soon as it is registered (M2), there is a
**minimal trace-event envelope** available early. Every trace event a node emits conforms to it:

```jsonc
{
  "run_id": "uuid",
  "timestamp": "2026-05-29T21:00:00Z",   // a separately-modeled time (e.g. evaluation instant)
  "node_id": "rk",
  "component_path": ["c1"],               // ENCLOSING component-instance ids only ([] at strategy
                                          // top level); the emitting node itself is node_id, so a
                                          // node's full identity is (component_path, node_id)
  "event_type": "rank.tie_broken",        // node-declared event type
  "payload": { /* structured, node-specific */ }
}
```

Only this envelope (and per-node `event_type`s + payload shapes) is fixed early. **Detailed trace
construction, persistence, retrieval, visualization, and analysis remain in their later milestones**
(M6 construction, M7 persistence/retrieval, M11 visualization).

### Node taxonomy (v0 — the smallest set that authentically expresses Strategy A and B)

> We add a node type only when a concrete strategy needs it, or when it is a genuinely foundational
> language primitive. Order generation, backtest results, and trace assembly are **engine**
> responsibilities, **not** graph nodes.

**Inputs**
- `universe.fixed_list` → `AssetSet` (params: `tickers[]`; emitted in canonical order)
- `data.price` (`AssetSet → TimeSeries[Number]`) — **requires an `AssetSet` input** that binds which
  assets to load; emits per-asset close history available as of the evaluation instant.

**Transformations**
- `transform.trailing_return` (`TimeSeries[Number] → CrossSection[Number]`, params:
  `lookback_sessions`; warm-up = `lookback_sessions`; assets without enough history are excluded)
- `transform.moving_average` (`TimeSeries[Number] → TimeSeries[Number]`, params: `window`; warm-up =
  `window`)
- `transform.latest` (`TimeSeries[Number] → CrossSection[Number]`; explicit history→current collapse)
- `transform.rank` (`CrossSection[Number] → CrossSection[Number]`, params: `descending` (default
  true); **tie-break (ratified founder default — M0 remediation):** after score comparison, equal
  scores are ordered by **ascending canonical ticker**, deterministically; excluded assets are not
  ranked)

**Logic**
- `logic.greater_than` (`CrossSection[Number] × CrossSection[Number] → CrossSection[Boolean]`, or a
  `Scalar` right operand). **Preserves the full bound asset domain:** the output mask contains every
  asset in the universe; if **either operand is unavailable** for an asset, that asset's result is
  **`false`** (not omitted), and the node emits a missing-data trace event. The general comparison
  primitive for v0.

**Portfolio construction**
- `portfolio.select_top_n` (`CrossSection[Number] (ranks/scores) × AssetSet → AssetSet`, params:
  `n`; selects the `n` best by rank, ties resolved by canonical order; if fewer than `n` qualify,
  selects all qualifying)
- `portfolio.equal_weight` (`AssetSet → PortfolioTargets`; each selected asset gets `1/|selected|`;
  **renormalizes across the selected set** — used by Strategy A)
- `portfolio.fixed_weight` (`AssetSet → PortfolioTargets`, params: `weight_per_asset` or `equal`
  meaning `1/|universe|`; assigns each asset in the **full universe** its fixed sleeve; **does not
  renormalize** — used by Strategy B)
- `portfolio.apply_mask` (`PortfolioTargets × CrossSection[Boolean] → PortfolioTargets`; **zeros**
  the weight of any asset whose mask is false; **does not renormalize** survivors; the zeroed weight
  becomes part of the cash remainder — used by Strategy B)

**Risk**
- `risk.max_weight` (`PortfolioTargets → PortfolioTargets`, params: `max`; caps each weight at `max`
  and **redistributes** excess — see redistribution rule below)

**Outputs (graph terminal)**
- `output.target_portfolio` (`PortfolioTargets` — the **only** graph terminal). The graph **must**
  terminate here. The engine, not the graph, turns targets into orders (§6).

### Cross-cutting numerical rules (defined once; asserted in tests)
- **Cash** is the **explicit remainder** `1 − Σ(asset_weights)`, within tolerance. There is exactly
  **one** owner of cash (the remainder); no node both allocates assets and separately allocates cash.
- **Weight tolerance:** absolute `1e-9`; a valid `PortfolioTargets` satisfies `Σw ≤ 1 + 1e-9` and
  every `w ≥ 0` and finite. *(Standing default; low-stakes, not separately ratified — adjust freely.)*
- **`risk.max_weight` redistribution (ratified founder default — M0 remediation):** iterative
  **deterministic waterfall** —
  1. **Cap** every asset exceeding `max` at `max`.
  2. **Redistribute** the excess **proportionally** across eligible **uncapped** assets (those still
     below `max`).
  3. **Repeat** until the cap constraint is satisfied for all assets.
  4. If **no eligible asset has remaining capacity**, leave the unresolved remainder in **cash**.
  5. **Never violate the cap** merely to force 100% investment.
  Deterministic; ties handled via canonical order.

---

## 4. Edges

```jsonc
{ "from": ["n2", "values"], "to": ["n3", "values"] }
```

An edge connects `(source_node_id, output_port) → (target_node_id, input_port)`. **M1 (structural)**
checks endpoint field shape, that **source and target node ids exist** (no dangling node
references), identifier uniqueness, no **self-edge**, and structural **cycle** rules — **M1 does NOT
check whether the named ports exist**, because it has no node-type knowledge. **M2 (semantic)** checks
that the named **ports exist** on each node type and that `is_compatible(output_type, input_type)`
holds. The graph (after component dependency resolution) must be a **DAG**.

---

## 5. Stateful-node model

**v0 has no user-facing stateful nodes.** Every shipped v0 node is **pure** (output is a deterministic
function of inputs at the evaluation instant). The stateful contract is specified now only so the
model is honest and extensible — not because v0 ships stateful nodes.

A future stateful node must: declare `purity:"stateful"` and `supports_incremental:true`; keep state
**serializable/checkpointable** so forward replay resumes deterministically; update its state in
deterministic topological order; and **declare its own update cadence**. There is **no universal
cadence** for all future stateful nodes — each declares one, e.g.:

- `every_session` — state updates on **every** valid market session, independent of the evaluation
  schedule.
- `evaluation_only` — state updates **only** when the strategy evaluation schedule fires.

Warm-up gates downstream consumers until satisfied.

**For the M8 backtest/forward state-consistency test**, use a **test-only** stateful accumulator /
counter node (defined in the test suite, not the product registry) rather than prematurely adding a
product stateful node. The test asserts identical state trajectories across historical and forward
replay given the same data-availability sequence.

---

## 6. Execution policy and the session-level temporal model

The execution policy is represented **explicitly** in the IR so additional policies can be added
later, but **v0 implements exactly one policy** and no alternatives:

```jsonc
"execution_policy": {
  "policy": "close_signal_next_session_open",
  "valuation": "session_close",
  "transaction_costs": { "model": "bps", "bps": 5.0 }
}
```

**The one v0 policy ("close-based signal, next valid session open"):**
- Evaluate close-based signals **after session D closes**.
- The graph produces `PortfolioTargets` after evaluation.
- The **engine** reconciles targets into an `OrderList`:
  `current portfolio + PortfolioTargets + execution policy → OrderList`.
- Orders are queued for the **next valid market session** — "D+1" means the **next valid exchange
  session**, not the next calendar day (weekends/holidays are skipped).
- Orders **fill at that session's open**, with transaction costs applied.

**Session-level event lifecycle** (the engine runs this per session; see `ARCHITECTURE.md §3`):
1. Advance to the next market session.
2. At session **open**, process orders due for that session.
3. Apply transaction costs; update cash and holdings.
4. At the **valuation instant** (session close, v0), mark the portfolio to close prices.
5. At the **evaluation instant** (after close, if the schedule fires): expose only data available as
   of that instant → evaluate the graph → produce `PortfolioTargets` → reconcile against current
   portfolio in the engine → queue resulting orders for the next permitted fill event.
6. Persist events, state, valuation, and structured traces.

**Separately modeled timestamps** (recorded in results and traces):
observation time · data-availability time · evaluation time · signal time · order-creation time ·
scheduled-fill time · actual-fill time · valuation time.

**Temporal safety claim (calibrated):** the engine **structurally constrains** each evaluation to
data whose availability time ≤ the evaluation instant, and this constraint is **tested** (per-node
and engine-level). This narrows a whole class of look-ahead errors; it does **not** make look-ahead
categorically impossible — incorrect availability timestamps, fixture errors, or node bugs can still
introduce it, which is exactly what the look-ahead tests target.

### Schedule semantics (v0 — explicit discriminated variants)

The schedule is a **discriminated union keyed by `kind`**, deliberately shaped so an **ambiguous
weekly or monthly schedule cannot be expressed** (no underspecified `frequency` + `anchor` combo). A
**valid market session** is determined by the run's configured **exchange calendar and timezone**.
The three v0 variants:

```jsonc
{ "kind": "daily" }     // evaluate at the CLOSE of EVERY valid market session
{ "kind": "weekly" }    // evaluate at the CLOSE of the LAST valid market session in each
                        //   Monday–Sunday calendar week
{ "kind": "monthly" }   // evaluate at the CLOSE of the LAST valid market session in each
                        //   calendar month
```

- These are the **only** valid schedule values; any other shape is a structural error (M1).
- All evaluations are **close-based**; the orders they produce are eligible to **fill at the next
  valid market session's open** (per the one execution policy above).
- The **run record preserves the exchange calendar and timezone** actually used, so a run is
  reproducible and its session boundaries are unambiguous.

**Corporate actions are excluded from v0** (splits, dividends, symbol changes, mergers, delistings).
Fixtures contain none, and carry unambiguous open/close prices; no reliance on undocumented
adjusted-price behavior.

---

## 7. Component model (standalone, versioned, compositional)

A component is a **standalone immutable `ComponentDefinition` document**, referenced from strategies
by a **pinned `ComponentRef`**. Components are first-class compositional objects, never visual groups.

```jsonc
// ComponentDefinition (its own persisted document)
{
  "component_id": "uuid",             // stable identity
  "version": "1.0.0",                 // immutable once published
  "schema_version": "0.1.0",          // IR schema version this definition targets
  "name": "Momentum Selector", "description": "…",
  "component_refs": [                 // pinned dependency collection (same purpose as a strategy's)
    { "id": "d1", "component_id": "uuid-of-dep", "version": "2.1.0" }   // ref_id, component_id, version
  ],
  "implementation": {                 // v0 ships ONLY "graph"; other kinds are future schema additions
    "kind": "graph",
    "graph": {
      "nodes": [
        /* internal nodes; a component-instance node refers to a dependency by ref id: */
        { "id": "intDep", "type_id": "component", "ref": "d1", "params": { /* exposed params */ } }
      ],
      "edges": [ /* internal */ ]
    }
  },
  "exposed_inputs":  [ { "name": "prices",    "type": { "kind": "TimeSeries", "dtype": "Number" },
                         "maps_to": ["intPriceNode", "series"] } ],     // exposed→internal port map
  "exposed_outputs": [ { "name": "selection", "type": { "kind": "AssetSet" },
                         "maps_to": ["intSelectNode", "assets"] } ],
  "exposed_params":  [ { "name": "n",  "binds_to": ["intSelectNode", "n"],
                         "schema": { "type": "integer", "default": 3 } } ],  // binding semantics
  "provenance": { "owner": "uuid", "creator": "uuid", "forked_from": null }
}
```

A `ComponentDefinition`'s **implementation** is held behind an explicit discriminator
(`implementation.kind`). **v0 ships only `kind: "graph"`**; additional kinds (`formula`, `builtin`,
`sandboxed`, `model`, `external`) are **future schema additions, not implemented in v0/M1** — the
seam exists so the consuming strategy depends only on the exposed ports/params + pinned identity,
never on the implementation mode.

A `ComponentDefinition` carries its **own pinned `component_refs` dependency collection**, equivalent
in purpose to the one a strategy carries. Each reference contains a **stable reference id**, a
**component id**, and an **immutable component version**. A **component-instance node inside the
component's internal graph** (`type_id: "component"`) must point at one of these reference ids via its
`ref` field — it never names a `(component_id, version)` directly.

```jsonc
// ComponentRef (inside a strategy's OR a definition's component_refs[]) — pins a specific version
{ "id": "c1", "component_id": "uuid", "version": "1.0.0" }
```

```jsonc
// A component-instance node in a strategy graph points at a strategy-level ref id and may override
// exposed params:
{ "id": "cInst", "type_id": "component", "ref": "c1", "params": { "n": 3 }, "ui": { "collapsed": true } }
```

A component-instance node's exposed ports participate in edges like any node's ports.

**Structural dependency rules (M1 — these need no registry/node knowledge):**
- **Missing dependency reference:** a component-instance node whose `ref` does not match any `id` in
  the enclosing graph's `component_refs` is a clear hard error.
- **Duplicate reference ids:** two `component_refs` entries (in a strategy or a definition) sharing an
  `id` is a clear hard error.
- **Pinned-version requirement:** every `component_refs` entry **must** carry an explicit immutable
  `version`; an unpinned/floating reference is a structural error.
- **Direct recursion:** a `ComponentDefinition` whose `component_refs` includes its own
  `component_id` is rejected — detectable from that **single definition alone**.
- **Transitive recursion:** **no dependency chain may contain a cycle** — the graph of
  `ComponentDefinition → component_refs → ComponentDefinition` must be acyclic. M1 detects transitive
  cycles only over a **caller-supplied set** of definitions, via a bounded structural operation
  `validate_component_set(definitions)` (no fetching, no node catalog). References to a
  `(component_id, version)` **outside the supplied set** are reported as **unresolved** — their
  cycle status is deferred to component **resolution** in M2/M3, not claimed by M1. (Spec:
  `docs/plans/M1_IMPLEMENTATION_PLAN.md` §5.)
- **Resolution failure (M2/M3, not M1):** *fetching* a referenced `(component_id, version)` from a
  store and confirming its availability is component **resolution** — out of M1's scope. M1 validates
  the **shape** and the **supplied-set** dependency graph only.

**Resolution & runtime semantics (M3):**
- **Parameter binding:** each `exposed_param` binds to a specific internal `(node, param)`; an
  instance's `params` value overrides that internal default. Unbound/unknown params are errors.
- **Port mapping:** each exposed input/output maps to exactly one internal port of a compatible type.
- **Dependency resolution:** resolving a strategy resolves all transitively referenced component
  versions; the set of pinned versions is deterministic.
- **Compositional evaluation:** the engine evaluates the internal graph as a real sub-graph wired
  through exposed ports. It **never flattens** components into anonymous parent nodes and uses **no
  stub/temporary expansion**.
- **Hierarchical trace paths:** trace events carry the enclosing component-instance path plus the
  emitting node id (e.g. `component_path ["c1"]` + `node_id "intSelectNode"`) so the
  user inspects internal nodes while knowing the owning component.
- **Migration behavior:** a `ComponentDefinition` targets a `schema_version`; loading one outside the
  engine's supported range is an explicit error with a named migration path — never silent.

> A component may reference another component (a real dependency tree), but **no dependency chain may
> contain a cycle**. Complete definitions are **not** embedded as the primary storage model — a
> strategy/definition stores pinned refs; a future **export bundle** may package resolved definitions
> for portability.

v0 components are **private, acyclic, immutable-by-version, and version-pinned**. A future **export
bundle** may embed all pinned dependencies for portability, but embedded definitions are **not** the
primary persisted model — standalone documents + pinned refs are. Marketplace/discovery/payments/
ratings/remote execution/automatic upgrades are deferred (see `ARCHITECTURE.md §7`).

---

## 8. Versioning

**Four** version axes — distinct, never collapsed into one ambiguous field:
1. **`schema_version`** — IR *format* (`MAJOR.MINOR.PATCH`). The engine declares a supported range;
   out-of-range documents fail loudly. Migrations are explicit, named, and tested.
2. **`strategy.version`** — monotonic integer per strategy `id`, incremented per saved revision.
   `(id, version)` is immutable history; `forked_from` records lineage.
3. **node `type_version`** — the **node-contract version** a node instance was authored against
   (`SemVer`, §3). Required on ordinary nodes and explicitly pinned; never resolved to "latest". This
   is a property of the persisted node instance, resolved by the registry in M2.
4. **`ComponentDefinition.version`** (pinned by `ComponentRef.version`) — immutable per `component_id`;
   consumers pin a specific version, so publishing new behavior never disturbs existing consumers.
   This is the component-*definition* version and is **not** the same as a node `type_version`.

---

## 9. Worked examples (complete typed graphs)

Port types annotate each edge. Both strategies terminate in `output.target_portfolio`. The engine —
not the graph — produces orders.

### Strategy A — ETF momentum rotation

```jsonc
{
  "schema_version": "0.1.0",
  "strategy": { "id": "…", "version": 1, "name": "ETF Momentum Rotation", "provenance": { "…": "…" } },
  "execution_policy": { "policy": "close_signal_next_session_open", "valuation": "session_close",
                        "transaction_costs": { "model": "bps", "bps": 5.0 } },
  "schedule": { "kind": "monthly" },     // close of the last valid session each calendar month
  // every ordinary node carries type_id + type_version (versions illustrative)
  "nodes": [
    { "id": "u",   "type_id": "universe.fixed_list",       "type_version": "1.0.0", "params": { "tickers": ["EFA","GLD","IWM","QQQ","SPY","TLT"] } },
    { "id": "px",  "type_id": "data.price",                "type_version": "1.0.0", "params": {} },
    { "id": "ret", "type_id": "transform.trailing_return", "type_version": "1.0.0", "params": { "lookback_sessions": 126 } },
    { "id": "rk",  "type_id": "transform.rank",            "type_version": "1.0.0", "params": { "descending": true } },
    { "id": "sel", "type_id": "portfolio.select_top_n",    "type_version": "1.0.0", "params": { "n": 3 } },
    { "id": "ew",  "type_id": "portfolio.equal_weight",    "type_version": "1.0.0", "params": {} },
    { "id": "cap", "type_id": "risk.max_weight",           "type_version": "1.0.0", "params": { "max": 0.4 } },
    { "id": "tp",  "type_id": "output.target_portfolio",   "type_version": "1.0.0", "params": {} }
  ],
  "edges": [
    { "from": ["u","assets"],   "to": ["px","assets"] },   // AssetSet binds which prices to load
    { "from": ["px","series"],  "to": ["ret","series"] },  // TimeSeries[Number]
    { "from": ["ret","values"], "to": ["rk","values"] },   // CrossSection[Number]
    { "from": ["rk","values"],  "to": ["sel","scores"] },  // CrossSection[Number] (ranks)
    { "from": ["u","assets"],   "to": ["sel","universe"] },// AssetSet
    { "from": ["sel","assets"], "to": ["ew","assets"] },   // AssetSet (top 3)
    { "from": ["ew","targets"], "to": ["cap","targets"] }, // PortfolioTargets
    { "from": ["cap","targets"],"to": ["tp","targets"] }   // PortfolioTargets (terminal)
  ]
}
// Semantics: 6-ETF universe → 126-session trailing return → rank desc (ties: canonical ticker) →
// top 3 → equal weight (1/3 each, renormalized across the 3) → cap 0.4 (no overflow at 0.333) →
// target portfolio. Cash = 1 − Σw (≈ 0 here). Engine reconciles to orders, fills next session open.
```

### Strategy B — trend-filtered portfolio (fixed equal sleeves, no renormalization)

```jsonc
{
  "schema_version": "0.1.0",
  "strategy": { "id": "…", "version": 1, "name": "Trend-Filtered Portfolio", "provenance": { "…": "…" } },
  "execution_policy": { "policy": "close_signal_next_session_open", "valuation": "session_close",
                        "transaction_costs": { "model": "bps", "bps": 5.0 } },
  "schedule": { "kind": "weekly" },      // close of the last valid session each Monday–Sunday week
  // every ordinary node carries type_id + type_version (versions illustrative)
  "nodes": [
    { "id": "u",    "type_id": "universe.fixed_list",       "type_version": "1.0.0", "params": { "tickers": ["AGG","EFA","SPY","VNQ"] } },
    { "id": "px",   "type_id": "data.price",                "type_version": "1.0.0", "params": {} },
    { "id": "ma",   "type_id": "transform.moving_average",  "type_version": "1.0.0", "params": { "window": 200 } },
    { "id": "maL",  "type_id": "transform.latest",          "type_version": "1.0.0", "params": {} },
    { "id": "pxL",  "type_id": "transform.latest",          "type_version": "1.0.0", "params": {} },
    { "id": "gt",   "type_id": "logic.greater_than",        "type_version": "1.0.0", "params": {} },
    { "id": "fw",   "type_id": "portfolio.fixed_weight",    "type_version": "1.0.0", "params": { "weight_per_asset": "equal" } },
    { "id": "mask", "type_id": "portfolio.apply_mask",      "type_version": "1.0.0", "params": {} },
    { "id": "tp",   "type_id": "output.target_portfolio",   "type_version": "1.0.0", "params": {} }
  ],
  "edges": [
    { "from": ["u","assets"],   "to": ["px","assets"] },   // AssetSet
    { "from": ["px","series"],  "to": ["ma","series"] },   // TimeSeries[Number]
    { "from": ["ma","series"],  "to": ["maL","series"] },  // TimeSeries[Number] (MA)
    { "from": ["px","series"],  "to": ["pxL","series"] },  // TimeSeries[Number] (price)
    { "from": ["pxL","values"], "to": ["gt","left"] },     // CrossSection[Number] (latest price)
    { "from": ["maL","values"], "to": ["gt","right"] },    // CrossSection[Number] (latest MA)
    { "from": ["u","assets"],   "to": ["fw","assets"] },   // AssetSet (full universe)
    { "from": ["fw","targets"], "to": ["mask","targets"] },// PortfolioTargets (0.25 each)
    { "from": ["gt","values"],  "to": ["mask","mask"] },   // CrossSection[Boolean] (price > MA)
    { "from": ["mask","targets"],"to": ["tp","targets"] }  // PortfolioTargets (terminal)
  ]
}
// Semantics: 4-asset universe, each a fixed 0.25 sleeve. price > 200-session MA → keep the 0.25
// sleeve; otherwise → 0. Survivors are NOT renormalized. Cash = 1 − Σ(surviving sleeves) (e.g. 2 of
// 4 pass → 0.50 invested, 0.50 cash). Engine reconciles to orders, fills next valid session open.
```

Both strategies use **only** general-purpose nodes. The engine contains **no** code that recognizes
"momentum" or "trend" — meaning lives entirely in the composed graph.

---

## 10. Future extension points (paths, not promises)

Shaped so these are *additive*, not rewrites: mathematical **expression nodes**; **sandboxed Python**
components (same port/trace contract + a sandbox boundary; security/ops deferred); **stateful
statistical/ML** models via the stateful contract + checkpointable state; **optimizers** producing
`PortfolioTargets` (may register a `Matrix` type via the registry); **custom datasets / external APIs
/ event-driven data** behind the MarketData adapter and the availability-time discipline; **broker
adapters / venues** behind the Broker/Fills adapter; **sealed components / licensing / publishing**
layered on existing provenance, visibility, and version-pinning. None are implemented now; adding
them does not require breaking the IR, the engine, or the type system.
