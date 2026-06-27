# M1.1 Codex Review — IR implementation

**Review type:** Independent read-only implementation review  
**Scope:** Complete Quantize M1.1 IR implementation, fixtures, tests, M0 docs, ADRs, `AGENTS.md`, `CLAUDE.md`, and `docs/plans/M1_IMPLEMENTATION_PLAN.md`  
**Decision:** APPROVE AFTER NAMED CORRECTIONS  

Codex did not edit implementation files, install packages, generate artifacts, commit, or begin M1.2 during this review.

## Local checks run

- `python -m pytest` → `54 passed`
- `python -m ruff check .` → passed
- `python -m mypy quantize tests` → passed
- Python: `3.14.0`
- Node: `v25.2.1` locally; no Node/codegen step was run

## BLOCKER

### 1. Required persisted IR fields are silently defaulted when omitted

**File/symbol**

- `quantize/schema/document.py::StrategyDocument`
- `quantize/schema/nodes.py::NodeInstance`
- `quantize/schema/components.py::ComponentDefinition`

**Evidence**

- `StrategyDocument.nodes`, `edges`, and `component_refs` default to `[]`.
- `NodeInstance.params` defaults to `{}`.
- `ComponentDefinition.component_refs`, `exposed_inputs`, `exposed_outputs`, and `exposed_params` default to `[]`.
- Observed behavior during review:

```text
StrategyDocument accepts missing component_refs -> []
StrategyDocument accepts missing nodes -> []
StrategyDocument JSON Schema required fields:
['schema_version', 'strategy', 'execution_policy', 'schedule']
```

**Consequence**

Malformed persisted documents can be accepted and normalized into different documents. M1.2 structural validation may not be able to detect the omission after Pydantic has already filled defaults.

**Smallest correction**

Make persisted contract fields required when the IR contract says they exist, even if empty. Require explicit `nodes`, `edges`, `component_refs`, `params`, and component exposed/dependency collections unless the docs intentionally make them optional.

**Deadline**

Before M1.2.

### 2. Serialization does not reject non-portable JSON; it can silently rewrite invalid values

**File/symbol**

- `quantize/schema/primitives.py::JsonObject`
- `quantize/schema/primitives.py::_check_portable_json`
- models using `JsonObject`

**Evidence**

`JsonObject` is `dict[str, Any]` with an `AfterValidator`, which validates on parse but not reliably on serialization. Models are mutable and do not use assignment validation or frozen configs.

Observed behavior during review:

```text
TypeAdapter(JsonObject).dump_json({"x": float("nan")}) -> b'{"x":null}'
TypeAdapter(JsonObject).dump_json({"x": float("inf")}) -> b'{"x":null}'
NodeInstance params mutated to inf -> "params":{"bad":null}
unsafe integer 2**53 serialized as 9007199254740992
```

**Consequence**

This violates the plan’s “NaN / +Inf / -Inf rejected on parse AND serialize” rule and can silently convert invalid financial/config data to `null`.

**Smallest correction**

Add serialization-time validation for `JsonObject` / `JsonValue` and prevent or validate post-parse mutation. A good fix is a schema type/serializer that recursively revalidates before dump, plus tests that invalid mutated or constructed models fail serialization instead of emitting `null` or unsafe integers.

**Deadline**

Before M1.2.

### 3. Boolean values are accepted for integer-only version fields

**File/symbol**

- `quantize/schema/provenance.py::ForkRef.version`
- `quantize/schema/document.py::StrategyMeta.version`
- `quantize/schema/document.py::TransactionCosts.bps`

**Evidence**

Observed behavior during review:

```text
strategy.version=True -> accepted as 1
ForkRef.version=True -> accepted as 1
TransactionCosts.bps=True -> accepted as 1.0
```

**Consequence**

Persisted JSON can use `true` where an integer or numeric value is required, and Pydantic silently coerces it. That violates strict portable JSON semantics for governed fields.

