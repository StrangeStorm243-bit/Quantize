# M2.1 Design — Node Registry & Descriptor Model

**Status:** Approved (brainstorming) — 2026-06-29. Implementation plan to follow (writing-plans).
**Scope:** The first slice of M2. Builds the node-type **registry** and the static **descriptor**
model that gives the open `type_id` (M1) its meaning. **No real nodes, no semantic validation, no
execution, no codegen/dependency changes.**

Normative context: `docs/MVP_PLAN.md` (M2), `docs/STRATEGY_LANGUAGE.md` (§3 node taxonomy),
`CLAUDE.md`/`AGENTS.md` invariants 7 (registry, not switches) and 9 (fail loud at the right layer).

---

## 1. Objective and slicing

M1 left `type_id` an **open, namespaced string** (the extensibility seam): a structurally valid
document may reference any well-formed `type_id`, and the meaning of that string is deferred to the
registry. M2.1 builds the registry + descriptor that supply that meaning, **without** yet validating
documents against it.

M2 as written in `MVP_PLAN` is one large milestone (registry + semantic validation + 12 core nodes +
trace envelope). Following M1's proven slicing, M2.1 is the **smallest coherent core**: the static
descriptor model + the registry mechanism + a synthetic fixture harness. Later slices add the
semantic validator (M2.2), the real nodes, and the executable/behavioral contract.

`NodeDescriptor` here is the **static, semantic/editor-facing descriptor subset** — *not* the full
executable node contract. Per `STRATEGY_LANGUAGE.md`, a node type's complete contract eventually
includes `parameter_schema`, node-specific validation hooks, `evaluate` behavior, `trace_schema`,
purity, warm-up, and cadence. M2.1 deliberately models **only the static descriptor** (identity +
ports + metadata).

### Why this is neither a source-of-truth nor a derived artifact

Descriptors are **runtime objects authored by node code** — they are never persisted into a strategy
document and never cross the language boundary. So they do **not** participate in the
Pydantic IR → JSON Schema → TypeScript codegen chain (which exists only to publish the persisted
`StrategyDocument`/`ComponentDefinition` contract). The registry is a **third category**: in-process
runtime infrastructure, neither source-of-truth-persisted nor generated. Consequently M2.1 changes
**no** `schema/`, **no** `ts/`, and the staleness gate is irrelevant to it. (If a descriptor field
ever needs to reach the editor, it is exposed later via the **M10 descriptor API as JSON DTOs**, not
via the IR codegen chain.)

---

## 2. Module layout

```
quantize/registry/
  __init__.py
  descriptor.py    # _FrozenGoverned base; InputPortSpec, OutputPortSpec, NodeMetadata, NodeDescriptor
  registry.py      # NodeRegistry (concrete) + NodeRegistryView (Protocol) + NodeResolution
  errors.py        # registry-infrastructure errors ONLY: RegistryError, DuplicateRegistrationError
```

Mirrors the `quantize/validation/` structure (a module + an `errors.py`).

---

## 3. The descriptor model (frozen Pydantic)

```python
class _FrozenGoverned(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

class InputPortSpec(_FrozenGoverned):
    name: PortName            # primitives.py identifier pattern
    port_type: PortType       # types.py lattice (OrderList not constructible)
    required: bool = True

class OutputPortSpec(_FrozenGoverned):
    name: PortName
    port_type: PortType       # no `required` on outputs

class NodeMetadata(_FrozenGoverned):
    display_name: str = Field(min_length=1)
    description: str = Field(min_length=1)

class NodeDescriptor(_FrozenGoverned):
    type_id: RegisteredTypeId               # namespaced; reserved "component" excluded by construction
    type_version: SemVer
    inputs: tuple[InputPortSpec, ...]
    outputs: tuple[OutputPortSpec, ...]
    metadata: NodeMetadata                  # required
    # parameter_schema: DEFERRED (see §3.3)
    # no implementation/execution binding (see §6)
```

