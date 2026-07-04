# M10 — Opus Execution Packets (2026-07-03)

> Compact, sequential, standalone packets for the M10 milestone. Execute **strictly in order**;
> a packet must not begin before the previous packet's DoD is met. The authoritative plan is
> `docs/plans/2026-07-03-m10-implementation-plan.md` — on ANY disagreement, the plan wins; on
> any ambiguity neither document resolves, STOP and ask the founder. Decisions here are
> RESOLVED — do not re-derive them.

## Shared preamble (read once per packet — assume zero prior context)

**What M10 is:** one governed, derived endpoint — `GET /v1/node-types` — exposing every
registered node type (ports, description, verbatim parameter JSON Schema) plus compatibility
metadata derived from the single `is_compatible` function, so the future M11 editor can render
and validate without embedding logic. Pure projection of the registry: **no DB, no migration,
no engine change, no frontend**.

**Environment (Windows, PowerShell primary):**
- Python: `.venv/Scripts/python.exe` (3.14). Tests: `.venv/Scripts/python.exe -m pytest`.
- Node: MUST be 24. Before ANY Node-dependent command (`python -m quantize.codegen generate`,
  `npm run typecheck`) run `./scripts/node24.ps1` **in the same shell process** (non-interactive
  shells resolve `node` to a wrong system version otherwise).
- Full gate (run BOTH before claiming a packet done, report actual output):
  `./scripts/gate.ps1` and `bash scripts/gate.sh` — pytest → ruff check → ruff format --check →
  mypy (strict, covers tests) → Node-24 → `codegen check` → `npm run typecheck`.
- Baseline: 847 tests green at plan time. TDD: write tests first, watch them fail, implement.

**Git:** branch `feat/m10-descriptor-api` off **`origin/main`** (`7d2d0dc`) — `git fetch origin`
first; the LOCAL `main` ref may be stale (it was 12 commits behind at plan time; branching off
it yields a tree with no API layer). One commit per packet: `M10.x: <summary>`. Do not merge,
do not open a PR mid-milestone.

**Standing invariants (violating any is a STOP):**
- `schema/quantize.schema.json` + `ts/quantize-ir.d.ts` stay byte-identical.
- No M9 DTO (incl. `MetaResponse`) is reshaped or extended; the API bundle grows additively.
- No engine/evaluator/node-semantics/migration/persisted-format change; no pre-existing golden
  moves; never hand-edit a generated artifact.
- `quantize/api/` gains no pandas/numpy and no business logic — compatibility DATA is produced
  by CALLING `quantize/compatibility.py:is_compatible`, never by re-encoding its rule.

**Key existing code (verified at plan time):**
- `quantize/registry/descriptor.py` — `NodeDescriptor{type_id, type_version, inputs:
  tuple[InputPortSpec,...], outputs: tuple[OutputPortSpec,...], metadata:
  NodeMetadata{display_name, description}, parameter_schema: JsonSchemaSpec|None, ...}`.
- `quantize/registry/registry.py:124` — `NodeRegistry.descriptors()` (sorted lexically by
  `(type_id, type_version)` dict key).
- `quantize/runtime/binding.py:154-193` — `ImplementationCatalog` (`self._descriptors` is a
  `NodeRegistry`; `implementations()` sorted).
- `quantize/nodes/__init__.py:34-39` — `build_core_catalog()`; 13 implementations, all v1.0.0.
- `quantize/compatibility.py:14-25` — `is_compatible(source, destination) -> bool` (exact match
  + the ONE widening Scalar[Integer]→Scalar[Number]).
- `quantize/schema/types.py:19-46` — the closed `PortType` union: Scalar[Number|Integer|Boolean],
  AssetSet, CrossSection[Number|Boolean], TimeSeries[Number], PortfolioTargets (8 total;
  OrderList deliberately absent).
- `quantize/registry/schema_spec.py:59-78` — `JsonSchemaSpec`, `__slots__ = ("_validator",)`,
  NO public schema accessor yet.
- `quantize/validation/semantic.py:33-36` — `_render_type` (e.g. `CrossSection[Number]`).
- `quantize/api/dto/common.py:13-24` — `_Dto` base (frozen, extra=forbid, strict,
  allow_inf_nan=False). `quantize/api/app.py:29` — `API_VERSION = "v1"` (M10.3 MOVES this to a
  new `quantize/api/version.py`: `app.py` imports route modules at :23 BEFORE binding the
  constant at :29, so a route importing it from `app.py` is a circular-import trap);
  `quantize/schema/version.py` — `CURRENT_SCHEMA_VERSION = "0.1.0"`.
- `quantize/codegen/schema.py:79-96` — `_API_ROOT_MODELS` (append here; artifacts regenerate).
- `quantize/api/routes/validate.py` — the route posture to copy (sync def, fresh
  `build_core_catalog()` per request, pure translation, no DB).
