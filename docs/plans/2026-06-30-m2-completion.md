# M2 Completion (Parameter Validation + Trace Envelope) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish M2's contract/validation surface — descriptor `parameter_schema` with real JSON-Schema parameter validation, and the minimal `TraceEvent` envelope with a descriptor `trace_schema`.

**Architecture:** A new immutable `JsonSchemaSpec` (Draft 2020-12) backs both schemas. The semantic validator gains a parameter-validation check emitting `invalid_parameters` with structured `loc`. A new `quantize/tracing/events.py` fixes the trace-event shape. `jsonschema` is promoted to a runtime dependency (approved).

**Tech Stack:** Python 3.14, Pydantic v2, jsonschema (Draft 2020-12), pytest, ruff, mypy (strict).

**Design reference:** `docs/plans/2026-06-30-m2-completion-design.md`.

**Verification gate (before declaring any code task done):**
`./.venv/Scripts/python.exe -m pytest -q` · `ruff check .` · `ruff format --check .` · `mypy`

---

## Task 1: Promote `jsonschema` to a runtime dependency

**Files:**
- Modify: `pyproject.toml`
- Modify: `requirements.lock.txt` (regenerate)

**Step 1:** In `pyproject.toml`, move `jsonschema>=4.20` from `[project.optional-dependencies].dev`
to `[project].dependencies` (keep the version constraint). Leave the comment about Draft 2020-12 with
the new runtime line.

**Step 2:** Update the mypy override comment — it currently says jsonschema is dev-only for the M1.3
contract test. Replace with: jsonschema is a runtime dependency (parameter validation) that ships no
type stubs, so ignore its missing imports.

**Step 3:** Regenerate the lock:
`./.venv/Scripts/python.exe -m pip freeze --exclude-editable > requirements.lock.txt`
Expected: jsonschema already present (it was a dev dep) — content likely unchanged. Report the diff.

**Step 4:** Gate — `ruff check .` (toml not linted, but run pytest/mypy to confirm nothing broke).

**Step 5: Commit**
`git commit -m "build: promote jsonschema to a runtime dependency (M2.4 param validation)"`

---

## Task 2: `JsonSchemaSpec` + `JsonSchemaIssue`

**Files:**
- Create: `quantize/registry/schema_spec.py`
- Test: `tests/test_schema_spec.py`

**Step 1: Write the failing tests**

```python
# tests/test_schema_spec.py
import pytest
from jsonschema.exceptions import SchemaError

from quantize.registry.schema_spec import JsonSchemaSpec

_SCHEMA = {
    "type": "object",
    "properties": {"n": {"type": "integer", "minimum": 1}},
    "required": ["n"],
    "additionalProperties": False,
}


def test_valid_instance_has_no_issues() -> None:
    assert JsonSchemaSpec(_SCHEMA).errors({"n": 3}) == ()


def test_invalid_instance_reports_structured_issues() -> None:
    issues = JsonSchemaSpec(_SCHEMA).errors({})  # missing required "n"
    assert issues
    assert issues[0].message  # human message present
    assert isinstance(issues[0].path, tuple)


def test_minimum_violation_has_path() -> None:
    issues = JsonSchemaSpec(_SCHEMA).errors({"n": 0})
    assert any(issue.path == ("n",) for issue in issues)


def test_malformed_schema_raises() -> None:
    with pytest.raises(SchemaError):
        JsonSchemaSpec({"type": "not_a_real_type"})


def test_validates_non_object_instance() -> None:
    spec = JsonSchemaSpec({"type": "integer"})
    assert spec.errors(5) == ()
    assert spec.errors("x")


def test_deep_copy_ownership() -> None:
    raw = {"type": "object", "properties": {"n": {"type": "integer"}}}
    spec = JsonSchemaSpec(raw)
    raw["properties"]["n"]["type"] = "string"  # mutate the caller's dict after construction
    assert spec.errors({"n": 1}) == ()  # unaffected — spec owns a deep copy
```

**Step 2: Run to verify it fails** — `ModuleNotFoundError`.

**Step 3: Implement**

```python
# quantize/registry/schema_spec.py
"""Immutable, Draft 2020-12-validated JSON Schema for validating JSON instances.

Runtime infrastructure (descriptor parameter_schema / trace_schema) — NOT persisted IR. Construction
validates the schema and takes ownership via a deep copy; the schema lives only inside a private
validator, so the caller's mapping cannot mutate it afterward (practical immutability).
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from jsonschema import Draft202012Validator


@dataclass(frozen=True)
class JsonSchemaIssue:
    """One validation failure of a JSON instance against a schema."""

    path: tuple[str | int, ...]
    json_path: str
    message: str


class JsonSchemaSpec:
    """A validated, immutable Draft 2020-12 schema. See module docstring."""

    __slots__ = ("_validator",)

    def __init__(self, schema: Mapping[str, Any]) -> None:
        owned = deepcopy(dict(schema))
        Draft202012Validator.check_schema(owned)
        self._validator = Draft202012Validator(owned)

    def errors(self, instance: object) -> tuple[JsonSchemaIssue, ...]:
        return tuple(
            JsonSchemaIssue(tuple(e.absolute_path), e.json_path, e.message)
            for e in sorted(
                self._validator.iter_errors(instance), key=lambda e: (e.json_path, e.message)
            )
        )
```

