"""M9.2: the ``GET /v1/meta`` identity endpoint."""

from __future__ import annotations

from fastapi.testclient import TestClient

from quantize.persistence.records import RECORD_FORMAT, TRACE_FORMAT
from quantize.schema.version import CURRENT_SCHEMA_VERSION


def test_meta_reports_versions(client: TestClient) -> None:
    response = client.get("/v1/meta")
    assert response.status_code == 200
    assert response.json() == {
        "api_version": "v1",
        "schema_version": CURRENT_SCHEMA_VERSION,
        "record_format": RECORD_FORMAT,
        "trace_format": TRACE_FORMAT,
    }


def test_meta_format_versions_match_persistence_constants(client: TestClient) -> None:
    body = client.get("/v1/meta").json()
    assert body["record_format"] == 2
    assert body["trace_format"] == 1
    assert body["schema_version"] == "0.1.0"
