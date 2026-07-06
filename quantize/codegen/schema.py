"""Build the bundled, language-neutral JSON Schema from the Pydantic IR models.

This is the deterministic Pydantic -> JSON Schema half of the M1.3 codegen pipeline. The persisted
JSON IR is the semantic source of truth; Pydantic is its v0 authoring implementation; this module
exports the *structural* contract (one bundled Draft 2020-12 document) that language-neutral
consumers — and the generated TypeScript — derive from. The TypeScript is a derived artifact; never
hand-maintain it (see ``quantize/codegen/typescript.py``).

Two persisted roots receive schemas — ``StrategyDocument`` and ``ComponentDefinition`` — bundled
into one artifact so their shared ``$defs`` (e.g. ``Edge``, ``RegisteredNode``, ``JsonValue``) are
defined exactly once. A top-level ``oneOf`` exposes the persisted-document union.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel
from pydantic.json_schema import models_json_schema

from quantize.api.dto.catalog import NodeCatalogResponse
from quantize.api.dto.common import ApiError, MetaResponse
from quantize.api.dto.datasets import DatasetList, DatasetStored, DatasetUpload
from quantize.api.dto.documents import (
    ComponentList,
    ComponentSaved,
    StrategyList,
    StrategySaved,
    VersionList,
)
from quantize.api.dto.runs import (
    BacktestRunRequest,
    ForwardRunRequest,
    RunCreated,
    RunList,
    RunRecordResponse,
    TraceResponse,
)
from quantize.api.dto.validate import ValidateResponse
from quantize.schema import ComponentDefinition, StrategyDocument
from quantize.schema.version import CURRENT_SCHEMA_VERSION

# Repo-root-relative artifact paths (quantize/codegen/schema.py -> parents[2] == repo root).
REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "schema" / "quantize.schema.json"
TS_PATH = REPO_ROOT / "ts" / "quantize-ir.d.ts"

# Stable, non-machine-specific identity injected into the bundle (no timestamps/paths/usernames).
SCHEMA_ID = f"https://quantize.dev/schema/{CURRENT_SCHEMA_VERSION}/quantize-ir.schema.json"
SCHEMA_TITLE = "QuantizeIR"
SCHEMA_DESCRIPTION = (
    "Bundled Quantize IR persisted-document contract (StrategyDocument | ComponentDefinition)."
)

# The persisted roots, in serialization mode so the schema describes the *persisted* (aliased) shape
# — ``"from"`` not ``from_``, ``"schema"`` not ``schema_`` — that ``to_ir_json`` writes.
_ROOT_MODELS: list[tuple[type[BaseModel], Literal["validation", "serialization"]]] = [
    (StrategyDocument, "serialization"),
    (ComponentDefinition, "serialization"),
]

# --- The API DTO bundle (second, independent artifact) ----------------------------------------
API_SCHEMA_PATH = REPO_ROOT / "schema" / "quantize-api.schema.json"
API_TS_PATH = REPO_ROOT / "ts" / "quantize-api.d.ts"
API_SCHEMA_ID = f"https://quantize.dev/schema/{CURRENT_SCHEMA_VERSION}/quantize-api.schema.json"
API_SCHEMA_TITLE = "QuantizeApi"
API_SCHEMA_DESCRIPTION = (
    "Bundled Quantize HTTP API request/response envelope contract (M9 boundary)."
)

# The API envelope roots, in serialization mode (they describe the shapes that cross the wire).
# Referenced-but-unlisted models (diagnostic/list-row/nested DTOs, and the reused
# PersistedRunRecord / TraceEvent / RunInputProvenance trees) are pulled into ``$defs`` by
# reference. Do NOT add these to the IR ``_ROOT_MODELS`` — that would corrupt the IR union.
_API_ROOT_MODELS: list[tuple[type[BaseModel], Literal["validation", "serialization"]]] = [
    (ApiError, "serialization"),
    (MetaResponse, "serialization"),
    (ValidateResponse, "serialization"),
    (StrategySaved, "serialization"),
    (StrategyList, "serialization"),
    (VersionList, "serialization"),
    (ComponentSaved, "serialization"),
    (ComponentList, "serialization"),
    (DatasetUpload, "serialization"),
    (DatasetStored, "serialization"),
    (DatasetList, "serialization"),
    (BacktestRunRequest, "serialization"),
    (ForwardRunRequest, "serialization"),
    (RunCreated, "serialization"),
    (RunList, "serialization"),
    (RunRecordResponse, "serialization"),
    (TraceResponse, "serialization"),
    (NodeCatalogResponse, "serialization"),
]


def _strip_deep_titles(node: Any) -> Any:
    """Drop every ``title`` in *node* and all descendants (Pydantic auto-titles every field)."""
    if isinstance(node, dict):
        return {k: _strip_deep_titles(v) for k, v in node.items() if k != "title"}
    if isinstance(node, list):
        return [_strip_deep_titles(item) for item in node]
    return node


def _clean_defs(defs: dict[str, Any]) -> dict[str, Any]:
    """Keep each ``$defs`` member's own model-level title (it names the TS interface) but strip the
    noisy per-property titles beneath it (which otherwise become dozens of ``Id1``/``Kind1`` TS
    aliases). Title stripping is contract-neutral: titles are documentation, not constraints."""
    out: dict[str, Any] = {}
    for name, member in defs.items():
        title = member.get("title")
        cleaned = _strip_deep_titles(member)
        if title is not None:
            cleaned = {"title": title, **cleaned}
        out[name] = cleaned
    return out


def build_bundle() -> dict[str, Any]:
    """Return the canonical bundled JSON Schema dict for the persisted IR roots.

    Deterministic: depends only on the (pinned) Pydantic models, not on environment or time.
    """
    _key_map, top = models_json_schema(_ROOT_MODELS, ref_template="#/$defs/{model}")
    defs = _clean_defs(top["$defs"])
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": SCHEMA_ID,
        "title": SCHEMA_TITLE,
        "description": SCHEMA_DESCRIPTION,
        "oneOf": [
            {"$ref": "#/$defs/StrategyDocument"},
            {"$ref": "#/$defs/ComponentDefinition"},
        ],
        "$defs": defs,
    }


def build_api_bundle() -> dict[str, Any]:
    """Return the canonical bundled JSON Schema dict for the API DTO roots.

    Unlike the IR bundle there is no natural persisted-document union, so instead of a top-level
    ``oneOf`` this emits a synthetic object root with one optional property per ``$defs`` member
    (json-schema-to-typescript emits an interface only for schemas reachable from the root; a
    defs-only bundle yields a single index-signature interface — proven empirically). The
    ``QuantizeApi`` umbrella interface it produces is a codegen vehicle, never an API payload.
    """
    _key_map, top = models_json_schema(_API_ROOT_MODELS, ref_template="#/$defs/{model}")
    defs = _clean_defs(top["$defs"])
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": API_SCHEMA_ID,
        "title": API_SCHEMA_TITLE,
        "description": API_SCHEMA_DESCRIPTION,
        "type": "object",
        "additionalProperties": False,
        "properties": {name: {"$ref": f"#/$defs/{name}"} for name in sorted(defs)},
        "$defs": defs,
    }


@dataclass(frozen=True)
class BundleSpec:
    """One codegen artifact pair: how to build its bundle and where its schema/TS files live."""

    name: str
    build: Callable[[], dict[str, Any]]
    schema_path: Path
    ts_path: Path


# The full set of governed artifact pairs. The IR bundle MUST stay first and byte-unchanged;
# the API bundle is additive. ``pipeline`` iterates this to generate/check every artifact.
BUNDLES: tuple[BundleSpec, ...] = (
    BundleSpec("IR", build_bundle, SCHEMA_PATH, TS_PATH),
    BundleSpec("API", build_api_bundle, API_SCHEMA_PATH, API_TS_PATH),
)


def build_ts_input(bundle: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of *bundle* with Draft 2020-12 ``prefixItems`` rewritten to the equivalent
    Draft-07 array-form ``items`` tuple.

    ``json-schema-to-typescript`` (pinned) renders ``prefixItems`` element types as ``unknown``;
    the array-form ``items`` tuple it renders as ``[T, U]``. The two express the *identical*
    fixed-length tuple constraint, so this is contract-preserving — TypeScript cannot encode the
    string ``pattern``/``minLength`` regardless. The committed schema keeps modern ``prefixItems``;
    only the generator's input is rewritten.
    """

    def _tx(node: Any) -> Any:
        if isinstance(node, dict):
            node = {k: _tx(v) for k, v in node.items()}
            if "prefixItems" in node:
                node["items"] = node.pop("prefixItems")
            return node
        if isinstance(node, list):
            return [_tx(item) for item in node]
        return node

    transformed: dict[str, Any] = _tx(copy.deepcopy(bundle))
    return transformed


def canonical_json(obj: Any) -> str:
    """Deterministic JSON text: sorted keys, 2-space indent, LF newlines, single trailing newline.

    ``sort_keys`` canonicalizes object key order; list order (``required``, ``oneOf``, ``anyOf``)
    is already stable for a pinned Pydantic. LF is forced so the artifact is byte-identical across
    Windows and Linux (see ``.gitattributes``).
    """
    return json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
