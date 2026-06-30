# M2.3 Port-Type Compatibility — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the single shared `is_compatible` function and a fifth semantic check that rejects edges whose port types are incompatible, while both reference strategies stay clean.

**Architecture:** A central `quantize/compatibility.py` decides compatibility via an allow-list (exact match + the one `Scalar[Integer]→Scalar[Number]` widening). The M2.2 validator gains a fifth check that emits `incompatible_port_types` only when both endpoints resolve and both named ports exist.

**Tech Stack:** Python 3.14, Pydantic v2, pytest, ruff, mypy (strict).

**Design reference:** `docs/plans/2026-06-30-m2-port-compatibility-design.md`.

**Verification gate (before declaring any code task done):**
`./.venv/Scripts/python.exe -m pytest -q` · `ruff check .` · `ruff format --check .` · `mypy`

---

## Task 1: `is_compatible` + compatibility table

**Files:**
- Create: `quantize/compatibility.py`
- Test: `tests/test_compatibility.py`

**Step 1: Write the failing tests**

```python
# tests/test_compatibility.py
import pytest

from quantize.compatibility import is_compatible
from quantize.schema.types import (
    AssetSetType,
    CrossSectionType,
    PortfolioTargetsType,
    ScalarType,
    TimeSeriesType,
)

_S_INT = ScalarType(kind="Scalar", dtype="Integer")
_S_NUM = ScalarType(kind="Scalar", dtype="Number")
_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")
_CS_BOOL = CrossSectionType(kind="CrossSection", dtype="Boolean")
_TS_NUM = TimeSeriesType(kind="TimeSeries", dtype="Number")
_AS = AssetSetType(kind="AssetSet")
_PT = PortfolioTargetsType(kind="PortfolioTargets")


def test_exact_match_is_compatible() -> None:
    assert is_compatible(_CS_NUM, _CS_NUM)
    assert is_compatible(_AS, _AS)
    assert is_compatible(_PT, _PT)


def test_value_equality_across_instances() -> None:
    # the exact-match rule relies on value equality of independently constructed instances
    assert CrossSectionType(kind="CrossSection", dtype="Number") == _CS_NUM
    assert is_compatible(
        CrossSectionType(kind="CrossSection", dtype="Number"),
        CrossSectionType(kind="CrossSection", dtype="Number"),
    )


def test_scalar_integer_widens_to_number() -> None:
    assert is_compatible(_S_INT, _S_NUM)


@pytest.mark.parametrize(
    ("source", "destination"),
    [
        (_S_NUM, _S_INT),       # narrowing
        (_CS_NUM, _CS_BOOL),    # dtype differs
        (_TS_NUM, _CS_NUM),     # collapse needs a node
        (_CS_BOOL, _AS),        # mask is not a universe
        (_CS_NUM, _PT),         # weighting needs a node
        (_PT, _CS_NUM),         # portfolio is not generic numbers
    ],
)
def test_incompatible_pairs(source: object, destination: object) -> None:
    assert not is_compatible(source, destination)  # type: ignore[arg-type]
```

**Step 2: Run to verify it fails** — `ModuleNotFoundError: quantize.compatibility`.

**Step 3: Implement**

```python
# quantize/compatibility.py
"""The single, central port-type compatibility decision.

Supports the "one compatibility function" rule (docs/STRATEGY_LANGUAGE.md §2) and invariants 4/5/7:
the graph validator and (later) the editor both call this, so the frontend never reimplements type
logic. Allow-list semantics — only an exact match or the one explicit widening is compatible; every
other pairing (the "no implicit meaning change" cases) is rejected by falling through to False.
"""

from __future__ import annotations

from quantize.schema.types import PortType, ScalarType


def is_compatible(source: PortType, destination: PortType) -> bool:
    """True iff an edge from a `source` (output) port type to a `destination` (input) port type is
    allowed. Arguments follow edge direction: output -> input."""
    if source == destination:
        return True
    # the ONE explicit widening: Scalar[Integer] -> Scalar[Number]
    return (
        isinstance(source, ScalarType)
        and source.dtype == "Integer"
        and isinstance(destination, ScalarType)
        and destination.dtype == "Number"
    )
```