**Smallest correction**

Use strict numeric field types, e.g. strict positive int for versions and strict finite numeric validation for bps. Add tests for `true` rejected in integer/numeric governed fields.

**Deadline**

Before M1.2.

## HIGH

### 4. Emitted JSON Schema loses key runtime constraints

**File/symbol**

- `quantize/schema/primitives.py::TypeId`
- `quantize/schema/primitives.py::EntityId`
- `quantize/schema/primitives.py::JsonObject`
- `quantize/schema/nodes.py::NodeInstance`

**Evidence**

- `TypeId` uses `AfterValidator`; emitted schema is only `{ "type": "string" }`.
- `EntityId` uses `AfterValidator`; emitted schema is only `{ "type": "string" }`.
- `JsonObject` emits:

```json
{ "type": "object", "additionalProperties": true }
```

- `NodeInstance.type_version` is field-optional, with the ordinary-node requirement enforced only by a model validator. Emitted schema requires only `id` and `type_id`.

**Consequence**

The future published JSON Schema and generated TypeScript types will accept documents that Pydantic rejects: bare `type_id`, missing ordinary-node `type_version`, invalid UUID strings, and arbitrary non-recursive/unsafe JSON objects.

**Smallest correction**

Make constraints schema-visible. For example:

- `TypeId` should emit the namespaced-or-`component` pattern.
- `EntityId` should emit UUID format/pattern.
- `JsonValue` should be a real recursive schema, not `Any`.
- `NodeInstance` should emit the ordinary-node vs component-node conditional requirement, possibly as a two-variant structural union that remains generic and not a closed union of built-in node types.

**Deadline**

Before M1.3; preferably before M1.2 if M1.2 will depend on published-schema behavior.

### 5. Component fork ancestry uses the strategy-version shape

**File/symbol**

- `quantize/schema/provenance.py::ForkRef`
- `quantize/schema/provenance.py::Provenance`
- `quantize/schema/components.py::ComponentDefinition.provenance`

**Evidence**

- `ForkRef.version` is an integer.
- `Provenance.forked_from` uses that `ForkRef`.
- `ComponentDefinition.provenance` reuses `Provenance`.
- `ComponentDefinition.version` is `SemVer`.

**Consequence**

A component cannot accurately record fork ancestry from another component version such as `1.0.0`. This muddies the strategy-version and component-version axes.

**Smallest correction**

Split strategy and component fork refs/provenance, or use a discriminated fork reference with the correct version type per entity kind.

**Deadline**

Before M1.2, because this is persisted contract shape.

## MEDIUM

### 6. Default serialization can emit non-canonical IR aliases

**File/symbol**

- `quantize/schema/nodes.py::Edge.from_`

**Evidence**

`Edge.from_` aliases to `"from"`. Tests correctly use `model_dump(..., by_alias=True)`, but direct `StrategyDocument.model_dump_json()` emits edges with `"from_"`, not `"from"`.

**Consequence**

The obvious Pydantic serialization path can produce non-contract JSON unless every caller remembers `by_alias=True`.

**Smallest correction**

Either configure serialization by alias globally where supported, or expose a canonical `to_ir_json` / `to_ir_dict` helper and test that it emits `"from"`.

**Deadline**

Before M1.3; definitely before persistence/API work.

### 7. Validation tests mostly assert exception presence, not useful error behavior

**File/symbol**

- `tests/test_models.py`
- `tests/test_node_edge_models.py`
- `tests/test_schedule.py`

**Evidence**

Many tests use bare `pytest.raises(ValidationError)` without checking location, error type, or message.

**Consequence**

The tests prove rejection, but not clear error location/message. A regression to vague errors would still pass.

**Smallest correction**

For contract-critical failures, assert `ValidationError.errors()` location/type or use `match=` for messages.

**Deadline**

Before M1.2.

### 8. Nested component dependency shape is modeled but not exercised

**File/symbol**

