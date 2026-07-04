// Compile-time fixture proving the generated API declarations are *usable*, not merely emitted.
// `tsc --noEmit` (see tsconfig.json) type-checks this against ts/quantize-api.d.ts. It exercises:
// the node-catalog projection (typed ports via the PortType discriminated union, both the object
// and the `| null` shapes of `parameter_schema`, the lattice/compatibility tuples, and the
// envelope identity fields) plus the previously-uncompiled run-faithful `ValidateResponse`.
import type {
  NodeCatalogResponse,
  NodeTypeDto,
  ValidateResponse,
  JsonValue,
} from "../quantize-api";

// A verbatim Draft 2020-12 fragment survives as an opaque portable-JSON object (not `any`).
const rankSchema: { [k: string]: JsonValue } = {
  type: "object",
  properties: { descending: { type: "boolean", default: true } },
  additionalProperties: false,
};

// A node that declares a parameter schema — ports use the PortType `{ kind, dtype? }` union.
const rank: NodeTypeDto = {
  type_id: "transform.rank",
  type_version: "1.0.0",
  display_name: "Rank",
  description: "Cross-sectional rank.",
  inputs: [
    {
      name: "values",
      port_type: { kind: "CrossSection", dtype: "Number" },
      required: true,
    },
  ],
  outputs: [{ name: "values", port_type: { kind: "CrossSection", dtype: "Number" } }],
  parameter_schema: rankSchema,
};

// A node whose `parameter_schema` is the honest `null` branch (node declares none).
const sink: NodeTypeDto = {
  type_id: "portfolio.targets",
  type_version: "1.0.0",
  display_name: "Portfolio Targets",
  description: "Terminal portfolio-targets sink.",
  inputs: [
    { name: "targets", port_type: { kind: "PortfolioTargets" }, required: true },
  ],
  outputs: [],
  parameter_schema: null,
};

const catalog: NodeCatalogResponse = {
  api_version: "v1",
  schema_version: "0.1.0",
  catalog_digest: "0".repeat(64),
  port_types: [
    { port_type: { kind: "AssetSet" }, label: "AssetSet" },
    { port_type: { kind: "Scalar", dtype: "Integer" }, label: "Scalar[Integer]" },
    { port_type: { kind: "TimeSeries", dtype: "Number" }, label: "TimeSeries[Number]" },
  ],
  compatibility: [
    // The one non-identity widening in the v0 lattice: source (output) -> destination (input).
    {
      source: { kind: "Scalar", dtype: "Integer" },
      destination: { kind: "Scalar", dtype: "Number" },
    },
  ],
  node_types: [rank, sink],
};

// `ValidateResponse` was generated in M9 but never compiled until the API gate landed (M10.4).
const validation: ValidateResponse = {
  ok: true,
  structural: [],
  semantic: [],
  runtime: [],
  warmup_sessions: 20,
};

export const _smoke = { catalog, validation };