**Step 4: Run to verify it passes.** **Step 5: Commit**
`git commit -m "feat(compat): M2.3 single shared is_compatible + table"`

---

## Task 2: `INCOMPATIBLE_PORT_TYPES` constant

**Files:**
- Modify: `quantize/validation/errors.py`

Append to the Semantic section:
```python
INCOMPATIBLE_PORT_TYPES = "incompatible_port_types"
```
No standalone test (covered by Task 4). Run `ruff`/`mypy`; commit with Task 3 or alone:
`git commit -m "feat(validation): M2.3 incompatible_port_types code"`

---

## Task 3: fifth check in the validator + `_render_type`

**Files:**
- Modify: `quantize/validation/semantic.py`

**Step 1:** Update the module docstring — move port-type compatibility from "out of scope" to
in-scope; keep parameters (M2.4) and component resolution (M3) deferred.

**Step 2:** Change the name-sets to name→type maps and add the check. Replace the check-2 block:

```python
    # 2. Port-name existence + 3. port-type compatibility on edges. Endpoints gated independently:
    #    an unresolved endpoint (component / failed resolution) is skipped. Compatibility is checked
    #    only when BOTH endpoints resolved AND both named ports exist (no cascade on a missing port).
    output_ports = {nid: {p.name: p.port_type for p in d.outputs} for nid, d in resolved.items()}
    input_ports = {nid: {p.name: p.port_type for p in d.inputs} for nid, d in resolved.items()}
    for index, edge in enumerate(document.edges):
        src_id, src_port = edge.from_
        dst_id, dst_port = edge.to
        src_outputs = output_ports.get(src_id)
        dst_inputs = input_ports.get(dst_id)
        if src_outputs is not None and src_port not in src_outputs:
            diagnostics.append(
                SemanticDiagnostic(
                    UNKNOWN_OUTPUT_PORT,
                    f"node {src_id!r} has no output port {src_port!r}",
                    ("edges", index, "from"),
                    src_port,
                )
            )
        if dst_inputs is not None and dst_port not in dst_inputs:
            diagnostics.append(
                SemanticDiagnostic(
                    UNKNOWN_INPUT_PORT,
                    f"node {dst_id!r} has no input port {dst_port!r}",
                    ("edges", index, "to"),
                    dst_port,
                )
            )
        if (
            src_outputs is not None
            and src_port in src_outputs
            and dst_inputs is not None
            and dst_port in dst_inputs
            and not is_compatible(src_outputs[src_port], dst_inputs[dst_port])
        ):
            source = src_outputs[src_port]
            destination = dst_inputs[dst_port]
            diagnostics.append(
                SemanticDiagnostic(
                    INCOMPATIBLE_PORT_TYPES,
                    f"port type {_render_type(source)} from {src_id!r}.{src_port!r} is not "
                    f"compatible with {_render_type(destination)} at {dst_id!r}.{dst_port!r}",
                    ("edges", index),
                    dst_port,
                )
            )
```

**Step 3:** Add the private total helper (near the top of the module, after imports):

```python
def _render_type(port_type: PortType) -> str:
    dtype = getattr(port_type, "dtype", None)
    return f"{port_type.kind}[{dtype}]" if dtype is not None else port_type.kind
```

**Step 4:** Imports — add `from quantize.compatibility import is_compatible`,
`from quantize.schema.types import PortType`, and `INCOMPATIBLE_PORT_TYPES` to the errors import.

**Step 5:** Gate (`pytest`/`ruff`/`mypy`), then commit:
`git commit -m "feat(validation): M2.3 fifth check — port-type compatibility"`

---

## Task 4: integration tests (incompatible edge + gating + regression)

**Files:**
- Modify: `tests/registry_fixtures.py` (add `test.tsource` descriptor + `build_incompatible_document`)
- Modify: `tests/test_semantic_validation.py`

**Step 1:** Fixtures — register a `TimeSeries[Number]`-output source and a doc wiring it into the
`CrossSection[Number]` sink input:

```python
# in registry_fixtures.py
def _tsource() -> NodeDescriptor:
    return NodeDescriptor(
        type_id="test.tsource",
        type_version="1.0.0",
        inputs=(),
        outputs=(OutputPortSpec(name="out", port_type=_TS_NUM),),
        metadata=NodeMetadata(display_name="TSource", description="Synthetic TimeSeries source."),
    )
# register _tsource() inside build_fixture_registry()

def build_incompatible_document() -> StrategyDocument:
    """test.tsource.out (TimeSeries[Number]) -> test.sink.in (CrossSection[Number]) — incompatible."""
    nodes: list[NodeInstance] = [
        RegisteredNode(id="s", type_id="test.tsource", type_version="1.0.0", params={}),
        RegisteredNode(id="k", type_id="test.sink", type_version="1.0.0", params={}),
    ]
    edges = [Edge.model_validate({"from": ("s", "out"), "to": ("k", "in")})]
    return _document(nodes, edges)
```

**Step 2:** Tests:

```python
def test_incompatible_port_types_detected() -> None:
    v = validate_strategy_semantics(build_incompatible_document(), build_fixture_registry())
    diags = [d for d in v.diagnostics if d.code == "incompatible_port_types"]
    assert diags
    assert "TimeSeries[Number]" in diags[0].message and "CrossSection[Number]" in diags[0].message


def test_no_compat_diagnostic_when_input_port_missing() -> None:
    v = validate_strategy_semantics(build_wired_document(sink_in_port="nope"), build_fixture_registry())
    codes = {d.code for d in v.diagnostics}
    assert "unknown_input_port" in codes and "incompatible_port_types" not in codes


def test_no_compat_diagnostic_when_output_port_missing() -> None:
    v = validate_strategy_semantics(
        build_wired_document(source_out_port="nope"), build_fixture_registry()
    )
    codes = {d.code for d in v.diagnostics}
    assert "unknown_output_port" in codes and "incompatible_port_types" not in codes


def test_no_compat_diagnostic_when_source_node_unresolved() -> None:
    v = validate_strategy_semantics(build_unknown_source_document(), build_fixture_registry())
    codes = {d.code for d in v.diagnostics}
    assert "unknown_node_type" in codes and "incompatible_port_types" not in codes


def test_no_compat_diagnostic_for_component_endpoint() -> None:
    v = validate_strategy_semantics(build_component_edge_document(), build_fixture_registry())
    assert all(d.code != "incompatible_port_types" for d in v.diagnostics)
```

(The existing `test_reference_strategy_a/b_wiring_resolves` now also exercise compatibility — keep
them; they are the regression payoff.)

**Step 3:** Full gate:
```
./.venv/Scripts/python.exe -m pytest -q
./.venv/Scripts/python.exe -m ruff check .
./.venv/Scripts/python.exe -m ruff format --check .
./.venv/Scripts/python.exe -m mypy
./.venv/Scripts/python.exe -m quantize.codegen check
```
Expected: all green; reference strategies still clean.

**Step 4: Commit**
`git commit -m "test(validation): M2.3 compatibility integration + gating + regression"`

---

## Done criteria

- [ ] `compatibility.py` `is_compatible` (exact + one widening); table + value-equality tests.
- [ ] `INCOMPATIBLE_PORT_TYPES` constant; fifth check gated to both-resolved + both-ports-exist.
- [ ] Private total `_render_type`; semantic docstring updated.
- [ ] Incompatible edge detected; no-cascade on missing input/output port; no compat diag for unresolved/component endpoints.
- [ ] Reference strategies A and B stay `ok=True`.
- [ ] `pytest`/`ruff`/`ruff format`/`mypy` green; no `schema/`/`ts/`/codegen/dependency changes.

## Post-implementation

- Update `docs/LEARNING_LOG.md` with the M2.3 entry — **with founder approval**.
- Next: M2.4 (parameter validation) once `parameter_schema` is introduced, or M3 (graph evaluator — first founder hand-implementation).
