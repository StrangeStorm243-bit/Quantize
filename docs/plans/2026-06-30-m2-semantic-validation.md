# M2.2 Semantic Validation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a registry-dependent semantic validator that resolves registered nodes and checks edge port wiring by name over an already-parsed, structurally-valid `StrategyDocument`.

**Architecture:** A shared deterministic ordering helper (extracted from M1.2) feeds both structural and a new parallel `SemanticDiagnostic`/`SemanticValidation` result type. `validate_strategy_semantics(document, registry_view)` runs four checks (node resolution, output/input port-name existence, required-input connectivity) and accumulates deterministic diagnostics. Reference registries for Strategy A and B prove the committed wirings resolve by name.

**Tech Stack:** Python 3.14, Pydantic v2, `@dataclass`, `typing.Protocol`, pytest, ruff, mypy (strict).

**Design reference:** `docs/plans/2026-06-30-m2-semantic-validation-design.md`.

**Verification gate (run before declaring any code task done):**
`./.venv/Scripts/python.exe -m pytest -q` · `ruff check .` · `ruff format --check .` · `mypy`
(No Node/codegen steps — M2.2 touches no generated artifacts.)

---

## Task 1: Shared ordering helper + behavior-preserving structural refactor

**Files:**
- Create: `quantize/validation/diagnostics.py`
- Modify: `quantize/validation/structural.py`

**Step 1: Write `diagnostics.py`**

```python
# quantize/validation/diagnostics.py
"""Shared deterministic ordering for validation diagnostics.

Structural (M1.2) and semantic (M2.2) layers sort findings by one policy — loc, then code, then
subject — so output never depends on dict/set iteration order. Extracted here so the two layers
share one policy and cannot drift.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol


class HasLocCodeSubject(Protocol):
    loc: tuple[str | int, ...]
    code: str
    subject: str | None


def diagnostic_sort_key(diagnostic: HasLocCodeSubject) -> tuple[object, ...]:
    # Map each loc element to (type_rank, value) so mixed int/str paths order deterministically,
    # then break ties by code and subject.
    loc = tuple(
        (0, element) if isinstance(element, int) else (1, element) for element in diagnostic.loc
    )
    return (loc, diagnostic.code, diagnostic.subject or "")


def sort_diagnostics[T: HasLocCodeSubject](items: Iterable[T]) -> tuple[T, ...]:
    return tuple(sorted(items, key=diagnostic_sort_key))
```

**Step 2: Refactor `structural.py` to use it**

- Delete the local `_error_sort_key` and `_sorted` functions.
- Add import: `from quantize.validation.diagnostics import sort_diagnostics`.
- Replace each `ordered = _sorted(errors)` with `ordered = sort_diagnostics(errors)` (in
  `validate_strategy_document`, `validate_component_definition`, `validate_component_set`).
- Drop now-unused `Iterable` from the `collections.abc` import line (keep `Hashable`, `Iterator`,
  `Sequence`).

**Step 3: Run M1.2 tests (the behavior-preservation guard)**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_structural_validation.py -q`
Expected: PASS (unchanged) — proves the extraction preserved ordering behavior.

**Step 4: Gate**

Run: `./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy`
Expected: clean (no unused imports; Protocol typed).

**Step 5: Commit**

```bash
git add quantize/validation/diagnostics.py quantize/validation/structural.py
git commit -m "refactor(validation): extract shared diagnostic ordering helper"
```

---

## Task 2: Semantic result types + code constants

**Files:**
- Modify: `quantize/validation/errors.py`
- Test: `tests/test_semantic_validation.py`

**Step 1: Write the failing test**

```python
# tests/test_semantic_validation.py
from quantize.validation.errors import SemanticDiagnostic, SemanticValidation


def test_semantic_validation_ok_when_empty() -> None:
    v = SemanticValidation(ok=True)
    assert v.ok and v.diagnostics == ()


def test_semantic_diagnostic_fields() -> None:
    d = SemanticDiagnostic(code="unknown_node_type", message="x", loc=("nodes", 0), subject="a.b")
    assert d.code == "unknown_node_type" and d.loc == ("nodes", 0)
```

**Step 2: Run to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_semantic_validation.py -q`
Expected: FAIL — `ImportError`.

**Step 3: Implement (append to `errors.py`)**

