# M10 — Registry-Descriptor + Parameter-Form Metadata API — Implementation Plan (2026-07-03)

> Plan-of-record for M10, authored by the planning session (no production code written).
> **For the implementer (Opus):** execute the Implementation slices IN ORDER as bounded packets;
> each packet is test-first, independently green, and must not begin before the previous packet's
> definition of done is met. Contract decisions in this document are RESOLVED — do not re-derive
> them; stop conditions list the only open items. Companion packet file (standalone, compact):
> `docs/plans/2026-07-03-m10-opus-packets.md` (this plan is authoritative on any disagreement).

## Purpose & definition of done

M10 gives the (future, M11) editor everything it needs to render nodes and parameters **before**
the editor exists (MVP_PLAN.md:240-250): one governed endpoint exposing, per registered node
type — ports (names/types), parameter schema + defaults, description — plus compatibility
metadata derived from the single `is_compatible` function. The endpoint is a pure projection of
the existing registry: **no business logic, no persistence, no migration, no engine change**.
The registry-descriptor model was deliberately built for this in M2 ("its API surface ships in
M10", MVP_PLAN.md:94-95; "consumed later by the M10 editor API",
`quantize/registry/descriptor.py:42`).

**Done means:**
- `GET /v1/node-types` returns the full node catalog envelope of §Contracts: all registered
  `(type_id, type_version)` entries with ports, metadata, and verbatim `parameter_schema`; the
  closed port-type lattice with server-rendered labels; and the compatibility allow-list derived
  at request time from `is_compatible` — proven equivalent to the function by test.
- The response DTOs are codegen-governed: appended to `_API_ROOT_MODELS`, regenerated
  `schema/quantize-api.schema.json` + `ts/quantize-api.d.ts` committed, contract tests extended,
  IR artifacts byte-unchanged. No hand-maintained TS; no OpenAPI export.
- Descriptor payloads are derived per request from `build_core_catalog()` — never persisted,
  never cached server-side (the MVP risk mitigation "generate descriptors from the registry",
  MVP_PLAN.md:249-250).
- A committed golden pins the full catalog body so any registry change is a reviewed diff.
- `ts/quantize-api.d.ts` is compile-gated (pre-existing gap closed): added to `tsconfig.json`
  `files` with a small usage fixture.
- Both gates green (`./scripts/gate.ps1`, `bash scripts/gate.sh`); existing 847 tests
  untouched-and-green; CLAUDE.md endpoint note + LEARNING_LOG M10 entry written.

## Authoritative inputs

`docs/MVP_PLAN.md:240-250` (§M10 verbatim scope; §M11:254-265 and §M12:269-278 boundaries —
M10 must NOT consume them); `docs/STRATEGY_LANGUAGE.md:104-134,186-188` (type lattice, the
"one compatibility function" + compatibility-table contract); `docs/ARCHITECTURE.md:140-143`
("Validator, planner, evaluator, and the editor's descriptor endpoint all read the registry")
and §7 (preserved future boundaries); ADR-0001 (source-of-truth hierarchy, codegen gates),
ADR-0002 (registry + single `is_compatible`), ADR-0005 (`OrderList` never a port type);
CLAUDE.md/AGENTS.md invariants (esp. 4/5/6/7); `docs/plans/2026-07-03-m9-implementation-plan.md`
(the additive-endpoint + DTO-freeze discipline this plan copies).

### Ratified decisions — DO NOT REOPEN

