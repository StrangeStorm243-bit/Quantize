# M2 Completion Design — Parameter Validation + Trace-Event Envelope

**Status:** Approved (brainstorming) — 2026-06-30. Implementation plan to follow (writing-plans).
**Scope:** Complete M2's **contract/validation surface**: (1) parameter validation (descriptor
`parameter_schema` + a fifth-area validator check) and (3) the minimal trace-event envelope. Item (2)
node-specific validation is **deferred** (see below). The **12 node implementations** are out of scope
(M3 phase — they need M3-PRE market data and are founder hand-implementation territory).

Normative context: `docs/MVP_PLAN.md` (M2), `docs/STRATEGY_LANGUAGE.md` (§1 node-specific rules; §3
descriptor + minimal trace-event envelope; §6 tracing). Builds on M2.1–M2.3
(`quantize/registry`, `quantize/validation/semantic.py`).

## Approved scope expansion: `jsonschema` becomes a runtime dependency

Parameter validation is **runtime semantic validation over user IR**, not a dev-only contract test, so
`jsonschema` must be installed by a normal `quantize` install. This slice:
- moves `jsonschema>=4.20` from `[project.optional-dependencies].dev` to `[project].dependencies`;
- regenerates `requirements.lock.txt`;
- updates the stale `pyproject.toml` mypy-override comment (it says jsonschema is dev-only for M1.3).

This is the single, explicitly-approved dependency expansion for this slice.

## Deferred: node-specific validation (`node_validate`)

`node_validate` and a `node_specific_error` code are **deferred**. `parameter_schema` is concrete and
language-neutral (the M10 editor reuses it); a node-specific hook would be Python-only with **no
production node consumer yet**, so its diagnostic contract would be speculative. Node-specific semantic
hooks arrive with the **first real node that needs a rule JSON Schema cannot express**, with a concrete
rule and tests.

---

## 1. `JsonSchemaSpec` — immutable, validated Draft 2020-12 schema

**Module:** `quantize/registry/schema_spec.py` (descriptor-adjacent runtime infra; not persisted IR).
Reused for both `parameter_schema` and (later) `trace_schema`.

```python
@dataclass(frozen=True)
class JsonSchemaIssue:
    path: tuple[str | int, ...]   # absolute_path elements (for structured loc)
    json_path: str
    message: str


class JsonSchemaSpec:
    """An immutable, Draft 2020-12-validated JSON Schema for validating JSON instances.

    Construction validates the schema itself (fail loud on a malformed schema) and deep-copies it,
    so the caller's mapping cannot mutate it afterward. Runtime infrastructure — not persisted IR.
    """

    __slots__ = ("_validator",)

    def __init__(self, schema: Mapping[str, Any]) -> None:
        owned = deepcopy(dict(schema))
        Draft202012Validator.check_schema(owned)      # SchemaError on a malformed schema
        self._validator = Draft202012Validator(owned)

    def errors(self, instance: object) -> tuple[JsonSchemaIssue, ...]:
        # deterministic (sorted by json_path then message); accumulate, never throw
        return tuple(
            JsonSchemaIssue(tuple(e.absolute_path), e.json_path, e.message)
            for e in sorted(
                self._validator.iter_errors(instance), key=lambda e: (e.json_path, e.message)
            )
        )
```
- `instance: object` — JSON Schema validates **any** JSON value, not only objects.
- **Practical immutability:** the deep-copied schema lives only inside the private `_validator`;
  `__slots__` + no setters. Not hardened against a deliberate `_validator.schema` reach-in (fine for
  runtime infra).
- **Structured `errors()`** so `semantic.py` can build precise `loc`s from `JsonSchemaIssue.path`.

---

## 2. Descriptor field + parameter validation

`NodeDescriptor` gains **one** optional field (Section 3 adds `trace_schema`):

```python
class NodeDescriptor(_FrozenGoverned):
    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)
    ...
    parameter_schema: JsonSchemaSpec | None = None
```
- `arbitrary_types_allowed=True` is **scoped to `NodeDescriptor`** (it holds the non-Pydantic
  `JsonSchemaSpec`). The shared `_FrozenGoverned` base and the port/metadata models stay strict.
- Default `None` — existing descriptors and fixtures are unaffected.

