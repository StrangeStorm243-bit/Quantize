// Compile-time fixture proving the generated types are *usable*, not merely emitted.
// `tsc --noEmit` (see tsconfig.json) type-checks this against ts/quantize-ir.d.ts. It exercises:
// both persisted roots, the registered/component node variants, recursive JSON params, the
// schedule and port-type discriminated unions, and the aliased fixed-length edge endpoints.
import type {
  QuantizeIR,
  StrategyDocument,
  ComponentDefinition,
  RegisteredNode,
  ComponentRefNode,
  Edge,
  JsonValue,
} from "../quantize-ir";

// Recursive JsonValue must accept arbitrarily nested portable JSON (not `any`).
const nestedParams: { [k: string]: JsonValue } = {
  window: 20,
  flags: [true, false, null],
  nested: { a: { b: [1, 2, { c: "deep" }] } },
};

// Ordinary registered node — requires `type_version`, has no `ref`.
const registered: RegisteredNode = {
  id: "rank1",
  type_id: "transform.rank",
  type_version: "1.0.0",
  params: nestedParams,
};

// Reserved component node — `type_id` is the literal "component", requires `ref`.
const componentNode: ComponentRefNode = {
  id: "comp1",
  type_id: "component",
  ref: "momentum_ref",
  params: {},
};

// Aliased edge endpoints are fixed two-element [string, string] tuples.
const edge: Edge = { from: ["rank1", "out"], to: ["comp1", "in"] };

const strategy: StrategyDocument = {
  schema_version: "0.1.0",
  strategy: {
    id: "11111111-1111-1111-1111-111111111111",
    version: 1,
    name: "Demo",
    provenance: {
      owner: "22222222-2222-2222-2222-222222222222",
      creator: "22222222-2222-2222-2222-222222222222",
      contributors: [],
      visibility: "private",
      duplicable: false,
      created_at: "2026-01-01T00:00:00Z",
    },
  },
  execution_policy: {
    policy: "close_signal_next_session_open",
    valuation: "session_close",
    transaction_costs: { model: "bps", bps: 5 },
  },
  schedule: { kind: "daily" },
  nodes: [registered, componentNode],
  edges: [edge],
  component_refs: [
    { id: "momentum_ref", component_id: "33333333-3333-3333-3333-333333333333", version: "1.0.0" },
  ],
};

const component: ComponentDefinition = {
  component_id: "33333333-3333-3333-3333-333333333333",
  version: "1.0.0",
  schema_version: "0.1.0",
  name: "Momentum",
  component_refs: [],
  implementation: { kind: "graph", graph: { nodes: [registered], edges: [] } },
  exposed_inputs: [],
  // Port-type discriminated union; OrderList is intentionally not constructible.
  exposed_outputs: [
    { name: "signal", type: { kind: "CrossSection", dtype: "Number" }, maps_to: ["rank1", "out"] },
  ],
  exposed_params: [{ name: "window", binds_to: ["rank1", "window"], schema: { type: "integer" } }],
  provenance: {
    owner: "22222222-2222-2222-2222-222222222222",
    creator: "22222222-2222-2222-2222-222222222222",
    contributors: [],
    visibility: "private",
    duplicable: false,
    created_at: "2026-01-01T00:00:00Z",
  },
};

// Top-level persisted-document union accepts either root.
const docs: QuantizeIR[] = [strategy, component];

// Discriminate the node union on the reserved `type_id` literal.
function isComponentNode(n: RegisteredNode | ComponentRefNode): n is ComponentRefNode {
  return n.type_id === "component";
}

export const _smoke = { docs, edge, isComponentNode };
