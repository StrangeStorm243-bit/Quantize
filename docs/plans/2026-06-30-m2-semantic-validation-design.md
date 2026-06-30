# M2.2 Design — Semantic Validation (registry resolution + wiring by name)

**Status:** Approved (brainstorming) — 2026-06-30. Implementation plan to follow (writing-plans).
**Scope:** The second M2 slice. A registry-dependent semantic validator over an already-parsed,
structurally-valid `StrategyDocument`: it resolves registered nodes against the registry and checks
port wiring **by name**. **No `is_compatible`/port-type compatibility (M2.3), no parameter validation
(M2.4), no component resolution (M3), no structural re-validation.**

Normative context: `docs/MVP_PLAN.md` (M2 semantic checklist), `docs/STRATEGY_LANGUAGE.md`
(§2–4 ports/types), `CLAUDE.md`/`AGENTS.md` invariants 5 (one shared compatibility fn — *defined*
later), 7 (registry, not switches), 9 (fail loud at the right layer). Builds on M2.1
(`quantize/registry`) and M1.2 (`quantize/validation/structural.py`).

---

## 1. Objective and slicing

M2.1 built the registry and descriptors; the open `type_id` now *can* be resolved. M2.2 is the first
consumer: it gives a document **semantic** meaning by resolving each registered node and checking its
edges' port **names** against the resolved descriptors. It deliberately stops short of port-type
compatibility and parameters.

The M2 semantic checklist (`MVP_PLAN`) has seven items; M2.2 takes four:

| Checklist item | Slice |
|---|---|
| node-type exists | **M2.2** |
| node version available | **M2.2** |
| input/output port-name existence | **M2.2** |
| required ports connected | **M2.2** |
| port-type compatibility (`is_compatible`) | M2.3 |
| parameter validation | M2.4 (blocked on `parameter_schema`, deferred in M2.1) |
| node-specific validation | later |

---

## 2. Module layout & diagnostic model

```
quantize/validation/
  diagnostics.py    # NEW: shared deterministic ordering helper
  errors.py         # broadened: structural result types (M1.2) + semantic result types (M2.2)
  structural.py     # M1.2 — behavior-preserving refactor to use the shared helper
  semantic.py       # NEW: validate_strategy_semantics(document, registry_view)
```

### 2.1 Shared ordering helper (`diagnostics.py`)

Extract M1.2's `_error_sort_key`/`_sorted` into a shared, generic helper so structural and semantic
layers share **one** ordering policy (no drift):

```python
class HasLocCodeSubject(Protocol):
    loc: tuple[str | int, ...]
    code: str
    subject: str | None

def diagnostic_sort_key(d: HasLocCodeSubject) -> tuple[object, ...]: ...   # (loc, code, subject or "")
def sort_diagnostics[T: HasLocCodeSubject](items: Iterable[T]) -> tuple[T, ...]: ...
```

Ordering is preserved exactly: **`loc`, then `code`, then `subject or ""`** (with the same mixed
int/str `loc` handling as today).

`structural.py` change is a **small behavior-preserving refactor**, not "one line": import the shared
helper, delete its local `_error_sort_key`/`_sorted`, update call sites. The existing M1.2 tests are
the guardrail proving behavior is unchanged.

### 2.2 Semantic result types (additive to `errors.py`)

The `errors.py` module docstring broadens to "validation result types," with **Structural** and
**Semantic** sections. New types mirror `StructuralError`'s shape:

```python
@dataclass(frozen=True)
class SemanticDiagnostic:
    code: str
    message: str
    loc: tuple[str | int, ...]
    subject: str | None = None

@dataclass(frozen=True)
class SemanticValidation:
    ok: bool
    diagnostics: tuple[SemanticDiagnostic, ...] = ()
```

`diagnostics` (not `errors`) is deliberate: future semantic findings may be warnings/info. In **v0 all
diagnostics are hard errors**, so `ok = not diagnostics`.

