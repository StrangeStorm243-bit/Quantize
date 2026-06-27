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
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel
from pydantic.json_schema import models_json_schema

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