(a) **One endpoint**: `GET /v1/node-types` returning the whole catalog in one envelope. No
per-type endpoint, no compatibility-query endpoint, no pagination, no ETag/conditional requests
(the payload is ~tens of KB; the M11 editor fetches it once per session).
(b) **Compatibility metadata = derived data, not logic**: the closed 8-member port-type lattice
(each with a server-rendered `label`) plus the directional allow-list of compatible
`(source, destination)` pairs, enumerated at request time by calling `is_compatible` over the
lattice's cartesian product. `is_compatible` keeps its `bool` signature; no reason-code taxonomy
(the editor composes the rejection reason from the two structured types + labels; the
STRATEGY_LANGUAGE.md:131 `-> Result` form is a documented doc-code gap, not M10 work).
(c) **Parameter-form metadata = the verbatim JSON Schema fragment** each node already declares
(`JsonSchemaSpec`), exposed as an opaque JSON object. Defaults live ONLY in the schema's
`default` keyword — no parallel defaults field, no bespoke form-field DTO (a flat field list is
already broken today by `portfolio.fixed_weight`'s `oneOf` and `universe.fixed_list`'s array).
A keyword-subset guard test governs what the emitter may use; clients are promised "a
self-contained Draft 2020-12 JSON Schema document", not a keyword list.
(d) **Envelope identity**: `api_version`, `schema_version`, and `catalog_digest` (sha256 of the
canonical catalog body, recipe in §Contracts). `MetaResponse` and all other M9 DTOs are NOT
reshaped or extended.
(e) **Derivation, never persistence**: the route builds a fresh `build_core_catalog()` per
request (the `routes/validate.py` pattern) and projects descriptors directly. No DB handle, no
migration, no module-level singleton.
(f) **Codegen**: new DTO module rides the existing API bundle (append roots to
`_API_ROOT_MODELS`); no third `BundleSpec`; no committed OpenAPI; `PortType` and its variants
are REUSED from `quantize/schema/types.py` — never redeclared.
(g) **Excluded from the payload** (each with its owning seam): `purity`/`warmup`
(implementation-side; warm-up is a function of params — the per-document answer already ships
via `ValidateResponse.warmup_sessions`); `trace_schema`/`trace_events` (trace rendering consumes
stored `TraceResponse` payloads; additive descriptor fields later if a concrete M11 need
appears); categories/grouping/icons/i18n/UI hints (presentation; `type_id` namespace prefix
already partitions a palette; instance layout lives in `ui.*`, which this API never mentions);
component descriptors (M12 — `ComponentDefinition` already self-describes via
`exposed_inputs/outputs/params` and is served by `/v1/components`); variadic-port metadata
(no documented need; ports-as-lists keeps the door open for free).
(h) **Enumeration seam**: add `ImplementationCatalog.descriptors()` (concrete, additive,
delegating to its internal `NodeRegistry.descriptors()`). Do NOT widen the `NodeRegistryView`
Protocol — structural test fakes elsewhere would be forced to grow the method.
(i) **`JsonSchemaSpec` accessor**: add a read-only `document` property returning a deep copy of
the held schema. The raw dict is currently locked inside the private validator
(`schema_spec.py:62-69`) — this is the one genuine enabling change in `registry/`.

## Scope

- `quantize/registry/schema_spec.py` — `document` accessor (deep copy) on `JsonSchemaSpec`.
- `quantize/runtime/binding.py` — additive `ImplementationCatalog.descriptors()`.
- `quantize/schema/types.py` — `render_port_type()` hoisted from
  `quantize/validation/semantic.py:_render_type` (semantic.py imports it; messages unchanged).
- `quantize/registry/export.py` — NEW: the pure derivation primitives (pinned lattice
  enumeration, `compatible_pairs()`, `catalog_digest()`).
- `quantize/api/dto/catalog.py` — NEW: the governed catalog DTOs.
- `quantize/codegen/schema.py` — append the new root to `_API_ROOT_MODELS`; regenerate + commit
  `schema/quantize-api.schema.json`, `ts/quantize-api.d.ts`.
- `quantize/api/version.py` — NEW: home of `API_VERSION` (moved from `app.py` to avoid a
  route→app circular import; `app.py` re-imports it).
- `quantize/api/routes/catalog.py` — NEW: `GET /v1/node-types`; wired in `quantize/api/app.py`.
- `tsconfig.json` + `ts/fixtures/api-usage.ts` — NEW compile gate for the API declarations.
- Tests: `tests/test_registry_export.py`, `tests/test_schema_spec.py` (extend),
  `tests/api/test_catalog_endpoint.py`, `tests/api/test_api_contract.py` (extend),
  `tests/api/test_hardening.py` (endpoint set), `tests/goldens/node_catalog.json` (NEW golden).