- `quantize/schema/components.py::ComponentDefinition.component_refs`
- `quantize/schema/components.py::Graph`
- `quantize/schema/nodes.py::NodeInstance`
- `tests/test_models.py`

**Evidence**

The shape exists: `ComponentDefinition.component_refs`, internal `Graph`, and `NodeInstance` supporting `type_id:"component"` + `ref`. Current component tests validate an empty graph component, `OrderList` rejection, and non-graph kind rejection, but not a component with a pinned dependency and internal component node.

**Consequence**

The key nested-dependency seam is present but not protected by an M1.1 fixture/test.

**Smallest correction**

Add one component fixture/test with `component_refs=[...]` and an internal `type_id:"component"` node referencing that ref.

**Deadline**

Before M1.2.

## LOW

### 9. Semantic projection is implemented only for `StrategyDocument`

**File/symbol**

- `quantize/schema/semantics.py::semantic_projection`

**Evidence**

`semantic_projection` accepts `StrategyDocument`. Component definitions are also persisted documents, and their internal nodes may carry `ui`.

**Consequence**

Strategy semantic equality is covered, but component document semantic equality is not yet defined in code.

**Smallest correction**

Either document that M1.1 semantic projection is strategy-only, or add component projection that removes internal node `ui` while preserving component semantics.

**Deadline**

Later, but before component persistence/version comparison becomes real.

### 10. Local Node version is still outside the project engine range

**File/symbol**

- `package.json`
- local environment

**Evidence**

`package.json` requires `node >=24 <25`, but local `node --version` is `v25.2.1`.

**Consequence**

No M1.1 Node work was run, so this did not affect this review. It will matter before npm lockfiles or TypeScript generation.

**Smallest correction**

Switch to Node 24 before M1.3 codegen/lockfile work.

**Deadline**

Before M1.3.

## NON-ISSUE

- `NodeInstance` is generic, not a closed union of built-in node types.
- `type_id` is open and namespaced at Pydantic runtime.
- Unknown future node types are structurally accepted; covered by `tests/test_models.py`.
- Node-specific parameters are not encoded as closed core-schema variants; `params` remains generic.
- `OrderList` is not constructible as a graph/component port type.
- Schedule and port type unions are deliberately closed and discriminated.
- Graph implementation is behind the approved `implementation.kind == "graph"` discriminator.
- No plugin, sandbox, AI-generation, custom-code, or distributed-execution subsystem was implemented.
- Strategy A and B fixtures exercise different graph shapes: A is momentum/rank/select/cap; B is moving-average/latest/greater-than/fixed-weight/mask.
- `ui` changes do not affect semantic equality; `extensions` changes do.
- `pytest`, `ruff`, and `mypy` all pass.

## Verdicts

### Persisted-contract verdict

Not safe yet. The shape is mostly right, but silent defaults, bool coercion, and serialization-time non-portable JSON behavior must be fixed before M1.2 builds on these models.

### Pydantic-modeling verdict

Good direction, but too many critical constraints live only in runtime validators or Pydantic coercion defaults. The model needs stricter types, required persisted fields, and serialization-safe JSON handling.

### Future-extensibility verdict

Approved. The implementation keeps the node/block seam open and does not overbuild future plugin/sandbox/model systems.

### Test-quality verdict

Broad smoke coverage exists and all current checks pass, but the tests miss important contract failures: bool coercion, omitted required fields, serialization-time non-portable values, schema emission gaps, and nested component dependency fixtures.

### JSON-Schema/codegen-readiness verdict

Not ready. The emitted schema currently loses `TypeId`, `EntityId`, recursive `JsonValue`, and ordinary/component node conditional constraints. Tuple endpoints emit `prefixItems`, which may be acceptable, but must be verified in the M1.3 TypeScript codegen spike.

## Final decision

**APPROVE AFTER NAMED CORRECTIONS.**

Do not proceed to M1.2 until the BLOCKER items are corrected. No M0 decision needs to be reopened.
