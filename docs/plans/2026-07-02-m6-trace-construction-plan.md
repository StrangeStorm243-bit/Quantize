# M6 — Structured Trace Construction (2026-07-02)

Plan-of-record per `PLAN_TEMPLATE.md`. Implements MVP_PLAN §M6 and ARCHITECTURE §5 over the M2
`TraceEvent` envelope. **Core invariant: traces record facts observed and decisions actually made
by production execution — tracing never re-implements node, reconciliation, or fill logic.**

## Purpose & definition of done
- Every trace payload is an explicit, schema-versioned, immutable, JSON-portable contract —
  declared per event type beside the code that emits it (no central switch, no giant
  optional-field payload).
- The M2 envelope is UNCHANGED. The schema version lives INSIDE each payload as a required
  integer field `"v"` (additive; an envelope field would be a breaking M2 change, which is
  forbidden). Engine-level events reuse the envelope with `node_id="engine"` (a valid `NodeId`),
  `component_path=()` — additive convention, not an envelope change.
- Structured distinctions exist among: false conditions vs missing operands vs
  defaulted-to-false; scoring exclusions vs unranked vs unselected; zero weights; omitted orders
  (dust/hold) vs proposed orders vs scaled fills; failures vs no-op notes.
- Deterministic per-evaluation-instant trace TREES assembled in memory from the flat stream
  (identity = `(component_path, node_id)`; hierarchy = component-path prefixes; ordering =
  deterministic first-emission order).
- Tracing-enabled and tracing-disabled runs produce identical targets, orders, fills, ending
  state, diagnostics, and evaluation order (only `trace`/tree artifacts differ).
- Byte-stable, libm-free trace goldens (Strategy A first evaluation+fill, Strategy B first
  evaluation, componentized Strategy A) with focused independent assertions; every emitted event
  in the reference runs validates against its declared schema, and every emitted `event_type` is
  declared by its emitter.
- Full gate green. No persisted-IR/codegen change (descriptors are runtime infra, not IR); no
  M3–M5 financial behavior change; no M7 persistence/M8 replay/UI/NL explanations.

## Authoritative inputs
MVP_PLAN §M6 (payload list; separately-modeled timestamps; hierarchical component paths;
per-instant trees; "version trace events" risk mitigation); ARCHITECTURE §5 (facts list incl.
"engine's proposed orders" and "reasons an order did not fire"); STRATEGY_LANGUAGE §3 (envelope +
per-node `trace_schema` declared at M2 "used at M6"); the M3 recorder/envelope and existing node
events; the M4/M5 run-record explanation surfaces (`AssetPlan` rows, `Fill.scaled`, notes) which
are exactly the production facts engine events serialize.

## Contracts & invariants

### Trace event specs (`quantize/tracing/spec.py`)
`TraceEventSpec` (frozen): `{event_type: str, version: int, payload_schema: JsonSchemaSpec}`.
Every payload schema requires `"v": {const: version}` plus its typed fields,
`additionalProperties: false`. Specs are declared IN the module that emits them (node modules,
engine) — self-contained registration, aggregated only through the descriptor/catalog like
everything else.

### Descriptor surface (additive)
`NodeDescriptor` gains `trace_events: tuple[TraceEventSpec, ...] = ()` (runtime infra — not
persisted IR, no codegen impact). The existing M2 `trace_schema` field is now populated as the
derived `oneOf` of the node's payload schemas via a helper `combined_trace_schema(specs)` —
honoring the M2 docstring ("used at M6") without changing the field's type. Nodes with no events
keep both empty/None.

### Node event inventory (existing events gain `v: 1`; new events marked ★)
Bounded by construction: payloads carry asset lists/pairs over the bound universe (≤ |universe|
entries), counts, and dates — never series/histories.
- `universe.fixed_list`: ★`universe.selected` {v, assets}.
- `data.price`: `data.missing_asset` {v, asset}; ★`data.observed` {v, per_asset:
  [{asset, observations, first, last}…]} — OBJECT rows (counts + ISO endpoint dates, never
  the series).
- `transform.trailing_return`/`moving_average`/`latest`: `transform.excluded`
  {v, asset, reason} (unchanged reasons); ★`transform.computed` {v, computed: [assets]} — an
  OUTPUTS-PRODUCED event (the present set of the output). "Inputs observed" is satisfied
  honestly by `data.observed` at the data layer plus transitivity: every intermediate node's
  input is an upstream node's traced output.