- Docs: CLAUDE.md (one endpoint line), `docs/LEARNING_LOG.md` M10 entry, this plan's closeout.

## Exclusions (with owning milestone)

- Any frontend/React/React Flow/editor code, CORS policy → **M11** (MVP_PLAN:254-265; CORS
  arrives scoped with the editor, never a blanket `*` now).
- Component authoring/extraction UI; component palette entries → **M12** (MVP_PLAN:269-278;
  the data already flows from `/v1/components`).
- Replay-verification endpoint (`POST /v1/runs/{run_id}/verify`) → still-deferred M9.9
  (founder decision #3).
- Structured cycle-membership field on `graph_cycle`/`component_cycle` diagnostics → M11 backend
  slice, only if full-cycle highlighting becomes an acceptance criterion (additive one-field
  change; today's `loc`+`subject` suffice for the roadmap's editor).
- Curated per-pair incompatibility reason strings; `is_compatible -> Result` → deferred until a
  concrete UX need; would be authored in Python next to `is_compatible`, never in TS.
- `$ref`-bearing parameter schemas (recursive formula ASTs) → deferred; the v0 self-contained
  restriction stays an EMITTER restriction (schema_spec docstring), not a client-visible promise.
- Registry versioning beyond `(type_id, type_version)` + `catalog_digest`; per-tenant registries;
  caching layers → deferred (stateless request-time derivation is already multi-user-safe).
- Auth/users/Postgres/async/workers/deployment → unchanged M9 exclusions.

## Contracts & invariants

### Endpoint (under the `/v1` prefix; joins the exact-set test in `tests/api/test_hardening.py:71-86`)

| Method | Path | Request | Response | Status |
|---|---|---|---|---|
| GET | `/v1/node-types` | — | `NodeCatalogResponse` | 200 always (no DB, no body; the only failure mode is a 500 bug) |

Handler: synchronous `def`, no DB, builds `build_core_catalog()` per request, pure projection
(copy `quantize/api/routes/validate.py`'s posture). GET-only → the POST body-cap/depth-bomb
sweeps in `test_hardening.py` are unaffected.

### DTO shapes (module `quantize/api/dto/catalog.py`, all on `_Dto` — frozen/extra=forbid/strict)

```jsonc
// GET /v1/node-types → 200
{
  "api_version": "v1",              // quantize.api.version.API_VERSION (NEW module — see M10.3;
                                    // importing it from app.py would be circular: app.py imports
                                    // route modules BEFORE binding the constant, app.py:23 vs :29)
  "schema_version": "0.1.0",        // quantize.schema.version.CURRENT_SCHEMA_VERSION
  "catalog_digest": "<64 lowercase hex>",   // sha256 of the canonical catalog body (below)
  "port_types": [                   // the closed lattice — EXACTLY 8 entries, pinned order
    { "port_type": { "kind": "AssetSet" },                        "label": "AssetSet" },
    { "port_type": { "kind": "CrossSection", "dtype": "Boolean" }, "label": "CrossSection[Boolean]" },
    { "port_type": { "kind": "CrossSection", "dtype": "Number" },  "label": "CrossSection[Number]" },
    { "port_type": { "kind": "PortfolioTargets" },                 "label": "PortfolioTargets" },
    { "port_type": { "kind": "Scalar", "dtype": "Boolean" },       "label": "Scalar[Boolean]" },
    { "port_type": { "kind": "Scalar", "dtype": "Integer" },       "label": "Scalar[Integer]" },
    { "port_type": { "kind": "Scalar", "dtype": "Number" },        "label": "Scalar[Number]" },
    { "port_type": { "kind": "TimeSeries", "dtype": "Number" },    "label": "TimeSeries[Number]" }
  ],
  "compatibility": [                // directional allow-list: source (output) → destination (input)
    { "source": { "kind": "AssetSet" }, "destination": { "kind": "AssetSet" } }
    // ... 8 identity pairs + the 1 Scalar[Integer]→Scalar[Number] widening = 9 entries,
    // in lattice order, source-major (the widening therefore lands mid-list, NOT first).
    // Derive from the §Ordering rules, never from this illustrative snippet.
  ],
  "node_types": [                   // one entry per registered (type_id, type_version), sorted
    {
      "type_id": "transform.rank",
      "type_version": "1.0.0",
      "display_name": "Rank",
      "description": "…from NodeMetadata.description…",
      "inputs":  [ { "name": "values", "port_type": { "kind": "CrossSection", "dtype": "Number" }, "required": true } ],
      "outputs": [ { "name": "values", "port_type": { "kind": "CrossSection", "dtype": "Number" } } ],
      "parameter_schema": { "type": "object", "properties": { "descending": { "type": "boolean", "default": true } }, "additionalProperties": false }
      // verbatim Draft 2020-12 fragment via JsonSchemaSpec.document; null = node declares none.
      // NOTE: all 13 v0 nodes declare a schema (some empty-object), so the null branch is
      // exercised only by the M10.2 representative-sample test, never by the live catalog.
    }
  ]
}
```

Pydantic models (names follow M9 conventions — `*Dto` on nested members, `*Response` on the root;
tuples for sequences, matching M9 DTOs):

- `PortTypeEntryDto { port_type: PortType, label: str }`
- `CompatibilityPairDto { source: PortType, destination: PortType }`
- `CatalogInputPortDto { name: str, port_type: PortType, required: bool }`
- `CatalogOutputPortDto { name: str, port_type: PortType }`
- `NodeTypeDto { type_id: str, type_version: str, display_name: str, description: str,
  inputs: tuple[CatalogInputPortDto, ...], outputs: tuple[CatalogOutputPortDto, ...],
  parameter_schema: JsonObject | None }`
- `NodeCatalogResponse { api_version: str, schema_version: str, catalog_digest: str,
  port_types: tuple[PortTypeEntryDto, ...], compatibility: tuple[CompatibilityPairDto, ...],
  node_types: tuple[NodeTypeDto, ...] }`

Only `NodeCatalogResponse` joins `_API_ROOT_MODELS` (nested models are pulled into `$defs` by
reference, the established pattern). `PortType` is imported from `quantize/schema/types.py` —
its variant models will appear in the API bundle `$defs` for the first time; that duplication
across the two `.d.ts` files mirrors the accepted `JsonValue` precedent.

### Ordering, digest, and derivation rules (normative)

- **Lattice order**: the literal 8-tuple above (sort key `(kind, dtype or "")` — dtype-less
  kinds sort by kind alone), pinned in
  `quantize/registry/export.py` as `PORT_TYPE_LATTICE`. A closure test derives the full variant
  set from the `PortType` union's type annotations (`typing.get_args` over each variant's `kind`/
  `dtype` Literals) and asserts equality — a future `Matrix` registration fails loud there.
- **Compatibility order**: iterate `PORT_TYPE_LATTICE` source-major, destination-minor; include
  a pair iff `is_compatible(source, destination)`. v0 yields exactly 9 pairs.
- **Node order**: `build_core_catalog().descriptors()` — already sorted by
  `(type_id, type_version)` (`registry.py:124-125`). v0 yields exactly 13 entries.
- **`label`**: `render_port_type(port_type)` — the hoisted `_render_type` (semantic.py:33-36),
  so editor badge text matches server diagnostic text character-for-character.
- **`catalog_digest`**: over the canonical *body* — the JSON object
  `{"compatibility": [...], "node_types": [...], "port_types": [...]}` exactly as produced by
  `model_dump(mode="json", by_alias=True)` of the three tuples (i.e., what crosses the wire),
  digested as
  `hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()`.
  Implemented as a pure function `catalog_digest(body: JsonObject) -> str` in `export.py`
  (portable-JSON in, hex out — no DTO imports in the registry layer). `api_version`,
  `schema_version`, and the digest itself are excluded from the digested body.
- **Parameter-schema emitter discipline**: every registered `parameter_schema` may use only the
  documented keyword subset — `type, properties, required, additionalProperties, minimum,
  exclusiveMinimum, maximum, minLength, minItems, uniqueItems, items, oneOf, const, default` —
  enforced by a recursive-walk guard test (extending the renderer subset later is a deliberate,
  reviewed act). Verify the set against the actual inventory when writing the test; if a keyword
  is found outside this list, STOP and record it (do not silently widen).

### Standing invariants

- IR bundle artifacts (`schema/quantize.schema.json`, `ts/quantize-ir.d.ts`) byte-unchanged
  (test-enforced by `test_ir_bundle_unchanged_by_api_packet`).
- No M9 DTO reshaped; the API bundle grows additively only.
- `quantize/api/` stays free of pandas/numpy (swept by `test_api_layer_has_no_numerics`) and of
  business logic — the compatibility DATA is derived by calling the domain function, never by
  re-encoding its rule.
- `OrderList` never appears in the payload (structurally impossible: `PortType` excludes it).
- Existing goldens untouched; the ONLY new golden is `tests/goldens/node_catalog.json`.

## Unresolved decisions

None blocking. Two founder flip-points, each a one-line change if vetoed at review:
1. Endpoint path `/v1/node-types` (alternative considered: `/v1/registry/nodes`).
2. `catalog_digest` inclusion (drop the field + its tests if the founder deems it premature;
   the golden still provides the reviewed-diff guarantee).

## Implementation slices (execution packets for Opus — strictly in order)

Every packet: TDD (tests written and watched failing first), `ruff check`/`ruff format`, `mypy`,
full `pytest`, and BOTH gates green before "done". No packet touches engine numerics, node
semantics, persisted formats, migrations, or existing goldens. Branch: `feat/m10-descriptor-api`
off **`origin/main`** (`7d2d0dc`) — run `git fetch origin` first; the LOCAL `main` ref may be
stale/behind (it was 12 commits behind at plan time — branching off local `main` yields a tree
with no API layer). One commit per packet, messages `M10.x: <summary>`.

### M10.1 — Registry export primitives (pure domain; no API)
Files: modify `quantize/registry/schema_spec.py` (add `document` property → deep copy of the
held schema. **mypy trap:** `jsonschema` is typed via `ignore_missing_imports`, so
`self._validator.schema` reveals as `Any` and returning it fails strict mypy (`warn_return_any`).
Keep the constructor's `owned` dict in a second slot instead: `__slots__ = ("_schema",
"_validator")`, `self._schema = owned`, and `document` returns `deepcopy(self._schema)` typed as
`JsonObject`), `quantize/runtime/binding.py` (add
`ImplementationCatalog.descriptors()` delegating to `self._descriptors.descriptors()`),
`quantize/schema/types.py` (add `render_port_type(port_type: PortType) -> str`, moved verbatim
from `quantize/validation/semantic.py:_render_type`), `quantize/validation/semantic.py` (import
and use it; delete the local copy); create `quantize/registry/export.py`
(`PORT_TYPE_LATTICE: tuple[PortType, ...]` — the pinned 8; `compatible_pairs() ->
tuple[tuple[PortType, PortType], ...]`; `catalog_digest(body: JsonObject) -> str`); create
`tests/test_registry_export.py`; extend `tests/test_schema_spec.py`.
Tests-first:
(1) `document` returns the constructed schema dict and mutating the returned dict does not
    affect a subsequent `errors()` call or a second `document` read;
(2) lattice closure — the set derived from `PortType` variant annotations == the pinned 8;
    order is the documented canonical order;
(3) `compatible_pairs()` == direct `is_compatible` enumeration over lattice × lattice (the
    derived-not-duplicated proof), and equals exactly 8 identity pairs + Integer→Number;
(4) digest — stable across two calls on equal bodies; differs when one node description
    character changes; 64 lowercase hex;
(5) `ImplementationCatalog.descriptors()` returns 13 descriptors sorted by
    `(type_id, type_version)`, equal to `[impl.descriptor for impl in implementations()]`
    (note: the underlying sort is plain lexical tuple sort — do NOT assert semver ordering of
    versions; v0 is all `1.0.0` so the distinction is moot here);
(6) parameter-schema keyword guard — walk every registered descriptor's
    `parameter_schema.document`, collected KEYWORDS ⊆ the documented subset. **Walk rule (do
    not naive-recurse over all dict keys):** the keys of the object under `"properties"` are
    parameter NAMES (`n`, `max`, `tickers`, `window`, …), not keywords — collect only schema
    keys, recursing into each property's VALUE, into the `"items"` value, and into each
    `"oneOf"` member. With that rule the current inventory collects exactly the documented
    subset (verified at plan time); a naive walk false-positives on `max` and STOPs wrongly;
(7) all existing semantic-validation tests green UNCHANGED (the `_render_type` hoist must not
    change a single message).
DoD: gates green; no `quantize/api/` change; codegen artifacts untouched.
Stop: any existing test needs modification (the hoist changed behavior); any keyword outside the
documented subset (record it, get founder ack, then widen the documented set deliberately).

### M10.2 — Catalog DTOs + API codegen bundle growth (freeze)
Files: create `quantize/api/dto/catalog.py` (the six models of §Contracts, fastapi-free, on
`_Dto`); modify `quantize/codegen/schema.py` (append `(NodeCatalogResponse, "serialization")` to
`_API_ROOT_MODELS`); run `./scripts/node24.ps1` then
`.venv/Scripts/python.exe -m quantize.codegen generate` and
commit the regenerated `schema/quantize-api.schema.json` + `ts/quantize-api.d.ts`; extend
`tests/api/test_api_contract.py` (`_SAMPLES` entry for `NodeCatalogResponse` — a small
representative instance with TWO `node_types` entries: the first with a non-null
`parameter_schema` carrying a `default`, the second with `parameter_schema=None` (the live
catalog never exercises the null branch — all 13 nodes declare a schema); plus two port-type
entries and one compatibility pair; extend the forbid-unknown-fields and
TS-interface-presence lists).
Tests-first: the representative payload validates against the COMMITTED API schema via the
independent `jsonschema` validator; `additionalProperties: false` on the new defs;
`export interface NodeCatalogResponse` (and `NodeTypeDto`) present in the committed `.d.ts`;
`test_ir_bundle_unchanged_by_api_packet` green unmodified; codegen determinism tests green
(they re-assert automatically over the grown bundle).
DoD: `python -m quantize.codegen check` clean; gates green. This packet FREEZES the M10 DTO
shapes — M10.3/M10.4 may not add or reshape DTO fields; a discovered missing field is a STOP
(return here deliberately, regenerate, record the change).
Stop: any byte change to the committed IR artifacts; any M9 `$defs` shape change.

### M10.3 — `GET /v1/node-types` endpoint + golden
Files: create `quantize/api/version.py` (`API_VERSION = "v1"` moved out of `app.py` — `app.py`
imports route modules at line 23 BEFORE binding the constant at line 29, so a route importing
`API_VERSION` from `app.py` hits a partially-initialized module; `app.py` switches to importing
it from the new module — only `app.py` references it today, verified by grep); create
`quantize/api/routes/catalog.py` (router `prefix="/v1"`, sync handler assembling
`NodeCatalogResponse` from `build_core_catalog().descriptors()` + `PORT_TYPE_LATTICE` +
`compatible_pairs()` + `render_port_type` + `catalog_digest`; `parameter_schema` via
`JsonSchemaSpec.document`, `None` passed through); modify `quantize/api/app.py` (include the
router); update `tests/api/test_hardening.py:71-86` (add `/v1/node-types` — same commit);
create `tests/api/test_catalog_endpoint.py`; create golden `tests/goldens/node_catalog.json`
via `golden_utils.assert_summary_matches_golden` (summary = the parsed full response body).
Tests-first:
(1) 200 with exactly 13 `node_types` sorted by `(type_id, type_version)`; 8 `port_types`;
    9 `compatibility` pairs;
(2) hand-pinned entry check — `transform.rank`: display_name "Rank", input/output port shapes,
    `parameter_schema.properties.descending.default is True` (pins the "defaults" promise);
(3) hand-pinned `portfolio.fixed_weight` entry carries the `oneOf` verbatim (pins the
    non-scalar ceiling);
(4) endpoint compatibility list == `is_compatible` enumeration (API-level parity);
(5) `catalog_digest` recomputes from the response's own body per the §Contracts recipe;
    two GETs return byte-identical `response.content`;
(6) full response validates against the committed `schema/quantize-api.schema.json`
    (independent `jsonschema` validator);
(7) `api_version`/`schema_version` equal the module constants (the `test_meta.py` pattern);
(8) golden comparison (update path documented: `pytest --update-goldens` + reviewed diff).
DoD: gates green; endpoint-set test updated in the same commit.
Stop: standing stop conditions (any engine-touching change, any movement in a pre-existing
golden).

### M10.4 — API TS compile gate + hardening + closeout
Files: create `ts/fixtures/api-usage.ts` (imports and exercises `NodeCatalogResponse`,
`NodeTypeDto`, `ValidateResponse` — a compile fixture mirroring `ts/fixtures/usage.ts`,
including its EXTENSIONLESS import form: `from "../quantize-api"`, not a `.d.ts` path); modify
`tsconfig.json` `files` (add `ts/quantize-api.d.ts`,
`ts/fixtures/api-usage.ts`); docs: CLAUDE.md (add the endpoint to the M9 run/API notes),
`docs/LEARNING_LOG.md` M10 entry (concepts: derived contracts vs. sources of truth, content
hashing as identity, closed type lattices; reading path: `descriptor.py` → `export.py` →
`dto/catalog.py` → `routes/catalog.py`; by-hand exercise: add a hypothetical
`Scalar[Boolean] → CrossSection[Boolean]` widening in a scratch branch, predict which THREE
tests fail — matrix parity, golden, endpoint pair count — then verify and discard); closeout
section appended to this plan.
Tests-first: `npm run typecheck` (under Node 24) proving the API declarations compile strictly;
final full-matrix run of both gates.
DoD: BOTH gates green end-to-end; AGENTS.md review checklist passes on the full diff;
self-review areas below executed.
Stop: if adding `ts/quantize-api.d.ts` to `files` surfaces PRE-EXISTING compile errors in the
M9-generated declarations (unlikely — a trial compile at plan time was clean), do not patch
generated files by hand — report the errors and HALT: this is a MILESTONE stop, not a skip. The
compile gate is part of M10's definition of done, so M10 is NOT done until the founder decides
(fix the generator, or explicitly demote the gate out of M10's DoD in a recorded amendment).

## Test blueprint

New files: `tests/test_registry_export.py`, `tests/api/test_catalog_endpoint.py`,
`tests/goldens/node_catalog.json`, `ts/fixtures/api-usage.ts`.
Extended: `tests/test_schema_spec.py`, `tests/api/test_api_contract.py`,
`tests/api/test_hardening.py`.
Conventions: module docstrings `"""M10.x: ..."""`; module-scoped `TestClient` from
`tests/api/conftest.py` (no `db` fixture — the endpoint has no DB); exact-body/field assertions
on codes and structures, never on message prose; goldens via `golden_utils`; no network; mypy
strict covers new tests.

## Stop conditions (standing, all packets)

- Any byte change to `schema/quantize.schema.json` or `ts/quantize-ir.d.ts`.
- Any change to engine/evaluator/node semantics, persisted formats, or migrations.
- Any movement in a pre-existing golden.
- Any M9 DTO field addition/reshape (including `MetaResponse`).
- Any need to hand-edit a generated artifact.
- Any parameter-schema keyword outside the documented subset.

## Verification

Per packet and at milestone end: `./scripts/gate.ps1` AND `bash scripts/gate.sh` (pytest → ruff
check → format check → mypy → Node-24 activation → `codegen check` → `npm run typecheck`),
run from repo root; report actual output. Codegen regeneration only in M10.2 (and it must be a
no-op if re-run in M10.3/M10.4). Baseline: 847 tests collected at plan time — all stay green.

## Self-review areas (execute during M10.4)

1. Grep the diff for any hand-written TS or any TS beyond generated `.d.ts` + fixtures.
2. Confirm the route imports no repository/Database and `quantize/api` gained no numerics.
3. Confirm the compatibility payload is produced by CALLING `is_compatible`, with no re-encoded
   rule anywhere (including tests — tests may enumerate, never re-derive).
4. Confirm `descriptor.py`, `compatibility.py`, node modules, and all engine code are unchanged.
5. Re-read MVP_PLAN §M11 and confirm nothing editor-side leaked in.

## Closeout (appended by the implementer)

M10 landed across four packets on `feat/m10-descriptor-api` off `origin/main`: M10.1 `de66ef4`
(registry export primitives + enabling seams), M10.2 `a342dc9` (catalog DTOs + frozen codegen
bundle), M10.3 `709e50d` (`GET /v1/node-types` endpoint + golden), M10.4 (API TS compile gate +
docs + closeout, this packet).

**Final gate outputs (both, run at M10.4 close from repo root):**

- `./scripts/gate.ps1` — ALL STAGES PASSED: `866 passed` (pytest) · `ruff check` all passed ·
  `ruff format --check` 180 files formatted · `mypy` no issues in 180 files · node24 active
  (v24.18.0) · `codegen check` up to date · `tsc --noEmit` clean.
- `bash scripts/gate.sh` — identical: `866 passed` · ruff/format/mypy clean · node24 v24.18.0 ·
  codegen up to date · tsc clean · ALL STAGES PASSED.

**Final test count:** 866 (baseline at plan time was 847; M10 added the registry-export, catalog
DTO/contract, and endpoint/golden tests).

**Codegen:** `codegen check` clean at close — M10.2 regenerated the API bundle
(`schema/quantize-api.schema.json` + `ts/quantize-api.d.ts`); M10.3/M10.4 were no-ops for codegen,
and the IR bundle (`schema/quantize.schema.json`, `ts/quantize-ir.d.ts`) is byte-unchanged.

**Compile gate (the pre-existing gap this milestone closed):** `ts/quantize-api.d.ts` +
`ts/fixtures/api-usage.ts` were added to `tsconfig.json` `files`; `npm run typecheck` compiles the
API declarations strictly (the trial compile at plan time was clean; no pre-existing errors in the
generated `.d.ts`, so no milestone stop was triggered). The fixture also exercises `ValidateResponse`
(generated in M9, never compiled until now).

**Deviations:** none. All ratified decisions held; no stop condition triggered; no engine/node/
persisted-format/migration change; no hand-edited generated artifact.

**Founder flip-points — final state:**
1. Endpoint path shipped as `/v1/node-types` (the plan default; `/v1/registry/nodes` not adopted).
2. `catalog_digest` shipped/included in `NodeCatalogResponse` (sha256 over the canonical projection
   body excluding the identity fields; the golden additionally provides the reviewed-diff guarantee).

**M11-facing notes (what the editor consumes):** a single GET returns the whole catalog — the closed
8-member port-type lattice with server-rendered labels, the 9-pair directional compatibility
allow-list (derived from `is_compatible`, so editor edge-validation matches the server), and one
entry per registered `(type_id, type_version)` with typed ports, `display_name`/`description`, and
the verbatim parameter JSON Schema (defaults in the schema's `default` keyword). `catalog_digest` is
the editor's cache key. No CORS is configured — that arrives scoped with the editor in M11.