- `tests/api/conftest.py` — module-scoped in-process `TestClient` fixture `client`.
- `tests/api/test_hardening.py:68-86` — asserts the EXACT endpoint set (must be updated in the
  same commit that adds a route).
- `tests/golden_utils.py:109` — `assert_summary_matches_golden(name, summary, update)`;
  `update_goldens` fixture from `tests/conftest.py`; goldens in `tests/goldens/` (LF-pinned).

---

## Packet M10.1 — Registry export primitives (pure domain; no API)

**Goal:** the enabling seams + pure derivation primitives, with zero API-layer change.

**Files:**
- Modify `quantize/registry/schema_spec.py`: add read-only property `document -> JsonObject`
  returning a deep copy of the schema. **mypy trap:** `jsonschema` is untyped
  (`ignore_missing_imports`), so returning `self._validator.schema` fails strict mypy
  (`warn_return_any`). Instead keep the constructor's `owned` dict:
  `__slots__ = ("_schema", "_validator")`; `self._schema = owned`;
  `document` returns `deepcopy(self._schema)`. Also update the module docstring lines 4-6
  ("the schema lives only inside a private validator") — no longer accurate after this change.
- Modify `quantize/runtime/binding.py`: add
  `ImplementationCatalog.descriptors() -> tuple[NodeDescriptor, ...]` delegating to
  `self._descriptors.descriptors()`. Do NOT touch the `NodeRegistryView` Protocol.
- Modify `quantize/schema/types.py`: add `render_port_type(port_type: PortType) -> str` — move
  `_render_type` from `quantize/validation/semantic.py:33-36` VERBATIM (`kind[dtype]` when a
  dtype exists, bare `kind` otherwise).
- Modify `quantize/validation/semantic.py`: import `render_port_type`, delete `_render_type`,
  keep every message byte-identical.
- Create `quantize/registry/export.py`:
  - `PORT_TYPE_LATTICE: tuple[PortType, ...]` — literal 8-tuple in sort-key order
    `(kind, dtype or "")`: AssetSet, CrossSection[Boolean], CrossSection[Number],
    PortfolioTargets, Scalar[Boolean], Scalar[Integer], Scalar[Number], TimeSeries[Number].
  - `compatible_pairs() -> tuple[tuple[PortType, PortType], ...]` — iterate the lattice
    source-major, destination-minor; include a pair iff `is_compatible(source, destination)`.
  - `catalog_digest(body: JsonObject) -> str` —
    `hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()`.
- Create `tests/test_registry_export.py` (docstring `"""M10.1: ..."""`); extend
  `tests/test_schema_spec.py`.

**Tests first (watch them fail):**
1. `document` returns the constructed schema; mutating the returned dict affects neither a
   later `errors()` call nor a second `document` read.
2. Lattice closure: derive the full variant set from the `PortType` union's type annotations
   and assert equality with `PORT_TYPE_LATTICE` (set AND order per the sort key). NOTE:
   `types.py` uses `from __future__ import annotations`, so raw `__annotations__` are strings —
   apply `typing.get_args` to `Variant.model_fields["kind"].annotation` /
   `["dtype"].annotation` (Pydantic resolves them), not to raw class annotations. A future new
   variant fails loud here.
3. `compatible_pairs()` == direct `is_compatible` enumeration over lattice × lattice; exactly
   9 pairs = 8 identity + Scalar[Integer]→Scalar[Number].
4. Digest: stable across two calls on equal bodies; construct two HAND-WRITTEN body dicts
   differing by one character in a description string and assert different digests (no catalog
   assembly exists yet in this packet — do not reach forward to M10.3); 64 lowercase hex.
5. `ImplementationCatalog.descriptors()` (via `build_core_catalog()`) returns 13 descriptors
   sorted by `(type_id, type_version)` and equals `[i.descriptor for i in implementations()]`.
   Do NOT assert semver ordering (the sort is lexical; moot in v0).