**Step 4: Run to verify it passes.** **Step 5: Commit**
`git commit -m "feat(registry): M2.4 JsonSchemaSpec (immutable Draft 2020-12 schema)"`

---

## Task 3: `NodeDescriptor.parameter_schema`

**Files:**
- Modify: `quantize/registry/descriptor.py`
- Test: `tests/test_registry_descriptor.py`

**Step 1: Write the failing tests** (append)

```python
from quantize.registry.schema_spec import JsonSchemaSpec


def test_descriptor_accepts_parameter_schema() -> None:
    spec = JsonSchemaSpec({"type": "object"})
    d = _descriptor(parameter_schema=spec)
    assert d.parameter_schema is spec


def test_descriptor_parameter_schema_defaults_none() -> None:
    assert _descriptor().parameter_schema is None
```

**Step 2: Run to verify it fails** — `TypeError`/validation error for unknown kwarg or `AttributeError`.

**Step 3: Implement** — in `descriptor.py`:
- import: `from collections.abc import Iterable` is NOT needed (node_validate deferred);
  `from quantize.registry.schema_spec import JsonSchemaSpec`.
- give `NodeDescriptor` its own `model_config` enabling arbitrary types, and add the field:

```python
class NodeDescriptor(_FrozenGoverned):
    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    type_id: RegisteredTypeId
    type_version: SemVer
    inputs: tuple[InputPortSpec, ...]
    outputs: tuple[OutputPortSpec, ...]
    metadata: NodeMetadata
    parameter_schema: JsonSchemaSpec | None = None
    # trace_schema added in Task 6
    ...
    @model_validator(mode="after")
    def _reject_duplicate_port_names(self) -> Self: ...   # unchanged
```
(`ConfigDict` is already imported.)

**Step 4: Run to verify it passes.** **Step 5: Commit**
`git commit -m "feat(registry): M2.4 descriptor parameter_schema field"`

---

## Task 4: parameter-validation check in the validator

**Files:**
- Modify: `quantize/validation/errors.py` (add `INVALID_PARAMETERS`)
- Modify: `quantize/validation/semantic.py` (the check)
- Modify: `tests/registry_fixtures.py` (a node with a `parameter_schema` + a doc builder)
- Test: `tests/test_semantic_validation.py`

**Step 1: Fixtures** — add to `registry_fixtures.py`:

```python
from quantize.registry.schema_spec import JsonSchemaSpec

_PARAM_SCHEMA = JsonSchemaSpec(
    {
        "type": "object",
        "properties": {"n": {"type": "integer", "minimum": 1}},
        "required": ["n"],
        "additionalProperties": False,
    }
)


def _param_node() -> NodeDescriptor:
    return NodeDescriptor(
        type_id="test.param",
        type_version="1.0.0",
        inputs=(),
        outputs=(OutputPortSpec(name="out", port_type=_CS_NUM),),
        metadata=NodeMetadata(display_name="Param", description="Synthetic parameterized node."),
        parameter_schema=_PARAM_SCHEMA,
    )
# register _param_node() inside build_fixture_registry()


def build_param_document(params: dict[str, object]) -> StrategyDocument:
    """Single test.param node carrying *params* (no edges; output unconsumed is fine)."""
    nodes: list[NodeInstance] = [
        RegisteredNode(id="p", type_id="test.param", type_version="1.0.0", params=params)
    ]
    return _document(nodes, [])
```

**Step 2: Tests** (`test_semantic_validation.py`):

```python
from tests.registry_fixtures import build_param_document  # add to imports


def test_valid_params_pass() -> None:
    v = validate_strategy_semantics(build_param_document({"n": 3}), build_fixture_registry())
    assert all(d.code != "invalid_parameters" for d in v.diagnostics)


@pytest.mark.parametrize("params", [{}, {"n": "x"}, {"n": 0}, {"n": 1, "extra": True}])
def test_invalid_params_detected(params: dict[str, object]) -> None:
    v = validate_strategy_semantics(build_param_document(params), build_fixture_registry())
    assert any(d.code == "invalid_parameters" for d in v.diagnostics)


def test_invalid_params_loc_and_subject() -> None:
    v = validate_strategy_semantics(build_param_document({"n": 0}), build_fixture_registry())
    diag = next(d for d in v.diagnostics if d.code == "invalid_parameters")
    assert diag.loc[:3] == ("nodes", 0, "params")
    assert diag.subject == "p"
```
(Add `import pytest` if not present.)

**Step 3: Implement** — `errors.py`: `INVALID_PARAMETERS = "invalid_parameters"`. `semantic.py`: after
the resolution loop (before or after the edge loop), add:

```python
    # Parameter validation: node params must satisfy the descriptor's parameter_schema (if any).
    for index, node in enumerate(document.nodes):
        descriptor = resolved.get(node.id)
        if descriptor is None or descriptor.parameter_schema is None:
            continue
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
Add `INVALID_PARAMETERS` to the errors import. (Note: `node` here is `NodeInstance`; `resolved` only
holds `RegisteredNode` descriptors, and `node.params` exists on both node variants.)

**Step 4: Full gate** (reference strategies must stay `ok` — they have no `parameter_schema`).
**Step 5: Commit**
`git commit -m "feat(validation): M2.4 parameter validation against descriptor schema"`

---

## Task 5: `TraceEvent` envelope + descriptor `trace_schema`

**Files:**
- Create: `quantize/tracing/__init__.py`, `quantize/tracing/events.py`
- Modify: `quantize/registry/descriptor.py` (add `trace_schema`)
- Test: `tests/test_trace_events.py`, `tests/test_registry_descriptor.py`

**Step 1: Write failing tests**

```python
# tests/test_trace_events.py
import pytest
from pydantic import ValidationError

from quantize.tracing.events import TraceEvent

_RUN = "44444444-4444-4444-4444-444444444444"


def _event(**overrides: object) -> TraceEvent:
    base: dict[str, object] = dict(
        run_id=_RUN,
        timestamp="2026-01-01T00:00:00Z",
        node_id="rk",
        event_type="evaluated",
        payload={},
    )
    base.update(overrides)
    return TraceEvent(**base)  # type: ignore[arg-type]


def test_trace_event_constructs_and_defaults_component_path() -> None:
    e = _event()
    assert e.component_path == ()


def test_trace_event_rejects_naive_timestamp() -> None:
    with pytest.raises(ValidationError):
        _event(timestamp="2026-01-01T00:00:00")  # no tzinfo


def test_trace_event_rejects_empty_event_type() -> None:
    with pytest.raises(ValidationError):
        _event(event_type="")


def test_trace_event_rejects_non_portable_payload() -> None:
    with pytest.raises(ValidationError):
        _event(payload={"x": float("nan")})


def test_trace_event_forbids_unknown_field() -> None:
    with pytest.raises(ValidationError):
        _event(flavor="spicy")
```

```python
# append to tests/test_registry_descriptor.py
def test_descriptor_accepts_trace_schema() -> None:
    spec = JsonSchemaSpec({"type": "object"})
    assert _descriptor(trace_schema=spec).trace_schema is spec
```

**Step 2: Run to verify failures.**

**Step 3: Implement**

```python
# quantize/tracing/__init__.py
"""Trace-event envelope and (later) trace construction/persistence."""
```

```python
# quantize/tracing/events.py
"""The minimal trace-event envelope (fixed at M2).

M2 fixes only the shape so registered nodes can declare a trace_schema for TraceEvent.payload.
Trace CONSTRUCTION is M6; payload validation against trace_schema is M6; persistence is M7.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from quantize.schema.primitives import EntityId, JsonObject, NodeId, Utc


class _FrozenTraceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class TraceEvent(_FrozenTraceModel):
    """One structured decision-trace event (envelope only; payload shape is per-node)."""

    run_id: EntityId
    timestamp: Utc
    node_id: NodeId
    component_path: tuple[NodeId, ...] = ()
    event_type: str = Field(min_length=1)
    payload: JsonObject
```

In `descriptor.py`, add the field after `parameter_schema`:
```python
    trace_schema: JsonSchemaSpec | None = None   # schema of TraceEvent.payload this node emits (M6)
```

**Step 4: Full gate.** **Step 5: Commit**
`git commit -m "feat(tracing): M2 minimal trace-event envelope + descriptor trace_schema"`

---

## Done criteria

- [ ] `jsonschema` runtime dep (pyproject + lock + mypy comment).
- [ ] `JsonSchemaSpec`/`JsonSchemaIssue` (immutable, structured issues) + tests.
- [ ] `NodeDescriptor.parameter_schema` + `trace_schema`; `arbitrary_types_allowed` scoped to descriptor.
- [ ] `INVALID_PARAMETERS`; validator parameter check with structured `loc`; valid clean / invalid diagnosed; reference strategies A/B still `ok`.
- [ ] `TraceEvent` envelope (local frozen base, `component_path = ()`); rejects naive ts / empty event_type / non-portable payload / unknown field.
- [ ] `node_validate` deferred (documented in design).
- [ ] `pytest`/`ruff`/`ruff format`/`mypy` green; `codegen check` still clean (no schema/ts changes).

## Post-implementation

- Update `docs/LEARNING_LOG.md` with the M2-completion entry — **with founder approval**.
- M2 is then complete except the 12 node implementations (M3 phase). Next: M3-PRE (market-data fixture) → M3 (graph evaluator) — founder hand-implementation.
