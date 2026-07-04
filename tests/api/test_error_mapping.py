"""M9.2: the per-(endpoint-class, code) error taxonomy.

Two layers of assertion (audit M4):

* **Unit** — the pure mapping functions, one construction per persistence code, asserting status
  and body shape INCLUDING context scrubbing (no server path, no ``context`` field leaks).
* **End-to-end** — through ``TestClient`` against the fixture-only ``/_test/*`` routes, proving the
  registered handlers and the body-size middleware behave (400 parse, 413 cap, 503/500 render).
  The same assertions re-run against REAL routes in M9.4/M9.5.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from quantize.api.errors import (
    ApiRequestError,
    api_request_error_response,
    persistence_error_response,
    status_for_persistence_code,
)
from quantize.api.settings import DEFAULT_MAX_BODY_BYTES
from quantize.persistence.errors import (
    ARTIFACT_CONFLICT,
    ARTIFACT_NOT_FOUND,
    CORRUPT_ARTIFACT,
    CORRUPT_DATABASE,
    DATABASE_LOCKED,
    INVALID_ARTIFACT,
    UNSUPPORTED_ARTIFACT_VERSION,
    UNSUPPORTED_DATABASE_VERSION,
    PersistenceError,
)

# --- Unit: the mapping table ------------------------------------------------------------------

_EXPECTED_STATUS = {
    ARTIFACT_NOT_FOUND: 404,
    ARTIFACT_CONFLICT: 409,
    DATABASE_LOCKED: 503,
    INVALID_ARTIFACT: 500,  # global default; client-save routes re-map to 422 locally
    UNSUPPORTED_ARTIFACT_VERSION: 500,  # load-side, not client-submittable (plan amendment)
    CORRUPT_ARTIFACT: 500,
    CORRUPT_DATABASE: 500,
    UNSUPPORTED_DATABASE_VERSION: 500,
}


def test_status_for_each_persistence_code() -> None:
    for code, status in _EXPECTED_STATUS.items():
        assert status_for_persistence_code(code) == status


def test_unknown_code_defaults_to_500() -> None:
    assert status_for_persistence_code("some_future_code") == 500


def test_persistence_response_scrubs_context() -> None:
    """The ``corrupt_database`` context (server filesystem path) must never reach the client."""
    error = PersistenceError(
        CORRUPT_DATABASE, "database file is unreadable", {"path": "/server/secret/quantize.db"}
    )
    response = persistence_error_response(error)
    assert response.status_code == 500
    body = json.loads(bytes(response.body))
    assert body == {"code": "corrupt_database", "message": "database file is unreadable"}
    assert "context" not in body
    assert "/server/secret" not in bytes(response.body).decode()


def test_database_locked_carries_retry_after() -> None:
    response = persistence_error_response(PersistenceError(DATABASE_LOCKED, "busy"))
    assert response.status_code == 503
    assert "retry-after" in {k.lower() for k in response.headers}


def test_api_request_error_renders_envelope() -> None:
    response = api_request_error_response(ApiRequestError(400, "invalid_json", "bad body"))
    assert response.status_code == 400
    assert json.loads(bytes(response.body)) == {"code": "invalid_json", "message": "bad body"}


# --- End-to-end through the fixture-only routes -----------------------------------------------


def test_echo_roundtrips_valid_json(client: TestClient) -> None:
    response = client.post("/_test/echo", content=json.dumps({"a": 1}))
    assert response.status_code == 200
    assert response.json() == {"echoed": {"a": 1}}


def test_unparseable_body_is_400(client: TestClient) -> None:
    response = client.post("/_test/echo", content="{not json")
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_json"


def test_oversized_body_is_413_via_middleware(client: TestClient) -> None:
    """A body over the cap is rejected before the route runs (streamed-guard path)."""
    oversized = b"x" * (DEFAULT_MAX_BODY_BYTES + 1)
    response = client.post("/_test/echo", content=oversized)
    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"


def test_lying_content_length_still_capped(client: TestClient) -> None:
    """A header claiming a small size cannot smuggle an oversized body past the cap."""
    oversized = b"x" * (DEFAULT_MAX_BODY_BYTES + 1)
    response = client.post("/_test/echo", content=oversized, headers={"content-length": "5"})
    assert response.status_code == 413


def test_persistence_error_maps_end_to_end(client: TestClient) -> None:
    response = client.post(
        "/_test/raise-persistence",
        content=json.dumps({"code": DATABASE_LOCKED, "message": "contended"}),
    )
    assert response.status_code == 503
    assert response.json() == {"code": "database_locked", "message": "contended"}
    assert "/server/secret" not in response.text


def test_corrupt_database_context_not_leaked_end_to_end(client: TestClient) -> None:
    response = client.post(
        "/_test/raise-persistence",
        content=json.dumps({"code": CORRUPT_DATABASE, "message": "unreadable"}),
    )
    assert response.status_code == 500
    assert "context" not in response.json()
    assert "/server/secret" not in response.text