### 3.1 Design decisions

- **Split input/output specs**, `port_type` (not `type`, to avoid shadowing the builtin), `required`
  on inputs only. M2 required-connectivity validation needs the input/optional distinction; baking it
  in now avoids redesigning the descriptor later.
- **`metadata` is required.** Node types declare a human-readable name/description; the M10 editor
  descriptor API needs it. Fixture descriptors supply a trivial `NodeMetadata`. (No temporary
  optionality is introduced in M2.1.)
- **Reuse M1 types:** `RegisteredTypeId`, `SemVer` (`primitives.py`) and the `PortType` discriminated
  union (`types.py`). `RegisteredTypeId` correctly excludes the reserved `"component"` node (which is
  an IR concept, not a registry entry); `PortType` correctly excludes engine-only `OrderList`.

### 3.2 Deep immutability

With `parameter_schema` deferred, the descriptor has **no mutable nested container**. `frozen=True`
blocks field reassignment; every field is a `str`, `bool`, `tuple` (immutable), or a frozen Pydantic
model (`InputPortSpec`/`OutputPortSpec`/`NodeMetadata`; `PortType` variants are already `frozen=True`).
The descriptor graph is therefore **deeply immutable with no defensive copying** — the shallow-freeze
hazard of a raw nested dict does not arise.

### 3.3 `parameter_schema` — deferred

Deferred to the dedicated parameter-validation slice. Rationale: the robust "validated, immutable
`ParameterSchema`" requires `jsonschema`, which is currently a **dev/test-only** dependency (imported
only in `tests/test_codegen_contract.py`; runtime deps = `pydantic` only). Using it in product runtime
code would promote it to a runtime dependency (+ lock regeneration) — a dependency change that
materially expands this slice and is out of scope. A raw mutable `dict`/`JsonObject` is explicitly
rejected (it reintroduces the shallow-freeze hazard).

**Future-proofing:** when `parameter_schema` is introduced it **must preserve the same governed,
deeply immutable guarantees** — validated, owned via defensive copy or a canonical immutable
representation, and must **not** reintroduce a mutable nested container.

### 3.4 Construction invariants (enforced at construction → fail loud)

Descriptor/port construction rejects:

- malformed `type_id` (must match `RegisteredTypeId`; `"component"`, bare `"rank"`, `""` rejected)
- malformed `type_version` (`SemVer` pattern)
- invalid `port_type` (must be a valid `PortType`; `OrderList` not constructible)
- **duplicate input names** (validator over `inputs`)
- **duplicate output names** (validator over `outputs`)
- unknown descriptor fields (`extra="forbid"`)
- missing `metadata`

An input and an output **may share a name** (not forbidden — no invariant requires it).

**Note:** descriptor construction failures are **ordinary Pydantic `ValidationError`s**, *not*
`RegistryError`s. `errors.py` is reserved for registry-infrastructure misuse only.

---

## 4. The registry mechanism & lookup API

### 4.1 Concrete registry (explicit, in-memory)

```python
class NodeRegistry:
    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str], NodeDescriptor] = {}

    def register(self, descriptor: NodeDescriptor) -> None:
        key = (descriptor.type_id, descriptor.type_version)
        if key in self._by_key:
            raise DuplicateRegistrationError(descriptor.type_id, descriptor.type_version)
        self._by_key[key] = descriptor

    def resolve(self, type_id: str, type_version: str) -> NodeResolution: ...
    def contains(self, type_id: str, type_version: str) -> bool: ...
    def available_versions(self, type_id: str) -> tuple[str, ...]: ...   # sorted SemVer strings
    def descriptors(self) -> tuple[NodeDescriptor, ...]: ...             # sorted by (type_id, type_version)
```

- **Explicit `register()`** — no decorators, no import-time global. A registry is constructed and
  populated; tests build a fresh one per case (the dependency-injection benefit). This is
  "self-registration" via an explicit call, satisfying invariant 7 without global mutable state.