- `transform.rank`: `rank.tie_broken` {v, assets, score}; ★`rank.assigned`
  {v, descending, ranking: [[asset, rank]…]}.
- `logic.greater_than`: `logic.missing_operand` {v, asset, missing}; ★`logic.evaluated`
  {v, passed, failed, defaulted_missing} — the three-way condition distinction.
- `portfolio.select_top_n`: `select.excluded` {v, asset, reason} (unranked);
  ★`select.selected` {v, n, selected, unselected} (ranked-but-below-cutoff ≠ unranked).
- `portfolio.equal_weight`/`fixed_weight`: `portfolio.empty_selection|empty_universe` {v};
  ★`portfolio.weighted` {v, weights: [[asset, w]…], cash}.
- `portfolio.apply_mask`: `portfolio.masked_out` {v, asset, weight_zeroed, reason};
  ★`portfolio.mask_applied` {v, kept, zeroed}.
- `risk.max_weight`: `risk.cap_applied` {v, capped_assets, iterations, left_in_cash,
  ★adjusted: [[asset, before, after]…]} (additive field; `adjusted` lists EVERY asset whose
  weight changed — capped assets AND redistribution recipients — both available in-scope with
  no recomputation).
- `output.target_portfolio`: ★`targets.finalized` {v, weights: [[asset, w]…], cash}.

### Engine event inventory (`quantize/engine/trace.py` specs; emitted from `backtest.py` using
production outcome objects — never recomputed)
- ★`engine.orders_proposed` {v, session, portfolio_value, target_cash, projected_cash,
  orders: [[side, asset, quantity]…], omitted: [[asset, action, delta_quantity]…]} — `omitted`
  carries the dust/hold rows from `ReconciliationOutcome.plans`: the reasons an order did not
  fire at the planning layer.
- ★`engine.orders_filled` {v, session, fills: [[side, asset, quantity, price, cost, cash_delta,
  scaled]…]} — `scaled: true` is the reason an order did not FULLY fire at the fill layer.
- ★`engine.state_transition` {v, session, cash_before, cash_after, positions_before, positions_after}.
- ★`engine.note` {v, session, code, message} — mirrors `SessionNote` (no-op distinctions:
  warm-up gate, no next session, fill outside window).
Timestamps: evaluation-instant events stamp the evaluation instant; fill-instant events stamp the
actual fill instant — `TraceRecorder` gains an additive `emit_at(timestamp, …)`.

### Tracing switch
`run_backtest(..., collect_trace: bool = True)` and `evaluate_strategy(..., collect_trace=True)`.
Disabled ⇒ a null sink (nodes/engine still call it; events are dropped); everything else
byte-identical. Equivalence is a named test.

### Trace trees (`quantize/tracing/tree.py`)
`TraceTreeNode` (frozen): `{node_id, component_path, events: tuple[TraceEvent,…],
children: tuple[TraceTreeNode,…]}`; `TraceTree` (frozen): `{run_id, instant,
roots: tuple[TraceTreeNode,…]}`; `build_trace_trees(events) -> tuple[TraceTree,…]` groups the
flat stream by timestamp (ascending), nests by component-path prefix (an instance node is
materialized even if it emitted nothing), and orders siblings by first emission (deterministic
because emission order is). Pure function; no engine/evaluator change required for assembly.

### Validation & serialization
`quantize/tracing/validate.py`: `validate_trace(events, specs_by_type) -> diagnostics` — checks
every event's payload against its declared spec and flags undeclared event types. Test-time and
opt-in (no always-on runtime cost). Tree serializer in tests (`golden_utils` extension): canonical
JSON, sorted keys, `allow_nan=False`, LF (goldens dir already `.gitattributes`-pinned); all
payload numbers are IEEE `+ − × ÷` products of the cumulative-product fixture — no libm.

## Explicitly out of scope
M7 persistence/retrieval; M8 replay; UI rendering; natural-language explanations; new financial
semantics; envelope changes; payload i18n; runtime always-on validation; trace filtering/query
APIs.

## Unresolved decisions
None — the one judgment call flagged for plan review: schema-version placement (in-payload `v`)
and the `node_id="engine"` convention, both additive readings of fixed contracts.