- Broaden the module docstring to "validation result types" with **Structural** / **Semantic**
  sections.
- Append:

```python
# --- Semantic diagnostics (M2.2) -------------------------------------------------------------
# Machine-stable identifiers (an editor/API keys on these, not on the human message text).
UNKNOWN_NODE_TYPE = "unknown_node_type"
NODE_VERSION_UNAVAILABLE = "node_version_unavailable"
UNKNOWN_OUTPUT_PORT = "unknown_output_port"
UNKNOWN_INPUT_PORT = "unknown_input_port"
REQUIRED_INPUT_UNCONNECTED = "required_input_unconnected"


@dataclass(frozen=True)
class SemanticDiagnostic:
    """One semantic finding (registry-dependent). Same shape as StructuralError; distinct type."""

    code: str
    message: str
    loc: tuple[str | int, ...]
    subject: str | None = None


@dataclass(frozen=True)
class SemanticValidation:
    """The outcome of semantic validation. v0: all diagnostics are hard errors (ok = not diags)."""

    ok: bool
    diagnostics: tuple[SemanticDiagnostic, ...] = ()
```

**Step 4: Run to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_semantic_validation.py -q`
Expected: PASS.

**Step 5: Commit**

```bash
git add quantize/validation/errors.py tests/test_semantic_validation.py
git commit -m "feat(validation): M2.2 semantic result types + code constants"
```

---

## Task 3: Validator — node resolution (checks 1)

**Files:**
- Create: `quantize/validation/semantic.py`
- Modify: `tests/registry_fixtures.py` (add a real valid `StrategyDocument` + a tiny doc builder)
- Test: `tests/test_semantic_validation.py`

**Step 1: Add a valid synthetic document helper to `registry_fixtures.py`**

```python
# append to tests/registry_fixtures.py
from quantize.schema.document import (
    ExecutionPolicy,
    StrategyDocument,
    StrategyMeta,
    TransactionCosts,
)
from quantize.schema.nodes import Edge, RegisteredNode
from quantize.schema.provenance import Provenance
from quantize.schema.schedule import ScheduleDaily

_OWNER = "22222222-2222-2222-2222-222222222222"


def _provenance() -> Provenance:
    return Provenance(
        owner=_OWNER, creator=_OWNER, contributors=[], visibility="private", duplicable=False,
        created_at="2026-01-01T00:00:00Z",
    )


def build_wired_document(
    *, source_type_version: str = "1.0.0", sink_in_port: str = "in", source_out_port: str = "out"
) -> StrategyDocument:
    """A minimal real StrategyDocument wiring test.source.out -> test.sink.in (overridable)."""
    return StrategyDocument(
        schema_version="0.1.0",
        strategy=StrategyMeta(id=_OWNER, version=1, name="wired", provenance=_provenance()),
        execution_policy=ExecutionPolicy(
            policy="close_signal_next_session_open",
            valuation="session_close",
            transaction_costs=TransactionCosts(model="bps", bps=5),
        ),
        schedule=ScheduleDaily(kind="daily"),
        nodes=[
            RegisteredNode(id="s", type_id="test.source", type_version=source_type_version, params={}),
            RegisteredNode(id="k", type_id="test.sink", type_version="1.0.0", params={}),
        ],
        edges=[Edge(**{"from": ("s", source_out_port), "to": ("k", sink_in_port)})],
        component_refs=[],
    )
```
*(Verify the exact class names/imports against `quantize/schema/` when implementing — adjust if the
provenance/schedule constructors differ. The point: build a real parsed document, not a dict.)*

**Step 2: Write the failing tests**

```python
# append to tests/test_semantic_validation.py
from quantize.registry.registry import NodeRegistry
from quantize.validation.semantic import validate_strategy_semantics
from tests.registry_fixtures import build_fixture_registry, build_wired_document


def test_valid_document_resolves_clean() -> None:
    v = validate_strategy_semantics(build_wired_document(), build_fixture_registry())
    assert v.ok and v.diagnostics == ()


def test_unknown_node_type() -> None:
    doc = build_wired_document()
    # registry without test.source/test.sink
    v = validate_strategy_semantics(doc, NodeRegistry())
    codes = {d.code for d in v.diagnostics}
    assert "unknown_node_type" in codes and not v.ok