Stable code constants live in `errors.py` (mirroring M1.2's `UNSUPPORTED_SCHEMA_VERSION` etc.):

```text
unknown_node_type
node_version_unavailable
unknown_output_port
unknown_input_port
required_input_unconnected
```

---

## 3. The validator (`semantic.py`)

```python
def validate_strategy_semantics(
    document: StrategyDocument, registry: NodeRegistryView
) -> SemanticValidation: ...
```

**Precondition:** operates on an **already-parsed, structurally-valid** `StrategyDocument`. It **must
not** rerun or duplicate M1 structural checks. It defensively avoids crashes on a structurally-invalid
document where easy (e.g. skips endpoints it can't resolve) but does **not** own or emit structural
diagnostics.

Pure, deterministic, registry-injected via the read-only `NodeRegistryView`. Accumulates all
diagnostics, sorts via `diagnostic_sort_key`, returns `SemanticValidation(ok=not diags, diagnostics)`.

### The four checks (in order)

**1. Registered-node resolution.** For each `RegisteredNode`, `registry.resolve(type_id, type_version)`:
- `UNKNOWN_TYPE` → `unknown_node_type`, `loc=("nodes", i)`, `subject=type_id`
- `VERSION_UNAVAILABLE` → `node_version_unavailable`, `loc=("nodes", i)`, `subject=type_id`
  (message lists available versions)
- `OK` → record `node_id → descriptor` in a resolved map (used by checks 2–3)

**2. Port-name existence on edges.** For each edge `(src_id, src_port) → (dst_id, dst_port)`:
- if `src_id` is in the resolved map and `src_port` ∉ descriptor **outputs** → `unknown_output_port`,
  `loc=("edges", i, "from")`, `subject=src_port`
- if `dst_id` is in the resolved map and `dst_port` ∉ descriptor **inputs** → `unknown_input_port`,
  `loc=("edges", i, "to")`, `subject=dst_port`
- an endpoint not in the resolved map (component node, or a node that failed resolution) is **skipped
  per endpoint** — the *opposite* endpoint, if it is a resolved registered node, is still checked.

**3. Required-input connectivity.** For each resolved node, each input with `required=True` must have
≥1 edge whose `to == (node_id, port_name)`. Any structurally-valid edge counts as satisfying
connectivity **even if its source failed resolution or is a component node** (no cascade; M2.3 decides
type-compatibility). Missing → `required_input_unconnected`, `loc=("nodes", i)`, `subject=port_name`.
Optional inputs unconnected → no diagnostic.

**4. Deterministic accumulation.** Sort and return.

### Deliberate deferrals / non-goals
- **`ComponentRefNode`s are not registry-resolved** — components aren't node-registry types; their
  port/type validation is **M3** component resolution. Per-endpoint skip only.
- **Port-type compatibility** (`is_compatible`) → **M2.3**. M2.2 checks a port exists by name, not
  that the two ends' types match.
- **Parameter validation** → **M2.4**.
- **Fan-in cardinality** (e.g. "≤1 edge into an input") is not in the checklist → out of scope.
- **No structural re-validation.**

---

## 4. Testing

### Fixtures (test-only — descriptor doubles, not real nodes)
- **Synthetic registry** (extend `tests/registry_fixtures.py`): existing `test.source`/`test.sink`,
  plus a **real `StrategyDocument`** (not an untyped dict) wiring `source.out → sink.in`, so the
  validator's "already-parsed document" precondition is genuinely exercised.
- **Reference-strategy registry** (in `tests/registry_fixtures.py`, clearly test-only doubles):
  descriptors for the node types used by **Strategy A and Strategy B**, with the exact **port names**
  from the committed fixtures and **plausible real port types from `STRATEGY_LANGUAGE.md`** (§2–4) —
  even though M2.2 doesn't check types — so the fixtures aren't lies and **M2.3 can reuse the same
  registry**. B specifically exercises `logic.greater_than`, `portfolio.fixed_weight`,
  `portfolio.apply_mask`.

### Tests (`tests/test_semantic_validation.py`)
- **Valid:** wired synthetic doc → `ok=True`, no diagnostics.
- **Per code:** unknown type → `unknown_node_type`; bad version → `node_version_unavailable` (message
  lists available); bad output port → `unknown_output_port`; bad input port → `unknown_input_port`;
  required input unconnected → `required_input_unconnected`.
- **Negative-space:** optional input unconnected → no diagnostic.
- **Edit-1 (component endpoint, per endpoint):** an edge from a `component` node into a resolved
  registered node still validates the registered endpoint's port; the component endpoint is skipped —
  not the whole edge.
- **Edit-2 (no cascade):** a required input connected by an edge whose **source is an unknown type** →
  no `required_input_unconnected` (connectivity satisfied), though the source still gets
  `unknown_node_type`.
- **Determinism:** a doc with several faults → diagnostics in stable `(loc, code, subject)` order.
- **Precondition (note + light test):** M2.2 need not behave meaningfully on structurally-invalid
  documents; it avoids crashes where easy, and tests must **not** imply it owns M1 structural errors.
- **Reference wiring:** `validate_strategy_semantics(strategy_a, reference_registry)` → `ok=True`; same
  for **Strategy B**. Proves both committed reference strategies' wirings resolve by registry name —
  the M2 must-work core, minus the type-compat that is M2.3.

---

## 5. Acceptance criteria (M2.2 done when)

- `diagnostics.py`: `HasLocCodeSubject` + `diagnostic_sort_key`/`sort_diagnostics`, preserving
  `(loc, code, subject or "")`.
- `structural.py`: refactored to use the shared helper; **all existing M1.2 tests still green**.
- `errors.py`: broadened docstring; `SemanticDiagnostic` + `SemanticValidation` + five code constants.
- `semantic.py`: `validate_strategy_semantics` with the four checks, registry-injected, deterministic,
  honoring the structural-validity precondition, per-endpoint component skip, no-cascade connectivity.
- Both reference strategies resolve cleanly under the reference registry; all unit tests pass.
- `pytest` · `ruff check .` · `ruff format --check .` · `mypy` all green.
- **No** `schema/`, `ts/`, codegen, dependency, or persisted-IR changes.

---

## 6. Explicit M2.2 exclusions

No `is_compatible` / port-type compatibility; no parameter validation; no component resolution; no
fan-in cardinality; no structural re-validation; no real node implementations; no codegen / `schema/`
/ `ts/` / dependency changes.
