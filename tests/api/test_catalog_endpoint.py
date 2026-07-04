"""M10.3: the GET /v1/node-types descriptor endpoint."""

from __future__ import annotations

from collections.abc import Callable

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from quantize.api.dto.catalog import CATALOG_IDENTITY_FIELDS, CompatibilityPairDto
from quantize.compatibility import is_compatible
from quantize.registry.export import PORT_TYPE_LATTICE, catalog_digest
from quantize.schema.version import CURRENT_SCHEMA_VERSION
from tests.golden_utils import assert_summary_matches_golden


def test_catalog_shape(client: TestClient) -> None:
    response = client.get("/v1/node-types")
    assert response.status_code == 200
    body = response.json()
    node_types = body["node_types"]
    assert len(node_types) == 13
    identities = [(n["type_id"], n["type_version"]) for n in node_types]
    assert identities == sorted(identities)
    assert len(body["port_types"]) == 8
    assert len(body["compatibility"]) == 9


def test_rank_node_entry(client: TestClient) -> None:
    body = client.get("/v1/node-types").json()
    rank = next(n for n in body["node_types"] if n["type_id"] == "transform.rank")
    assert rank["display_name"] == "Rank"
    assert rank["inputs"] == [
        {
            "name": "values",
            "port_type": {"kind": "CrossSection", "dtype": "Number"},
            "required": True,
        }
    ]
    assert rank["outputs"] == [
        {"name": "values", "port_type": {"kind": "CrossSection", "dtype": "Number"}}
    ]
    assert rank["parameter_schema"]["properties"]["descending"]["default"] is True


def test_fixed_weight_parameter_schema(client: TestClient) -> None:
    body = client.get("/v1/node-types").json()
    fixed = next(n for n in body["node_types"] if n["type_id"] == "portfolio.fixed_weight")
    one_of = fixed["parameter_schema"]["properties"]["weight_per_asset"]["oneOf"]
    assert one_of == [
        {"const": "equal"},
        {"type": "number", "exclusiveMinimum": 0, "maximum": 1},
    ]


def test_compatibility_equals_is_compatible_enumeration(client: TestClient) -> None:
    body = client.get("/v1/node-types").json()
    expected = [
        CompatibilityPairDto(source=source, destination=destination).model_dump(
            mode="json", by_alias=True
        )
        for source in PORT_TYPE_LATTICE
        for destination in PORT_TYPE_LATTICE
        if is_compatible(source, destination)
    ]
    assert body["compatibility"] == expected


def test_digest_recomputes_and_is_stable(client: TestClient) -> None:
    first = client.get("/v1/node-types")
    # Recompute the digest the way a client does: hash the served body EXCLUDING the identity
    # fields. Keying on the exclusion (not a hardcoded payload-key list) covers future fields.
    served = first.json()
    body = {k: v for k, v in served.items() if k not in CATALOG_IDENTITY_FIELDS}
    assert catalog_digest(body) == served["catalog_digest"]
    second = client.get("/v1/node-types")
    assert first.content == second.content


def test_response_validates_against_committed_schema(
    client: TestClient, def_validator: Callable[[str], Draft202012Validator]
) -> None:
    payload = client.get("/v1/node-types").json()
    errors = sorted(def_validator("NodeCatalogResponse").iter_errors(payload), key=str)
    assert not errors, "; ".join(e.message for e in errors[:5])


def test_versions(client: TestClient) -> None:
    body = client.get("/v1/node-types").json()
    assert body["api_version"] == "v1"
    assert body["schema_version"] == CURRENT_SCHEMA_VERSION


def test_catalog_golden(client: TestClient, update_goldens: bool) -> None:
    response = client.get("/v1/node-types")
    assert_summary_matches_golden("node_catalog", response.json(), update_goldens)
