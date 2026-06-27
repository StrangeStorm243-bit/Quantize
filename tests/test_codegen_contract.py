"""Cross-language contract checks on the *exported* artifacts (M1.3).

These assert properties of the published JSON Schema and the generated TypeScript that matter across
the language boundary — not a re-test of every Pydantic rule. The reference documents are validated
against the JSON Schema with ``jsonschema`` (a Draft 2020-12 validator), i.e. independently of
Pydantic, to prove the exported contract really accepts what the implementation produces.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from quantize.codegen.schema import SCHEMA_PATH, TS_PATH, build_bundle
from quantize.schema.version import (
    CURRENT_SCHEMA_VERSION,
    SUPPORTED_SCHEMA_VERSIONS,
    supported_schema_versions,
)
from tests.helpers import load_fixture

# Well-formed SemVers outside the supported set, plus a syntactically malformed value.
_UNSUPPORTED_VERSIONS = ["0.2.0", "9.9.9", "version-one"]


def _errors(schema: dict[str, Any], doc: dict[str, Any]) -> list[Any]:
    return list(Draft202012Validator(schema).iter_errors(doc))


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return data


@pytest.fixture(scope="module")
def ts_source() -> str:
    return TS_PATH.read_text(encoding="utf-8")


# --- the schema is a valid Draft 2020-12 document, and accepts the reference strategies ----------


def test_schema_is_valid_draft_2020_12(schema: dict[str, Any]) -> None:
    Draft202012Validator.check_schema(schema)


def test_committed_schema_file_matches_models(schema: dict[str, Any]) -> None:
    assert schema == build_bundle()


@pytest.mark.parametrize("name", ["strategy_a", "strategy_b"])
def test_reference_strategies_validate_against_schema(schema: dict[str, Any], name: str) -> None:
    errors = sorted(Draft202012Validator(schema).iter_errors(load_fixture(name)), key=str)
    assert not errors, "; ".join(e.message for e in errors[:5])


# --- root contract: required fields, closed objects ---------------------------------------------


def test_roots_are_present_and_unioned(schema: dict[str, Any]) -> None:
    assert {"$ref": "#/$defs/StrategyDocument"} in schema["oneOf"]
    assert {"$ref": "#/$defs/ComponentDefinition"} in schema["oneOf"]
    assert "StrategyDocument" in schema["$defs"]
    assert "ComponentDefinition" in schema["$defs"]


def test_strategy_required_fields(schema: dict[str, Any]) -> None:
    required = set(schema["$defs"]["StrategyDocument"]["required"])
    assert {
        "schema_version",
        "strategy",
        "execution_policy",
        "schedule",
        "nodes",
        "edges",
        "component_refs",
    } <= required


def test_governed_objects_forbid_unknown_fields(schema: dict[str, Any]) -> None:
    for name in ("StrategyDocument", "ComponentDefinition", "RegisteredNode", "Edge"):
        assert schema["$defs"][name]["additionalProperties"] is False


def test_ordinary_node_requires_type_version(schema: dict[str, Any]) -> None:
    req = set(schema["$defs"]["RegisteredNode"]["required"])
    assert "type_version" in req and "ref" not in req


def test_component_node_requires_ref_and_pins_type_id(schema: dict[str, Any]) -> None:
    comp = schema["$defs"]["ComponentRefNode"]
    assert "ref" in comp["required"]
    assert comp["properties"]["type_id"]["const"] == "component"


# --- extensibility seam: unknown future type_id stays representable (M1 accepts; M2 rejects) ------


def test_unknown_future_type_id_is_representable(schema: dict[str, Any]) -> None:
    doc = load_fixture("strategy_a")
    for node in doc["nodes"]:
        if node.get("type_id") != "component":
            node["type_id"] = "future.unknown_block"
            break
    errors = list(Draft202012Validator(schema).iter_errors(doc))
    assert not errors, "structurally valid unknown type_id must remain schema-valid"


# --- recursion, discriminators, and the OrderList exclusion survive generation -------------------


def test_jsonvalue_is_recursive_not_any(schema: dict[str, Any]) -> None:
    jv = schema["$defs"]["JsonValue"]
    assert "anyOf" in jv
    self_ref = {"$ref": "#/$defs/JsonValue"}
    has_array_recursion = any(branch.get("items") == self_ref for branch in jv["anyOf"])
    has_object_recursion = any(
        branch.get("additionalProperties") == self_ref for branch in jv["anyOf"]
    )
    assert has_array_recursion, "JsonValue array branch must recurse, not collapse to any"
    assert has_object_recursion, "JsonValue object branch must recurse, not collapse to any"


def test_schedule_discriminator_survives(schema: dict[str, Any]) -> None:
    sched = schema["$defs"]["StrategyDocument"]["properties"]["schedule"]
    assert sched["discriminator"]["propertyName"] == "kind"


def test_port_type_discriminator_and_no_orderlist(schema: dict[str, Any]) -> None:
    port = schema["$defs"]["ExposedPort"]["properties"]["type"]
    assert port["discriminator"]["propertyName"] == "kind"
    kinds = set(port["discriminator"]["mapping"])
    assert kinds == {"Scalar", "AssetSet", "CrossSection", "TimeSeries", "PortfolioTargets"}
    assert "OrderList" not in kinds


def test_edge_source_is_aliased_from(schema: dict[str, Any]) -> None:
    props = schema["$defs"]["Edge"]["properties"]
    assert "from" in props and "from_" not in props


def test_schema_version_constraint_visible(schema: dict[str, Any]) -> None:
    sv = schema["$defs"]["StrategyDocument"]["properties"]["schema_version"]
    assert sv["pattern"] == r"^\d+\.\d+\.\d+$"
    assert "enum" in sv  # restricted to the supported set, not just SemVer syntax (see below)


# --- schema_version is restricted to the centralized supported set, on BOTH roots ----------------


def test_both_roots_schema_version_enum_is_centralized_and_required(schema: dict[str, Any]) -> None:
    expected = supported_schema_versions()  # deterministic (sorted) single source
    enums = []
    for root in ("StrategyDocument", "ComponentDefinition"):
        field = schema["$defs"][root]["properties"]["schema_version"]
        assert field["enum"] == expected, f"{root}.schema_version enum drifted from supported set"
        assert "schema_version" in schema["$defs"][root]["required"]
        enums.append(field["enum"])
    assert enums[0] == enums[1], "the two roots must share one supported-version policy"


def test_current_version_is_supported(schema: dict[str, Any]) -> None:
    assert CURRENT_SCHEMA_VERSION in SUPPORTED_SCHEMA_VERSIONS
    for name in ("strategy_a", "component_a"):
        doc = load_fixture(name)
        doc["schema_version"] = CURRENT_SCHEMA_VERSION
        assert not _errors(schema, doc)


@pytest.mark.parametrize("root", ["strategy_a", "component_a"])
@pytest.mark.parametrize("version", sorted(SUPPORTED_SCHEMA_VERSIONS))
def test_supported_version_accepted(schema: dict[str, Any], root: str, version: str) -> None:
    doc = load_fixture(root)
    doc["schema_version"] = version
    assert not _errors(schema, doc)


@pytest.mark.parametrize("root", ["strategy_a", "component_a"])
@pytest.mark.parametrize("version", _UNSUPPORTED_VERSIONS)
def test_unsupported_version_rejected(schema: dict[str, Any], root: str, version: str) -> None:
    doc = load_fixture(root)
    doc["schema_version"] = version
    assert _errors(schema, doc), f"{root} with schema_version={version!r} must be rejected"


def test_component_reference_document_validates(schema: dict[str, Any]) -> None:
    assert not _errors(schema, load_fixture("component_a"))


def test_oneof_cannot_leak_unsupported_through_the_other_root(schema: dict[str, Any]) -> None:
    """An unsupported strategy/component must fail the bundle AND not slip through the sibling
    branch of the root ``oneOf`` (the branches are disjoint by shape and by version)."""
    strat_schema = {"$defs": schema["$defs"], "$ref": "#/$defs/StrategyDocument"}
    comp_schema = {"$defs": schema["$defs"], "$ref": "#/$defs/ComponentDefinition"}
    bad_strategy = load_fixture("strategy_a")
    bad_strategy["schema_version"] = "0.2.0"
    bad_component = load_fixture("component_a")
    bad_component["schema_version"] = "0.2.0"
    # Rejected by the whole bundle...
    assert _errors(schema, bad_strategy)
    assert _errors(schema, bad_component)
    # ...and not accidentally valid against the *other* root's definition.
    assert _errors(comp_schema, bad_strategy)
    assert _errors(strat_schema, bad_component)


# --- the generated TypeScript artifact preserves the key distinctions ----------------------------


def test_ts_exports_distinct_roots_and_union(ts_source: str) -> None:
    assert "export interface StrategyDocument" in ts_source
    assert "export interface ComponentDefinition" in ts_source
    assert "export type QuantizeIR = StrategyDocument | ComponentDefinition;" in ts_source


def test_ts_edge_endpoints_are_string_tuples_not_unknown(ts_source: str) -> None:
    assert "from: [string, string]" in ts_source
    assert "to: [string, string]" in ts_source
    assert "[unknown, unknown]" not in ts_source


def test_ts_node_variants_distinct(ts_source: str) -> None:
    assert 'type_id: "component"' in ts_source  # ComponentRefNode literal
    assert "(RegisteredNode | ComponentRefNode)[]" in ts_source


def test_ts_jsonvalue_is_recursive(ts_source: str) -> None:
    assert "export type JsonValue =" in ts_source
    assert "JsonValue[]" in ts_source


def test_ts_required_fields_not_optional(ts_source: str) -> None:
    # type_version is required on RegisteredNode; must not be emitted as optional.
    assert "type_version: string;" in ts_source
    assert "type_version?:" not in ts_source
