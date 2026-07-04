"""M9.4: strategy + component save/list/load endpoints.

Covers the immutable-save semantics (idempotent 200 vs new 201, divergent 409), the ui-only-edit
409 (founder decision #1's default — a ``ui.*`` change alters the bytes, so the immutable store
rejects it under the same version; this test is named so flipping the decision is one edit),
verbatim byte-preserving loads, listing, and the parse/version error taxonomy.
"""

from __future__ import annotations

import copy
import json
from typing import Any

from fastapi.testclient import TestClient

from quantize.api.settings import ApiSettings
from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument
from quantize.schema.serialization import to_ir_json
from tests.helpers import load_fixture

_JSON = {"content-type": "application/json"}


def _post(client: TestClient, path: str, payload: Any) -> Any:
    return client.post(path, content=json.dumps(payload), headers=_JSON)


# --- strategies -------------------------------------------------------------------------------


def test_save_new_strategy_returns_201(client: TestClient, db: ApiSettings) -> None:
    doc = load_fixture("strategy_a")
    response = _post(client, "/v1/strategies", doc)
    assert response.status_code == 201
    assert response.json() == {"strategy_id": doc["strategy"]["id"], "version": 1}


def test_idempotent_resave_returns_200_same_body(client: TestClient, db: ApiSettings) -> None:
    doc = load_fixture("strategy_a")
    first = _post(client, "/v1/strategies", doc)
    second = _post(client, "/v1/strategies", doc)
    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json() == second.json()


def test_divergent_bytes_same_version_conflicts_409(client: TestClient, db: ApiSettings) -> None:
    doc = load_fixture("strategy_a")
    _post(client, "/v1/strategies", doc)
    diverged = copy.deepcopy(doc)
    diverged["nodes"][0]["params"] = {**diverged["nodes"][0]["params"], "injected": 123}
    response = _post(client, "/v1/strategies", diverged)
    assert response.status_code == 409
    assert response.json()["code"] == "artifact_conflict"


def test_ui_only_edit_under_same_version_conflicts_409(client: TestClient, db: ApiSettings) -> None:
    """Founder decision #1 default: a ui-only change under an unchanged version is a 409 (the
    client must bump the version). Flip this single test if the decision changes."""
    doc = load_fixture("strategy_a")
    _post(client, "/v1/strategies", doc)
    ui_only = copy.deepcopy(doc)
    ui_only["nodes"][0]["ui"] = {"x": 42, "y": 7}  # ui.* alters bytes but not semantics
    response = _post(client, "/v1/strategies", ui_only)
    assert response.status_code == 409


def test_load_strategy_returns_verbatim_bytes(client: TestClient, db: ApiSettings) -> None:
    doc = load_fixture("strategy_a")
    _post(client, "/v1/strategies", doc)
    response = client.get(f"/v1/strategies/{doc['strategy']['id']}/versions/1")
    assert response.status_code == 200
    expected = to_ir_json(StrategyDocument.model_validate(doc))
    assert response.text == expected  # byte-for-byte canonical stored form
    assert response.headers["content-type"].startswith("application/json")


def test_list_strategies_and_versions(client: TestClient, db: ApiSettings) -> None:
    doc = load_fixture("strategy_a")
    _post(client, "/v1/strategies", doc)
    listing = client.get("/v1/strategies")
    assert listing.status_code == 200
    rows = listing.json()["strategies"]
    assert any(r["strategy_id"] == doc["strategy"]["id"] and r["version"] == 1 for r in rows)

    versions = client.get(f"/v1/strategies/{doc['strategy']['id']}/versions")
    assert versions.status_code == 200
    assert versions.json() == {"versions": [1]}


def test_versions_of_unknown_strategy_is_404(client: TestClient, db: ApiSettings) -> None:
    response = client.get("/v1/strategies/does-not-exist/versions")
    assert response.status_code == 404
    assert response.json()["code"] == "artifact_not_found"


def test_load_unknown_strategy_version_is_404(client: TestClient, db: ApiSettings) -> None:
    doc = load_fixture("strategy_a")
    _post(client, "/v1/strategies", doc)
    response = client.get(f"/v1/strategies/{doc['strategy']['id']}/versions/999")
    assert response.status_code == 404


def test_unsupported_schema_version_is_422(client: TestClient, db: ApiSettings) -> None:
    doc = load_fixture("strategy_a")
    doc["schema_version"] = "0.2.0"  # well-formed SemVer, unsupported
    response = _post(client, "/v1/strategies", doc)
    assert response.status_code == 422
    assert response.json()["code"] == "unsupported_schema_version"


def test_malformed_body_is_400(client: TestClient, db: ApiSettings) -> None:
    response = client.post("/v1/strategies", content="{not valid json", headers=_JSON)
    assert response.status_code == 400


def test_structurally_wrong_body_is_400(client: TestClient, db: ApiSettings) -> None:
    """Valid JSON, supported schema_version, but not a StrategyDocument → 400 (shape failure)."""
    response = _post(client, "/v1/strategies", {"schema_version": "0.1.0", "nonsense": True})
    assert response.status_code == 400


# --- components -------------------------------------------------------------------------------


def test_save_and_load_component_semver_roundtrip(client: TestClient, db: ApiSettings) -> None:
    comp = load_fixture("component_a")
    saved = _post(client, "/v1/components", comp)
    assert saved.status_code == 201
    assert saved.json() == {"component_id": comp["component_id"], "version": comp["version"]}

    # SemVer string path param round-trips
    loaded = client.get(f"/v1/components/{comp['component_id']}/versions/{comp['version']}")
    assert loaded.status_code == 200
    assert loaded.text == to_ir_json(ComponentDefinition.model_validate(comp))


def test_component_idempotent_resave_is_200(client: TestClient, db: ApiSettings) -> None:
    comp = load_fixture("component_a")
    assert _post(client, "/v1/components", comp).status_code == 201
    assert _post(client, "/v1/components", comp).status_code == 200


def test_component_list_and_404(client: TestClient, db: ApiSettings) -> None:
    comp = load_fixture("component_a")
    _post(client, "/v1/components", comp)
    listing = client.get("/v1/components")
    assert any(r["component_id"] == comp["component_id"] for r in listing.json()["components"])
    missing = client.get("/v1/components/does-not-exist/versions/9.9.9")
    assert missing.status_code == 404