- **Duplicate `(type_id, type_version)` → `DuplicateRegistrationError`** (raised — catalog-assembly
  bug, fail loud).
- **Exact-version semantics only.** `resolve` **never** resolves to latest, **never** applies ranges,
  **never** falls back. A pinned IR node matches its exact `(type_id, type_version)` or yields
  `VERSION_UNAVAILABLE`. (The IR pins `type_version`; there is no "latest"/range resolution in v0.)
- **Deterministic read APIs:** `available_versions` returns **sorted SemVer strings**; `descriptors()`
  returns descriptors **sorted by `(type_id, type_version)`**.

### 4.2 Non-throwing resolution result

Unknown type and unavailable version are **expected outcomes over user documents**, not exceptions —
so resolution is non-throwing and returns a typed result, enabling the future validator to accumulate
deterministic diagnostics (as M1.2 does with `StructuralError`).

```python
class ResolutionStatus(Enum):
    OK; UNKNOWN_TYPE; VERSION_UNAVAILABLE

@dataclass(frozen=True)
class NodeResolution:
    status: ResolutionStatus
    descriptor: NodeDescriptor | None
    available_versions: tuple[str, ...]
```

Invariants (enforced via classmethods / `__post_init__`):

- `OK` ⇒ `descriptor` present **and** `available_versions == ()`
- `UNKNOWN_TYPE` ⇒ `descriptor is None` **and** `available_versions == ()`
- `VERSION_UNAVAILABLE` ⇒ `descriptor is None` **and** `available_versions` is sorted/deterministic

A single `resolve(...)` call gives the validator everything it needs to emit a precise diagnostic
(*"type X unknown"* vs *"type X has no version 9.9.9; available: 1.0.0, 1.1.0"*) atomically.

### 4.3 Narrow injection Protocol

```python
class NodeRegistryView(Protocol):           # read-only surface consumers depend on
    def resolve(self, type_id: str, type_version: str) -> NodeResolution: ...
    def contains(self, type_id: str, type_version: str) -> bool: ...
```

Consumers (the future validator/evaluator) accept a `NodeRegistryView`, **not** the concrete
`NodeRegistry`. It **omits `register()`** — a consumer receives a read-only capability and
structurally cannot mutate the catalog while validating. This is capability separation /
least-privilege: it keeps semantic validation deterministic (same document + same view ⇒ same
diagnostics) and serves invariant 7. The concrete `NodeRegistry` satisfies the Protocol; tests can
inject it or a hand-rolled fake. (Domain aliases `RegisteredTypeId`/`SemVer` are used on the concrete
class where ergonomic; plain `str` is acceptable on the looser Protocol.)

---

## 5. Errors module & data flow

### 5.1 `errors.py` (infrastructure misuse only)

```python
class RegistryError(Exception): ...                  # base
class DuplicateRegistrationError(RegistryError):     # same (type_id, type_version) registered twice
    def __init__(self, type_id: str, type_version: str) -> None: ...
```

No `UnknownNodeType`/`VersionUnavailable` exceptions — those are non-throwing `NodeResolution`
outcomes. **Registration is a programming act → raise on misuse; resolution is a query over user data
→ return a result.** Descriptor construction errors are ordinary Pydantic `ValidationError`s.

### 5.2 Data flow (M2.1 boundary explicit)

```
1. node code authors NodeDescriptor(s)        ← frozen, validated at construction (fail loud)   [M2.1]
2. assembler calls registry.register(d) …     ← duplicate key → DuplicateRegistrationError       [M2.1]
3. registry injected as NodeRegistryView      ← read-only capability handed to consumers          [M2.1]
4. semantic validator: view.resolve(node…)    ← accumulate OK/UNKNOWN_TYPE/VERSION_UNAVAILABLE   [M2.2]
                                                 deterministically, like M1.2's StructuralError
```