def test_node_version_unavailable() -> None:
    doc = build_wired_document(source_type_version="9.9.9")
    v = validate_strategy_semantics(doc, build_fixture_registry())
    assert any(d.code == "node_version_unavailable" and d.subject == "test.source"
               for d in v.diagnostics)
```

**Step 3: Run to verify it fails**

Expected: FAIL — `ModuleNotFoundError: quantize.validation.semantic`.

**Step 4: Implement `semantic.py` (resolution only for now)**

```python
# quantize/validation/semantic.py
"""M2.2 semantic validation — registry resolution + port wiring by name.

Operates on an ALREADY-PARSED, STRUCTURALLY-VALID StrategyDocument; it does not rerun or duplicate
M1 structural checks. Pure, deterministic, registry-injected (read-only NodeRegistryView). Component
nodes are not registry-resolved (deferred to M3); port-type compatibility is M2.3; parameters M2.4.
"""

from __future__ import annotations

from quantize.registry.descriptor import NodeDescriptor
from quantize.registry.registry import NodeRegistryView, ResolutionStatus
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import RegisteredNode
from quantize.validation.diagnostics import sort_diagnostics
from quantize.validation.errors import (
    NODE_VERSION_UNAVAILABLE,
    UNKNOWN_NODE_TYPE,
    SemanticDiagnostic,
    SemanticValidation,
)


def validate_strategy_semantics(
    document: StrategyDocument, registry: NodeRegistryView
) -> SemanticValidation:
    diagnostics: list[SemanticDiagnostic] = []
    resolved: dict[str, NodeDescriptor] = {}

    for index, node in enumerate(document.nodes):
        if not isinstance(node, RegisteredNode):
            continue  # component nodes: deferred to M3
        result = registry.resolve(node.type_id, node.type_version)
        if result.status is ResolutionStatus.OK:
            assert result.descriptor is not None
            resolved[node.id] = result.descriptor
        elif result.status is ResolutionStatus.UNKNOWN_TYPE:
            diagnostics.append(
                SemanticDiagnostic(
                    UNKNOWN_NODE_TYPE,
                    f"node type {node.type_id!r} is not registered",
                    ("nodes", index),
                    node.type_id,
                )
            )
        else:  # VERSION_UNAVAILABLE
            available = ", ".join(result.available_versions)
            diagnostics.append(
                SemanticDiagnostic(
                    NODE_VERSION_UNAVAILABLE,
                    f"node type {node.type_id!r} has no version {node.type_version!r} "
                    f"(available: {available})",
                    ("nodes", index),
                    node.type_id,
                )
            )

    return SemanticValidation(ok=not diagnostics, diagnostics=sort_diagnostics(diagnostics))
```

**Step 5: Run + gate, then commit**

```bash
./.venv/Scripts/python.exe -m pytest tests/test_semantic_validation.py -q   # PASS
git add quantize/validation/semantic.py tests/registry_fixtures.py tests/test_semantic_validation.py
git commit -m "feat(validation): M2.2 semantic node resolution"
```

---

## Task 4: Validator — port-name existence + per-endpoint component skip (check 2)

**Files:**
- Modify: `quantize/validation/semantic.py`
- Test: `tests/test_semantic_validation.py`

**Step 1: Write the failing tests**

```python
def test_unknown_output_port() -> None:
    doc = build_wired_document(source_out_port="nope")
    v = validate_strategy_semantics(doc, build_fixture_registry())
    assert any(d.code == "unknown_output_port" and d.subject == "nope" for d in v.diagnostics)


def test_unknown_input_port() -> None:
    doc = build_wired_document(sink_in_port="nope")
    v = validate_strategy_semantics(doc, build_fixture_registry())
    assert any(d.code == "unknown_input_port" and d.subject == "nope" for d in v.diagnostics)