## Implementation slices
- **M6.1** Plan + adversarial review.
- **M6.2** Core: `TraceEventSpec`, `combined_trace_schema`, descriptor `trace_events` field,
  `TraceRecorder.emit_at`, null recorder/switch plumbing, `validate_trace`.
- **M6.3** Node payloads: version existing events, add ★ events, declare specs per node module;
  update the M3/M4/M5 tests that assert exact event lists (intentional M6 evolution — financial
  assertions untouched).
- **M6.4** Engine events + `collect_trace` switches.
- **M6.5** Trees: builder + identity/hierarchy/nesting tests (componentized Strategy A gives the
  two-level case).
- **M6.6** Goldens (A first-eval+fill tree, B first-eval tree, componentized-A tree) +
  tracing-on/off equivalence + full-run validation sweep.
- **M6.7** Self-review, gate, learning log, report.

## Test blueprint
Spec: every declared schema is a valid Draft 2020-12 document; `v` const-pinned; combined oneOf
matches exactly one branch per valid payload. Nodes: per-node event assertions updated with
literal expected payloads (hand-derived); three-way condition distinction; unranked-vs-unselected;
dust/hold omission rows. Engine: proposed/omitted/filled/state-transition events with hand
numbers from the existing M4/M5 scenarios; note events. Trees: identity, sibling order, two-level
nesting, empty-instance materialization, per-instant grouping (fill instant separate from eval
instant), determinism across rebuilds. Equivalence: tracing on/off full-field comparison.
Validation sweep: A + B + componentized-A runs — zero undeclared/invalid events. Goldens:
byte-stable, focused assertions alongside. Gate: full.

## Adversarial plan-review amendments (both reviewers; no blockers)
1. **`engine.` event-type namespace is RESERVED for the engine.** `NodeId` cannot express an
   uncollidable sentinel, so identity alone cannot separate engine events from a user node
   literally named `engine`. Resolution, enforced at THREE layers: the node-facing trace sink
   (`TraceRecorder.sink_for`) refuses `engine.`-prefixed emissions outright, so even a node
   literally named `engine` cannot spoof engine events (the engine never emits through a
   node sink); `validate_trace` flags any surviving `engine.*` event whose identity is not
   exactly `node_id="engine"` at `component_path=()`; and the tree builder separates
   engine-origin events into their own root. Documented convention + enforced namespace,
   no M1 structural change.
2. `transform.computed` relabeled outputs-produced (see inventory).
3. `risk.cap_applied.adjusted` includes redistribution recipients (see inventory).
4. **`engine.note` timestamp = that session's `close_at`** — a non-evaluating firing session
   therefore yields a legitimate lone-note instant tree. Fill-instant trees likewise mean the
   builder produces per-INSTANT trees, a superset of MVP's "per-evaluation-instant" (eval and
   fill instants can never coincide: close vs open).
5. **Within-instant ordering contract:** engine events sort AFTER node events at the same
   instant (enforced by the tree builder's root ordering, not left to emission accident).
6. **Reverse coverage:** a suite-level assertion that the union of event types exercised across
   the test scenarios ⊇ every declared spec (declared-but-dead contracts fail loudly). Rare
   events (empty universe/selection, missing operand/asset, each note code) are exercised by
   targeted unit scenarios.
7. **Test-churn discipline (corrected characterization):** ~10 existing `events == []` sites and
   the payload-equality asserts in tests/test_nodes_*.py and test_reference_strategies_eval.py
   WILL change (always-on ★ events; payloads gain `v`). These are trace-explanation assertions —
   the exclusion reason literals (`missing_current_close` etc.) are preserved verbatim. Update
   discipline: every such site keeps an EXACT-SET assertion (`events == [...]`), never softened
   to membership — an empty-exclusions fact must stay falsifiable. Engine specs are aggregated
   from `quantize/engine/trace.py` as an explicit second source beside descriptor specs.
   On/off-equivalence and the validation sweep deliberately re-run full reference backtests with
   tracing on (bounded: tens of firings × ~a dozen small events).

## Stop conditions
The standing ones (envelope break, IR change, fact-not-computed-by-production, cross-platform
serialization impossibility). None anticipated.

## Verification
`./scripts/gate.ps1`; golden byte-stability; on/off equivalence; validation sweep output; diff
inspection. Stop before commit.