**M2.1 provides:** descriptor construction, explicit registration, duplicate detection, and
non-throwing resolution machinery (steps 1–3 + `resolve`). **M2.2 consumes** `NodeRegistryView` to
produce semantic-validation diagnostics. **No semantic validator is implemented in M2.1.**

---

## 6. Implementation/execution binding — deferred (and not committed to the descriptor)

M2.1 omits any `implementation`/`implementation_ref` field. It does **not** commit to that binding
living on `NodeDescriptor` later: a separate `(type_id, type_version) → ExecutionBinding` mapping is
preserved as an option, keeping the **static semantic contract** apart from **executable bindings**
(Python evaluators, nested graphs, formulas, model artifacts, sandboxed code, external services).
M2.1 introduces **no** execution abstraction.

---

## 7. Testing

### 7.1 Synthetic fixture harness (no real nodes)

A test-only builder of made-up descriptors, e.g.:

- `test.source@1.0.0` — outputs `[out: CrossSection[Number]]`
- `test.source@1.1.0` — a second version (exercises version resolution + `available_versions`)
- `test.sink@1.0.0` — inputs `[in: CrossSection[Number] required, opt: Scalar[Number] optional]`

exposed as `build_fixture_registry() -> NodeRegistry`. Validation/registry logic is tested against
these doubles, not against real nodes.

### 7.2 Tests

- **Descriptor:** valid construct; duplicate **input** names rejected; duplicate **output** names
  rejected; input+output **sharing** a name allowed; malformed `type_id` (`"rank"`, `""`,
  `"component"`) rejected; malformed `SemVer` rejected; `extra` field rejected; **`metadata` required —
  omission fails**; `required` defaults `True` on inputs / absent on outputs; **frozen** (mutation
  raises).
- **Registry:** register+resolve `OK` (descriptor present, `available_versions == ()`); **duplicate
  registration raises `DuplicateRegistrationError`**; resolve unknown type → `UNKNOWN_TYPE` (None,
  `()`); resolve known type/missing version → `VERSION_UNAVAILABLE` (None, sorted, e.g.
  `("1.0.0","1.1.0")`); **exact-version** (`1.0.1` does *not* fall back to `1.0.0`); `contains()`;
  `descriptors()` sorted by `(type_id, type_version)`; the three `NodeResolution` invariants hold.
- **DI/Protocol:** a function annotated `(view: NodeRegistryView)` accepts the concrete `NodeRegistry`
  and a minimal fake. Note: **mypy verifies the structural compatibility** ("concrete registry
  satisfies `NodeRegistryView`") — that claim is primarily a type-check guarantee; runtime tests
  demonstrate behavior.

---

## 8. Acceptance criteria (M2.1 is done when)

- Frozen Pydantic descriptors (`InputPortSpec`, `OutputPortSpec`, `NodeMetadata`, `NodeDescriptor`)
  reuse `primitives` + `PortType`; all construction invariants enforced; deeply immutable.
- Explicit in-memory `NodeRegistry`: `register` (duplicate→raise), `resolve→NodeResolution` (3 statuses
  + invariants, exact-version), `contains`, `available_versions` (sorted), `descriptors()` (sorted by
  `(type_id, type_version)`).
- Narrow read-only `NodeRegistryView` Protocol; consumers depend on it (not the concrete class).
- `errors.py` = `RegistryError` + `DuplicateRegistrationError` only; descriptor construction failures
  are Pydantic `ValidationError`s.
- Synthetic fixture harness + tests covering all the above.
- `ruff check .` · `ruff format --check .` · `mypy` (strict) · `pytest` all green.
- **No** changes to `schema/`, `ts/`, codegen, dependencies, or persisted IR; staleness gate
  untouched.

---

## 9. Explicit M2.1 exclusions

No execution/implementation binding or `ExecutionBinding` mapping; no real nodes; no semantic strategy
validation; no parameter validation; no `parameter_schema`; no plugin/auto-discovery; no
codegen/`schema/`/`ts/` changes; no dependency changes (`jsonschema` stays dev-only); no trace-event
envelope (later in M2).
