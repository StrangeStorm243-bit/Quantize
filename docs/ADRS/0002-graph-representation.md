# ADR-0002: Graph (strategy) representation

- **Status:** Accepted (2026-06-23)
- **Related:** ADR-0001 (stack), STRATEGY_LANGUAGE.md

## Context

The strategy is a graph of nodes and edges. We must decide what is authoritative, how types are
attached to ports, how reusable subgraphs (components) are represented, and how the visual canvas
relates to all of it. The chief risks are (a) coupling the IR to the current UI/node set, and
(b) representing reuse as visual groups rather than real compositional objects.

## Decision

**A UI-independent, typed, versioned DAG IR is the source of truth; the canvas is an editor for it.**

1. **The persisted IR is authoritative.** Nodes carry `id`, `type`, `params`, and a `ui` object.
   `ui` is **preserved through round-trip** but **excluded from execution and semantic equality** —
   never discarded. Documents differing only in `ui.*` are semantically identical.
2. **Typed ports.** Every edge connects `(node, output_port) → (node, input_port)` and is valid
   only if a single central `is_compatible(out_type, in_type)` returns true. The type lattice and
   compatibility rules are specified in STRATEGY_LANGUAGE.md.
3. **DAG.** After component dependency resolution, the graph must be acyclic; cycles are a hard error.
4. **Node types via a registry,** never a giant switch. Each type declares a uniform contract
   (ports, params, purity, warm-up, validate, evaluate, trace schema).
5. **Components are standalone, first-class compositional objects** — each a separate immutable
   `ComponentDefinition` document (identity, immutable version, schema version, internal graph,
   exposed typed ports with internal-port mappings, exposed params with binding semantics,
   provenance). Strategies hold pinned `ComponentRef`s identifying a specific `(component_id,
   version)`. They are evaluated compositionally (never flattened, no stub expansion) and rejected on
   direct or transitive recursion. Embedded/exported bundles may inline dependencies for portability,
   but the standalone document + pinned reference is the primary persisted model.
6. **Two version axes:** `schema_version` (IR format) and `strategy.version` (monotonic per
   strategy id), with components versioned independently.

## Alternatives considered

- **Canvas-state-as-truth (serialize React Flow's model directly):** fastest to wire up, but
  couples the strategy to a specific UI library and node set, leaks `x/y` into semantics, and makes
  the runtime depend on a frontend artifact. **Rejected** — violates the core "IR is truth"
  invariant.
- **Untyped / string-typed ports:** simplest, but allows semantically wrong wires and gives custom
  nodes no contract. **Rejected** — the typed lattice (ADR scope of STRATEGY_LANGUAGE.md) is the
  whole defense against meaningless graphs.
- **Components as pure visual groups:** trivial to build, but cannot carry identity/version/
  provenance and cannot be reused or evaluated as objects. **Rejected** — it forecloses the future
  component ecosystem and is one of the hardest things to retrofit.
- **Flattening components at load time:** simpler engine, but destroys hierarchy in traces and
  breaks version pinning. **Rejected** — compositional evaluation preserves both.

## Consequences

- The editor (incl. React Flow) is replaceable without touching strategy meaning.
- Validation, planning, evaluation, and editor feedback all read one registry and one compatibility
  function — no divergence between "what connects" on the canvas vs. in the runtime.
- Components and versioning are honest from v0, so collaboration/marketplace can be layered on later
  without an IR rewrite.
- Cost: more upfront modeling (typed ports, registry, component objects) than a canvas dump. Accepted
  as the foundation the product vision rests on.