**Validator — parameter-validation check** (in `semantic.py`, after resolution; only for resolved
nodes that declare a schema):
```python
if descriptor.parameter_schema is not None:
    for issue in descriptor.parameter_schema.errors(node.params):
        diagnostics.append(
            SemanticDiagnostic(
                INVALID_PARAMETERS,
                f"{issue.json_path}: {issue.message}",
                ("nodes", index, "params", *issue.path),
                node.id,
            )
        )
```
`INVALID_PARAMETERS = "invalid_parameters"` (in `errors.py`). The structured `path` yields precise
`loc`s like `("nodes", 2, "params", "n")`. Accumulated, deterministic (the helper sorts), never throws.

---

## 3. Minimal trace-event envelope

**Module:** `quantize/tracing/events.py` (tracing is its own concern). M2 **fixes the shape only** —
no trace construction (M6) and no payload validation (M6).

```python
class _FrozenTraceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class TraceEvent(_FrozenTraceModel):
    run_id: EntityId                          # UUID of the run
    timestamp: Utc                            # tz-aware, normalized to UTC
    node_id: NodeId
    component_path: tuple[NodeId, ...] = ()    # hierarchical component-instance path; () == top level
    event_type: str = Field(min_length=1)      # open string (events are extensible, like type_id)
    payload: JsonObject                        # portable JSON; per-node shape declared by trace_schema
```
- A **local** `_FrozenTraceModel` — does **not** import the registry-private `_FrozenGoverned`.
- Reuses M1 primitives (`EntityId`, `Utc`, `NodeId`, `JsonObject`), so naive datetimes, bad ids, and
  non-portable payloads are rejected as in the IR.
- `component_path` defaults to `()` (top level).

**Descriptor declares its trace payload schema** (`NodeDescriptor`'s second optional field):
```python
    trace_schema: JsonSchemaSpec | None = None   # the schema of TraceEvent.payload this node emits
```
`trace_schema` describes **`TraceEvent.payload`**, not the whole envelope. M2 `check_schema`-validates
and stores it (a malformed trace schema fails loud at descriptor construction); validating emitted
payloads against it is **M6**.

---

## 4. Testing

### `tests/test_schema_spec.py`
- valid schema constructs; a malformed schema raises (`check_schema`).
- `errors()` returns sorted `JsonSchemaIssue`s with `path`/`json_path`/`message` for an invalid
  instance; empty tuple for a valid instance; works for a non-object instance (`instance: object`).
- practical immutability: mutating the caller's original dict after construction does not change
  validation results (deep-copy ownership).

### `tests/test_registry_descriptor.py` / `tests/test_semantic_validation.py`
- a descriptor can carry a `parameter_schema`; a malformed schema fails loud at construction.
- **parameter validation:** add a fixture node with a `parameter_schema` (e.g. `{type:object,
  properties:{n:{type:integer, minimum:1}}, required:[n]}`); a doc with valid params → no
  `invalid_parameters`; invalid params (missing `n`, wrong type, `n=0`) → `invalid_parameters` with
  `loc` under `("nodes", i, "params", ...)` and `subject == node.id`.
- **regression:** reference strategies A and B stay `ok=True` (their descriptors carry no
  `parameter_schema`, so no param diagnostics).

### `tests/test_trace_events.py`
- `TraceEvent` constructs with valid fields; `component_path` defaults to `()`.
- rejects: naive `timestamp`, bad `node_id`, empty `event_type`, non-portable `payload`, unknown field.
- a descriptor can carry a `trace_schema`; a malformed trace schema fails loud at construction.

---

## 5. Acceptance criteria
- `jsonschema` is a runtime dependency (`pyproject` + regenerated `requirements.lock.txt` + updated
  mypy comment).
- `JsonSchemaSpec` + `JsonSchemaIssue` with immutable ownership and structured `errors()`; tests.
- `NodeDescriptor.parameter_schema` + `trace_schema` (`arbitrary_types_allowed` scoped to it).
- `INVALID_PARAMETERS`; validator parameter check with structured `loc`; valid clean / invalid
  diagnosed; reference strategies stay `ok`.
- `TraceEvent` envelope (`quantize/tracing/events.py`, local frozen base, `component_path = ()`).
- `node_validate` deferred (documented).
- `pytest` · `ruff check .` · `ruff format --check .` · `mypy` green; **no `schema/`/`ts/`/codegen**
  changes.

## 6. Explicit exclusions
No node-specific validation hook (deferred); no 12 node implementations (M3 phase); no trace
construction or payload-vs-`trace_schema` validation (M6); no codegen / `schema/` / `ts/` changes.
The only dependency change is the approved `jsonschema` runtime promotion.