```

(Plus a component-endpoint test — see the design's Edit-1 — once a component-node doc builder exists;
add a `build_component_edge_document()` helper to `registry_fixtures.py` that wires a `component`
node's port into a resolved `test.sink.in`, and assert the registered endpoint is still checked while
the component endpoint is skipped.)

**Step 2: Run to verify failure**, then **Step 3: extend `semantic.py`** — after the resolution loop,
add edge port-name checks:

```python
    output_names = {nid: {p.name for p in d.outputs} for nid, d in resolved.items()}
    input_names = {nid: {p.name for p in d.inputs} for nid, d in resolved.items()}

    for index, edge in enumerate(document.edges):
        src_id, src_port = edge.from_
        dst_id, dst_port = edge.to
        if src_id in output_names and src_port not in output_names[src_id]:
            diagnostics.append(
                SemanticDiagnostic(
                    UNKNOWN_OUTPUT_PORT,
                    f"node {src_id!r} has no output port {src_port!r}",
                    ("edges", index, "from"),
                    src_port,
                )
            )
        if dst_id in input_names and dst_port not in input_names[dst_id]:
            diagnostics.append(
                SemanticDiagnostic(
                    UNKNOWN_INPUT_PORT,
                    f"node {dst_id!r} has no input port {dst_port!r}",
                    ("edges", index, "to"),
                    dst_port,
                )
            )
```
(Endpoints not in `resolved` — component nodes or failed-resolution nodes — are skipped *per endpoint*
because the membership test gates each side independently.) Add the new code constants to the import.

**Step 4: Run + gate. Step 5: Commit**
`git commit -m "feat(validation): M2.2 port-name existence checks"`

---

## Task 5: Validator — required-input connectivity (check 3, no cascade) + determinism

**Files:**
- Modify: `quantize/validation/semantic.py`
- Test: `tests/test_semantic_validation.py`

**Step 1: Write the failing tests**

```python
def test_required_input_unconnected() -> None:
    doc = build_wired_document()
    doc = doc.model_copy(update={"edges": []})  # remove the edge feeding sink.in (required)
    v = validate_strategy_semantics(doc, build_fixture_registry())
    assert any(d.code == "required_input_unconnected" and d.subject == "in" for d in v.diagnostics)


def test_optional_input_unconnected_is_fine() -> None:
    # sink.opt is optional; leaving it unconnected must not raise a diagnostic
    v = validate_strategy_semantics(build_wired_document(), build_fixture_registry())
    assert all(d.code != "required_input_unconnected" for d in v.diagnostics)


def test_connectivity_satisfied_even_if_source_unknown() -> None:
    # Edit-2: an edge into sink.in whose source is an unknown type still satisfies connectivity;
    # the source still gets unknown_node_type, but no required_input_unconnected for sink.in.
    ...  # build a doc: unknown-type source -> sink.in; assert codes accordingly
```

**Step 2: failure. Step 3: extend `semantic.py`** — after the edge loop, add connectivity. Note it
counts ANY edge target, regardless of source resolution:

```python
    connected_targets = {(edge.to[0], edge.to[1]) for edge in document.edges}
    for index, node in enumerate(document.nodes):
        descriptor = resolved.get(node.id)
        if descriptor is None:
            continue
        for port in descriptor.inputs:
            if port.required and (node.id, port.name) not in connected_targets:
                diagnostics.append(
                    SemanticDiagnostic(
                        REQUIRED_INPUT_UNCONNECTED,
                        f"required input {port.name!r} of node {node.id!r} is not connected",
                        ("nodes", index),
                        port.name,
                    )
                )
```
Add a determinism test: a doc with several faults → `[d.code for d in v.diagnostics]` is stable across
runs and matches the `(loc, code, subject)` order.

**Step 4: Run + gate. Step 5: Commit**
`git commit -m "feat(validation): M2.2 required-input connectivity (no cascade)"`

---

## Task 6: Reference-strategy registries (A + B) + wiring tests

**Files:**
- Modify: `tests/registry_fixtures.py` (add `build_reference_registry()`)
- Test: `tests/test_semantic_validation.py`

**Step 1: Write the failing test**

```python
import json
from pathlib import Path

from quantize.schema.document import StrategyDocument
from tests.registry_fixtures import build_reference_registry

_FIX = Path(__file__).parent / "fixtures"


def _load(name: str) -> StrategyDocument:
    return StrategyDocument.model_validate(json.loads((_FIX / name).read_text()))


def test_reference_strategy_a_wiring_resolves() -> None:
    v = validate_strategy_semantics(_load("strategy_a.json"), build_reference_registry())
    assert v.ok, v.diagnostics


