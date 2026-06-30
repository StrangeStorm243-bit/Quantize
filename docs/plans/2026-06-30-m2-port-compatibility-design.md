# M2.3 Design — Port-Type Compatibility (the single shared `is_compatible`)

**Status:** Approved (brainstorming) — 2026-06-30. Implementation plan to follow (writing-plans).
**Scope:** The third M2 slice. Add the single, central `is_compatible` function and a fifth semantic
check that rejects edges whose port *types* are incompatible. **No parameter validation (M2.4), no
component resolution (M3); no new validator entry point.**

Normative context: `docs/STRATEGY_LANGUAGE.md` §2 (type lattice + compatibility rules + "the one
compatibility function"); supports invariants **4** (single source of truth for types), **5**
(frontend has no business logic — the editor must consume this via API/metadata, never reimplement
it), and **7** (uniform contract). Builds on M2.2 (`quantize/validation/semantic.py`) and M2.1
(`quantize/registry`).

---

## 1. Objective

M2.2 checks that an edge's port *names* exist. M2.3 adds the missing half: that the source output
port *type* is compatible with the destination input port *type*. Compatibility is decided in **one**
place — `is_compatible` — so the graph validator and the future editor give identical verdicts and
cannot drift.

This module **supports** the single-shared-compatibility-function rule from `STRATEGY_LANGUAGE.md §2`
(and thereby invariants 4/5/7). It is **not** itself "invariant 5"; it is the Python home that lets
the frontend stay logic-free.

---

## 2. The `is_compatible` function

**Module:** `quantize/compatibility.py` — central, shared domain logic. The M2.3 validator imports it;
the M10 editor API will expose it later. (Not under `validation/` — it is not validation-specific;
not in `schema/types.py` — that stays pure data definitions.)

**Signature (minimal boolean; a richer result is deferred until a consumer needs structured reasons):**
```python
def is_compatible(source: PortType, destination: PortType) -> bool:
    """True iff an edge from a `source` (output) port type to a `destination` (input) port type is
    allowed. Arguments follow edge direction: output -> input."""
    if source == destination:            # exact match (PortType is a frozen, value-equal model)
        return True
    # the ONE explicit widening: Scalar[Integer] -> Scalar[Number]
    return (
        isinstance(source, ScalarType)
        and source.dtype == "Integer"
        and isinstance(destination, ScalarType)
        and destination.dtype == "Number"
    )
```

**Allow-list, not deny-list.** Only *exact match* and *the one widening* are allowed; everything else
falls through to `False`. The spec's "no implicit meaning changes" cases are not special-cased — they
are simply neither exact nor the widening:

| source → destination | result | why |
|---|---|---|
| any `T` → same `T` | ✅ | exact |
| `Scalar[Integer]` → `Scalar[Number]` | ✅ | the one widening |
| `Scalar[Number]` → `Scalar[Integer]` | ❌ | narrowing not allowed |
| `CrossSection[Number]` → `CrossSection[Boolean]` | ❌ | dtype differs |
| `TimeSeries[Number]` → `CrossSection[Number]` | ❌ | collapse needs a transform node |
| `CrossSection[Boolean]` → `AssetSet` | ❌ | a mask is not a universe |
| `CrossSection[Number]` → `PortfolioTargets` | ❌ | weighting needs a node |
| `PortfolioTargets` → `CrossSection[Number]` / `Scalar` | ❌ | a portfolio is not generic numbers |

`OrderList` cannot appear — it is not a constructible `PortType`.

**Exact match relies on value equality:** `PortType`'s variants are frozen Pydantic models with
value-based `__eq__`, so two independently constructed `CrossSectionType(kind="CrossSection",
dtype="Number")` are equal. A test asserts this directly (the rule depends on it).

---

## 3. Validator integration — the fifth check

Extends `validate_strategy_semantics` (no new entry point). The M2.2 name-sets become name→type maps
so the check can read port types:

```python
output_ports = {nid: {p.name: p.port_type for p in desc.outputs} for nid, desc in resolved.items()}
input_ports  = {nid: {p.name: p.port_type for p in desc.inputs}  for nid, desc in resolved.items()}
```

Inside the existing edge loop, **after** the port-name existence checks:

```python
    if (
        src_outputs is not None and src_port in src_outputs
        and dst_inputs is not None and dst_port in dst_inputs
        and not is_compatible(src_outputs[src_port], dst_inputs[dst_port])
    ):
        diagnostics.append(
            SemanticDiagnostic(
                INCOMPATIBLE_PORT_TYPES,
                f"port type {_render_type(source)} from {src_id!r}.{src_port!r} is not compatible "
                f"with {_render_type(destination)} at {dst_id!r}.{dst_port!r}",
                ("edges", index),
                dst_port,
            )
        )
```

**Gating (the crux): emit `incompatible_port_types` ONLY when both endpoints resolved AND both named
ports exist.** Consequences:
- a **missing port** → `unknown_output_port` / `unknown_input_port` only, never *also*
  `incompatible_port_types` (you can't judge the compatibility of a port that doesn't exist);
- an **unresolved ordinary node** (unknown type / version unavailable) → no `incompatible_port_types`;
- a **component / unresolved endpoint** → skipped (no type to compare; M3).
The membership re-test in the `if` also narrows the `Optional` maps for mypy (no `assert`).

**Diagnostic:** new constant `INCOMPATIBLE_PORT_TYPES = "incompatible_port_types"` in `errors.py`;
`loc=("edges", i)`; `subject=dst_port` (the input that cannot accept the source). The message names
**both** endpoint ids/ports **and** both rendered types.

**`_render_type`** — a private helper in `semantic.py`, **total** over the current `PortType`
variants: `Scalar[dtype]`, `CrossSection[dtype]`, `TimeSeries[dtype]`, `AssetSet`, `PortfolioTargets`
(dtype-bearing kinds render `Kind[Dtype]`; the others render `Kind`).

**Docstring:** update `semantic.py`'s module docstring — M2.2 listed port-type compatibility as out of
scope; M2.3 moves it in-scope (parameters and component resolution remain deferred).

---

## 4. Testing

### `tests/test_compatibility.py` (the table)
- exact match ✅; `Scalar[Integer]→Scalar[Number]` ✅; `Scalar[Number]→Scalar[Integer]` ❌;
  `CrossSection[Number]→CrossSection[Boolean]` ❌; `TimeSeries[Number]→CrossSection[Number]` ❌;
  `CrossSection[Boolean]→AssetSet` ❌; `CrossSection[Number]→PortfolioTargets` ❌;
  `PortfolioTargets→CrossSection[Number]` ❌.
- **value equality:** independently constructed identical `PortType` instances compare equal.

### `tests/test_semantic_validation.py` (integration)
- **Incompatible edge:** add a `test.tsource@1.0.0` descriptor (output `out: TimeSeries[Number]`) to
  the fixture registry + `build_incompatible_document()` wiring `test.tsource.out → test.sink.in`
  (`CrossSection[Number]`) → emits `incompatible_port_types`; message contains both rendered types.
- **Gating — no cascade on bad input port:** `build_wired_document(sink_in_port="nope")` →
  `unknown_input_port`, **no** `incompatible_port_types`.
- **Gating — no cascade on bad output port (symmetric):** `build_wired_document(source_out_port="nope")`
  → `unknown_output_port`, **no** `incompatible_port_types`.
- **Gating — unresolved ordinary node:** unknown source type → `unknown_node_type`, **no**
  `incompatible_port_types`.
- **Gating — component endpoint:** the component-edge document produces **no** `incompatible_port_types`.
- **Regression (the payoff):** `test_reference_strategy_a/b_wiring_resolves` stay `ok=True` — now also
  exercising compatibility, confirming both committed wirings are type-correct end to end.
- `_render_type` totality is covered (directly or via message assertions) across all five variants.

---

## 5. Acceptance criteria (M2.3 done when)
- `quantize/compatibility.py`: `is_compatible(source, destination) -> bool` (exact + the one widening);
  documented table; value-equality test.
- `semantic.py`: fifth check, gated to *both endpoints resolved AND both ports exist*; private total
  `_render_type`; updated module docstring.
- `errors.py`: `INCOMPATIBLE_PORT_TYPES` constant.
- Both reference strategies remain `ok=True` under the (now type-accurate) reference registry.
- `pytest` · `ruff check .` · `ruff format --check .` · `mypy` all green.
- **No** `schema/`, `ts/`, codegen, dependency, or persisted-IR changes.

## 6. Explicit M2.3 exclusions
No parameter validation (M2.4); no component resolution (M3); no richer `Compatibility` result type
(deferred until a structured-reason consumer exists); no new validator entry point; no codegen /
`schema/` / `ts/` / dependency changes.
