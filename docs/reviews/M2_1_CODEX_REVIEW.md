# M2.1 Independent Review - Node Registry & Descriptor Model

Review date: 2026-06-29

Scope reviewed:
- `docs/plans/2026-06-29-m2-registry-design.md`
- `docs/plans/2026-06-29-m2-registry.md`
- `quantize/registry/{descriptor,registry,errors,__init__}.py`
- `tests/{test_registry_descriptor,test_registry,test_registry_fixtures,registry_fixtures}.py`
- M2.1 diff boundary versus `main`

Verdict: changes requested. The implementation is mostly aligned with the approved M2.1 design, and
the tool gate is green, but one invariant hole in `NodeResolution` should be fixed before treating
M2.1 as fully accepted.

## Findings

### BLOCKER: `NodeResolution` can represent states outside the three-status contract

References:
- `quantize/registry/registry.py:29`
- `quantize/registry/registry.py:44`
- `quantize/registry/registry.py:65`

`NodeResolution` is documented as a typed, invariant-enforced result with exactly three statuses:
`OK`, `UNKNOWN_TYPE`, and `VERSION_UNAVAILABLE`. The public dataclass constructor currently accepts a
non-`ResolutionStatus` status value because `__post_init__` treats anything other than `OK` or
`UNKNOWN_TYPE` as `VERSION_UNAVAILABLE`.

Ad hoc evidence:

```text
NodeResolution('bad')
=> NodeResolution(status='bad', descriptor=None, available_versions=())
```

The class also allows `VERSION_UNAVAILABLE` with no available versions:

```text
NodeResolution.version_unavailable(())
=> NodeResolution(status=<ResolutionStatus.VERSION_UNAVAILABLE: 'version_unavailable'>,
                  descriptor=None,
                  available_versions=())
```

That creates an ambiguous resolution state: it is not `UNKNOWN_TYPE`, but it also has no known
versions to report. The concrete `NodeRegistry.resolve()` does not currently emit this state, but
`NodeRegistryView` deliberately supports fakes and alternate read-only providers. M2.2 semantic
validation will trust this result object to produce deterministic diagnostics, so the result type
itself should fail loud on malformed construction.

Recommended fix:
- In `NodeResolution.__post_init__`, reject any `status` that is not an instance of
  `ResolutionStatus`.
- Require `VERSION_UNAVAILABLE.available_versions` to be non-empty.
- Add tests for invalid non-enum status and empty `VERSION_UNAVAILABLE`.

### MEDIUM: `InputPortSpec.required` silently coerces string values to booleans

Reference:
- `quantize/registry/descriptor.py:28`

`required` decides whether M2.2 will report a missing input as a semantic error. It is currently a
plain Pydantic `bool`, so descriptor construction accepts string values such as `"false"` and
coerces them to `False`.

Ad hoc evidence:

```text
InputPortSpec(name='x', port_type=..., required='false').required
=> False
```

This weakens the "descriptor construction fails loud" claim for a field with direct validation
semantics. A typo in a Python-authored descriptor could silently make a required port optional.

Recommended fix:
- Use a strict boolean for `required`, e.g. `Field(default=True, strict=True)`, or otherwise enforce
  strictness for descriptor fields.
- Add a test that `required="false"` is rejected.

### LOW: Frozen descriptor coverage is narrower than the acceptance wording

Reference:
- `tests/test_registry_descriptor.py`

The tests cover frozen behavior for `InputPortSpec`, but the acceptance criteria say the frozen
descriptor set includes `InputPortSpec`, `OutputPortSpec`, `NodeMetadata`, and `NodeDescriptor`.
The implementation should freeze all of them through `_FrozenGoverned`; this is a coverage gap, not
a current behavior failure.

Recommended fix:
- Add direct mutation tests for `NodeDescriptor` and `NodeMetadata`.

### LOW: Post-implementation learning-log update appears incomplete

Reference:
- `docs/plans/2026-06-29-m2-registry.md`
- `docs/LEARNING_LOG.md`

The implementation plan's post-implementation section calls for updating `docs/LEARNING_LOG.md` with
the M2.1 registry/descriptor concepts, with founder approval. The branch updates the learning log
with the M1 walkthrough and M2 readiness entry, but I did not find a specific M2.1 completion entry.

If founder approval intentionally defers this, no action is needed now. If "M2.1 complete" includes
the plan's post-implementation item, this remains open.

## What Looks Sound

- `NodeDescriptor` is correctly scoped as static registry/runtime infrastructure, not persisted IR.
- No `schema/`, generated `ts/`, codegen, dependency, or persisted-IR files changed in the M2.1 diff.
- `RegisteredTypeId` excludes reserved `"component"` by construction.
- `PortType` excludes engine-only `OrderList`.
- Input and output port specs are split; `required` exists only on inputs.
- Metadata is required and rejects blank fields.
- Duplicate input names and duplicate output names are rejected; input/output name sharing is allowed.
- `RegistryError`/`DuplicateRegistrationError` are limited to registry infrastructure misuse.
- Unknown type and unavailable version remain non-throwing resolution outcomes.
- `NodeRegistry` is explicit and in-memory, with no decorators, import-time global, or real nodes.
- `resolve()` uses exact pinned-version semantics and does not fall back to latest/ranges.
- `descriptors()` and `available_versions()` are deterministic.
- `NodeRegistryView` omits `register()` and gives consumers a read-only capability.
- Synthetic registry fixtures avoid coupling M2.1 tests to the future 12 real nodes.

## Verification Run

Commands run:

```text
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m ruff format --check .
.\.venv\Scripts\python.exe -m mypy
```

Results:

```text
pytest: all tests passed
ruff check: All checks passed!
ruff format --check: 44 files already formatted
mypy: Success: no issues found in 44 source files
```

Boundary check:

```text
git diff --name-only main...HEAD -- quantize\schema schema ts quantize\codegen pyproject.toml package.json package-lock.json requirements.lock.txt .github
=> no output
```

Review environment note: the working tree had an unrelated deletion of
`docs/plans/M1_IMPLEMENTATION_PLAN.md` before this review. I did not touch it.

