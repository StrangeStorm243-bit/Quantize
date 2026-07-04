"""Determinism and staleness of the M1.3 codegen — the Python (schema) half.

These tests need no Node: they exercise the Pydantic -> JSON Schema step and the committed schema
artifact. The TypeScript half (json-schema-to-typescript + tsc) is verified by the Node CI job via
``python -m quantize.codegen check`` and ``tsc --noEmit``.
"""

from __future__ import annotations

import json

from quantize.codegen.schema import (
    API_SCHEMA_PATH,
    API_TS_PATH,
    SCHEMA_PATH,
    TS_PATH,
    build_api_bundle,
    build_bundle,
    build_ts_input,
    canonical_json,
)


def test_build_bundle_is_deterministic() -> None:
    assert canonical_json(build_bundle()) == canonical_json(build_bundle())


def test_build_api_bundle_is_deterministic() -> None:
    assert canonical_json(build_api_bundle()) == canonical_json(build_api_bundle())


def test_committed_api_schema_matches_models() -> None:
    """The committed API JSON Schema must equal a fresh build (the API schema-staleness gate)."""
    expected = canonical_json(build_api_bundle())
    actual = API_SCHEMA_PATH.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert actual == expected, (
        "schema/quantize-api.schema.json is stale; run `python -m quantize.codegen generate`."
    )


def test_api_bundle_has_synthetic_object_root_not_oneof() -> None:
    """The API bundle uses a synthetic object root (json2ts needs a reachable root); the IR
    bundle's top-level ``oneOf`` union must NOT appear on it."""
    bundle = build_api_bundle()
    assert bundle["type"] == "object"
    assert "oneOf" not in bundle
    # every $def is reachable from the root so json2ts emits an interface for each
    assert set(bundle["properties"]) == set(bundle["$defs"])


def test_committed_schema_matches_models() -> None:
    """The committed JSON Schema must equal a fresh build (the schema-staleness gate, in Python)."""
    expected = canonical_json(build_bundle())
    actual = SCHEMA_PATH.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert actual == expected, (
        "schema/quantize.schema.json is stale; run `python -m quantize.codegen generate`."
    )


def test_committed_artifacts_are_lf_only_on_disk() -> None:
    """Guard the byte-stable-LF claim on the raw bytes — the content gate normalizes EOL, so a
    CRLF-corrupted commit (e.g. .gitattributes bypassed) would otherwise slip through."""
    for path in (SCHEMA_PATH, TS_PATH, API_SCHEMA_PATH, API_TS_PATH):
        assert b"\r" not in path.read_bytes(), f"{path.name} has CR; artifacts must be LF-only."


def test_canonical_json_is_lf_sorted_and_newline_terminated() -> None:
    text = canonical_json({"b": 1, "a": 2})
    assert "\r" not in text
    assert text.endswith("}\n")
    assert text.index('"a"') < text.index('"b"')  # keys sorted


def test_ts_input_rewrites_prefixitems_but_committed_schema_keeps_them() -> None:
    bundle = build_bundle()
    ts_input = build_ts_input(bundle)
    committed = json.dumps(bundle)
    transformed = json.dumps(ts_input)
    # The committed contract keeps modern Draft 2020-12 prefixItems...
    assert "prefixItems" in committed
    # ...while the generator input expresses the identical tuple via Draft-07 array-form items.
    assert "prefixItems" not in transformed
    assert '"items": [' in canonical_json(ts_input)


def test_ts_input_preserves_tuple_arity() -> None:
    """The prefixItems -> items rewrite must not change the two-element tuple shape."""
    edge = build_ts_input(build_bundle())["$defs"]["Edge"]["properties"]["from"]
    assert edge["minItems"] == 2 and edge["maxItems"] == 2
    assert len(edge["items"]) == 2