6. Parameter-schema keyword guard: for every registered descriptor with a `parameter_schema`,
   walk `parameter_schema.document` collecting SCHEMA KEYWORDS only — the keys of the object
   under `"properties"` are parameter NAMES (`n`, `max`, `tickers`, …), not keywords: collect
   the current dict's keys, then recurse into each property's VALUE, the `"items"` value, and
   each `"oneOf"` member. Assert collected ⊆ {`type, properties, required,
   additionalProperties, minimum, exclusiveMinimum, maximum, minLength, minItems, uniqueItems,
   items, oneOf, const, default`}. (A naive all-keys walk false-positives on `max` — don't.)
7. Full existing suite green UNCHANGED — especially `tests/test_semantic_validation.py` (the
   hoist must not alter one message).

**DoD:** both gates green; no `quantize/api/` or codegen-artifact change. Commit `M10.1: ...`.
**Stop:** any existing test needs modification; any keyword found outside the documented subset
(record it and get founder ack — never silently widen).

---

## Packet M10.2 — Catalog DTOs + API codegen bundle growth (FREEZE)

**Goal:** the governed wire contract. This packet freezes M10 DTO shapes — later packets may
NOT add or reshape fields; a discovered missing field is a STOP (return here deliberately).

**Files:**
- Create `quantize/api/dto/catalog.py` — fastapi-free, all models on `_Dto`
  (`quantize/api/dto/common.py`), tuples for sequences, `PortType` imported from
  `quantize/schema/types.py` and `JsonObject` from `quantize/schema/primitives.py` (both reused,
  never redeclared):
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
- Modify `quantize/codegen/schema.py`: append `(NodeCatalogResponse, "serialization")` to
  `_API_ROOT_MODELS` (only the root — nested models flow into `$defs` by reference).
- Regenerate: `./scripts/node24.ps1` then
  `.venv/Scripts/python.exe -m quantize.codegen generate`; COMMIT the regenerated
  `schema/quantize-api.schema.json` + `ts/quantize-api.d.ts`. The `PortType` variant models
  will appear in the API `$defs` for the first time; their duplication across the two `.d.ts`
  files mirrors the accepted `JsonValue` precedent.
- Extend `tests/api/test_api_contract.py`: add a `NodeCatalogResponse` entry to `_SAMPLES` —
  small representative instance with TWO `node_types` entries: the first with a non-null
  `parameter_schema` carrying a `default`, the SECOND with `parameter_schema=None` (the live
  catalog never exercises the null branch — all 13 nodes declare one); plus two `port_types`
  entries and one compatibility pair.
  Extend the forbid-unknown-fields and TS-interface-presence (`export interface
  NodeCatalogResponse`, `NodeTypeDto`) lists.

**Tests first:** the sample validates against the COMMITTED `schema/quantize-api.schema.json`
via the independent `jsonschema` Draft202012Validator (existing `_def_validator` pattern);
`additionalProperties: false` on the new defs; TS interfaces present;
`test_ir_bundle_unchanged_by_api_packet` green UNMODIFIED; `tests/test_codegen_determinism.py`
green (auto-covers the grown bundle).

**DoD:** `python -m quantize.codegen check` clean (under Node 24); both gates green.
Commit `M10.2: ...`.
**Stop:** any byte change to the committed IR artifacts; any M9 `$defs` shape change.

---

## Packet M10.3 — `GET /v1/node-types` endpoint + golden

**Goal:** the endpoint, assembled ONLY from M10.1 primitives + M10.2 DTOs.

**Files:**
- Create `quantize/api/version.py`: `API_VERSION = "v1"` moved out of `app.py` (which imports
  route modules BEFORE binding the constant — importing it from `app.py` inside a route module
  is a circular import). Modify `quantize/api/app.py` to import `API_VERSION` from the new
  module and delete the local assignment (only `app.py` references it today — verified by grep;
  `/v1/meta` behavior is unchanged and `tests/api/test_meta.py` must stay green untouched).
- Create `quantize/api/routes/catalog.py`: `APIRouter(prefix="/v1", tags=["catalog"])`; sync
  `def` handler for `GET /node-types` (copy `routes/validate.py`'s posture — no DB, no state):
  1. `catalog = build_core_catalog()`; descriptors via `catalog.descriptors()`.
  2. `node_types`: one `NodeTypeDto` per descriptor — `display_name`/`description` from
     `descriptor.metadata`; ports field-for-field (pass the domain `PortType` instances
     directly — same Pydantic models); `parameter_schema` via `spec.document` if the descriptor
     has one else `None`.
  3. `port_types`: one `PortTypeEntryDto` per `PORT_TYPE_LATTICE` member, `label` via
     `render_port_type`.
  4. `compatibility`: one `CompatibilityPairDto` per `compatible_pairs()` result, in order.
  5. Digest: `body = {"compatibility": [...], "node_types": [...], "port_types": [...]}` where
     each list is the corresponding DTO tuple dumped with
     `model_dump(mode="json", by_alias=True)`; `digest = catalog_digest(body)`. (`api_version`,
     `schema_version`, and the digest itself are EXCLUDED from the digested body.)
  6. Return `NodeCatalogResponse(api_version=API_VERSION,
     schema_version=CURRENT_SCHEMA_VERSION, catalog_digest=digest, ...)` — `API_VERSION` from
     `quantize.api.version` (NEVER from `quantize.api.app`), `CURRENT_SCHEMA_VERSION` from
     `quantize.schema.version`.
- Modify `quantize/api/app.py`: include the router.
- Update `tests/api/test_hardening.py` (SAME commit): add `/v1/node-types` to the exact
  endpoint set at lines 71-86.
- Create `tests/api/test_catalog_endpoint.py` (docstring `"""M10.3: ..."""`; uses the
  module-scoped `client` fixture; no `db` fixture — the endpoint has no DB).
- Create golden `tests/goldens/node_catalog.json` via
  `assert_summary_matches_golden("node_catalog", <parsed full response body>, update_goldens)`
  — first run scoped: `.venv/Scripts/python.exe -m pytest tests/api/test_catalog_endpoint.py
  --update-goldens` (scoping avoids rewriting unrelated goldens), then REVIEW the generated
  file against the plan's §Contracts before committing.

**Tests first:**
1. 200; exactly 13 `node_types` sorted by `(type_id, type_version)`; 8 `port_types`;
   9 `compatibility` pairs.
2. Hand-pinned `transform.rank`: display_name `"Rank"`; input `values:
   CrossSection[Number]` required, output `values: CrossSection[Number]`;
   `parameter_schema["properties"]["descending"]["default"] is True` (pins "defaults").
3. Hand-pinned `portfolio.fixed_weight`: `parameter_schema` carries the
   `oneOf: [{const "equal"}, bounded number]` verbatim (pins the non-scalar ceiling).
4. Endpoint compatibility list == enumerating `is_compatible` over the lattice (API-level
   parity; enumerate — never re-encode the rule).
5. Recompute the digest from the response's own body per the recipe and assert it equals
   `catalog_digest` in the payload; two GETs → byte-identical `response.content`.
6. Full response validates against the committed `schema/quantize-api.schema.json` via an
   independent `jsonschema` validator.
7. `api_version == "v1"`, `schema_version == CURRENT_SCHEMA_VERSION` (the `test_meta.py`
   exact-constant pattern).
8. Golden comparison (update path: `pytest --update-goldens` + reviewed diff).

**DoD:** both gates green; endpoint-set test updated in the same commit. Commit `M10.3: ...`.
**Stop:** standing stop conditions (any engine-touching change; any pre-existing golden moves).

---

## Packet M10.4 — API TS compile gate + hardening + closeout

**Goal:** close the pre-existing compile-gate gap, finish docs, prove the milestone.

**Files:**
- Create `ts/fixtures/api-usage.ts`: a compile fixture exercising `NodeCatalogResponse`,
  `NodeTypeDto`, `ValidateResponse` — mirror `ts/fixtures/usage.ts`, including its
  EXTENSIONLESS import form (`from "../quantize-api"`, never a `.d.ts` path).
- Modify `tsconfig.json`: add `ts/quantize-api.d.ts` and `ts/fixtures/api-usage.ts` to `files`.
- Docs: CLAUDE.md — add the `GET /v1/node-types` endpoint to the M9 run/API notes;
  `docs/LEARNING_LOG.md` — append the M10 entry (concepts: derived contracts vs. sources of
  truth, content hashing as identity, closed type lattices; reading path: `descriptor.py` →
  `registry/export.py` → `api/dto/catalog.py` → `api/routes/catalog.py`; by-hand exercise: in a
  scratch branch add a hypothetical `Scalar[Boolean]→CrossSection[Boolean]` widening to
  `is_compatible`, PREDICT which three tests fail — matrix parity, golden, endpoint pair
  count — verify, discard); append the Closeout section to
  `docs/plans/2026-07-03-m10-implementation-plan.md` (gate outputs, final test count,
  deviations — should be none, final state of the two founder flip-points: endpoint path and
  `catalog_digest`).
- Self-review sweep (from the plan): no hand-written TS beyond fixtures; route imports no
  repository/Database; compatibility produced only by CALLING `is_compatible`;
  `descriptor.py`/`compatibility.py`/node modules/engine unchanged; nothing M11/M12 leaked in.

**Tests first:** `./scripts/node24.ps1` then `npm run typecheck` proves the API declarations
compile strictly; then a final full run of BOTH gates.

**DoD:** BOTH gates green end-to-end; AGENTS.md review checklist passes on the full diff.
Commit `M10.4: ...`. Milestone complete — STOP; do not merge, do not open a PR, do not begin
M11 (founder review comes first).
**Stop:** if adding `ts/quantize-api.d.ts` to `files` surfaces PRE-EXISTING compile errors in
the M9-generated declarations (unlikely — a trial compile at plan time was clean), do not patch
generated files by hand: report the errors and HALT — this is a MILESTONE stop, not a skip. The
compile gate is part of M10's definition of done; M10 is NOT done until the founder either has
the generator fixed or explicitly demotes the gate out of M10's DoD in a recorded amendment.