def test_reference_strategy_b_wiring_resolves() -> None:
    v = validate_strategy_semantics(_load("strategy_b.json"), build_reference_registry())
    assert v.ok, v.diagnostics
```

**Step 2: failure. Step 3: implement `build_reference_registry()`** in `registry_fixtures.py` with
descriptors for all node types in A and B, using the EXACT port names from the fixtures and plausible
`STRATEGY_LANGUAGE.md` port types. Helper:

```python
from quantize.schema.types import AssetSetType, PortfolioTargetsType, TimeSeriesType

_AS = AssetSetType(kind="AssetSet")
_TS_NUM = TimeSeriesType(kind="TimeSeries", dtype="Number")
_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")   # already imported
_CS_BOOL = CrossSectionType(kind="CrossSection", dtype="Boolean")
_PT = PortfolioTargetsType(kind="PortfolioTargets")


def _desc(type_id, ins, outs):  # ins/outs: list[tuple[name, port_type]]
    return NodeDescriptor(
        type_id=type_id, type_version="1.0.0",
        inputs=tuple(InputPortSpec(name=n, port_type=t) for n, t in ins),
        outputs=tuple(OutputPortSpec(name=n, port_type=t) for n, t in outs),
        metadata=NodeMetadata(display_name=type_id, description=type_id),
    )
```

Descriptor table (names verified against `strategy_a.json` / `strategy_b.json` edges):

| type_id | inputs | outputs |
|---|---|---|
| `universe.fixed_list` | — | `assets: AssetSet` |
| `data.price` | `assets: AssetSet` | `series: TimeSeries[Number]` |
| `transform.trailing_return` | `series: TimeSeries[Number]` | `values: CrossSection[Number]` |
| `transform.rank` | `values: CrossSection[Number]` | `values: CrossSection[Number]` |
| `portfolio.select_top_n` | `scores: CrossSection[Number]`, `universe: AssetSet` | `assets: AssetSet` |
| `portfolio.equal_weight` | `assets: AssetSet` | `targets: PortfolioTargets` |
| `risk.max_weight` | `targets: PortfolioTargets` | `targets: PortfolioTargets` |
| `output.target_portfolio` | `targets: PortfolioTargets` | — |
| `transform.moving_average` | `series: TimeSeries[Number]` | `series: TimeSeries[Number]` |
| `transform.latest` | `series: TimeSeries[Number]` | `values: CrossSection[Number]` |
| `logic.greater_than` | `left: CrossSection[Number]`, `right: CrossSection[Number]` | `values: CrossSection[Boolean]` |
| `portfolio.fixed_weight` | `assets: AssetSet` | `targets: PortfolioTargets` |
| `portfolio.apply_mask` | `targets: PortfolioTargets`, `mask: CrossSection[Boolean]` | `targets: PortfolioTargets` |

Register all 13 into one `NodeRegistry`. (All inputs `required=True`; both reference strategies
connect every input, so connectivity passes.)

**Step 4: Full gate**

```
./.venv/Scripts/python.exe -m pytest -q
./.venv/Scripts/python.exe -m ruff check .
./.venv/Scripts/python.exe -m ruff format --check .
./.venv/Scripts/python.exe -m mypy
```
Expected: all green; both reference strategies resolve clean.

**Step 5: Commit**
`git commit -m "test(validation): M2.2 reference-strategy A+B wiring fixtures"`

---

## Done criteria (matches design acceptance)

- [ ] `diagnostics.py` shared helper; `structural.py` refactored, M1.2 tests green.
- [ ] `errors.py` broadened: `SemanticDiagnostic`/`SemanticValidation` + 5 code constants.
- [ ] `validate_strategy_semantics` — 4 checks, registry-injected, deterministic, precondition-honoring, per-endpoint component skip, no-cascade connectivity.
- [ ] Synthetic doc is a real `StrategyDocument`; component-endpoint and no-cascade tests present.
- [ ] Both reference strategies resolve clean under `build_reference_registry()`.
- [ ] `pytest`/`ruff`/`ruff format`/`mypy` green; no `schema/`/`ts/`/codegen/dependency changes.

## Post-implementation

- Update `docs/LEARNING_LOG.md` with the M2.2 entry — **with founder approval**.
- Next slice (M2.3): the single shared `is_compatible` + per-edge port-type compatibility, reusing `build_reference_registry()`.
```
