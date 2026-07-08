"""M9.6: the dataset upload + fetch-metadata endpoints."""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from quantize.api.settings import DEFAULT_MAX_BODY_BYTES, ApiSettings

_JSON = {"content-type": "application/json"}


def _upload_payload(
    *,
    close_price: float = 10.5,
    close_available_at: str = "2026-01-05T21:00:00+00:00",
    open_price: float = 10.0,
) -> dict[str, Any]:
    return {
        "calendar": {
            "exchange": "QSE",
            "timezone": "UTC-05:00",
            "sessions": [
                {
                    "session_date": "2026-01-05",
                    "open_at": "2026-01-05T14:30:00+00:00",
                    "close_at": "2026-01-05T21:00:00+00:00",
                }
            ],
        },
        "observations": {
            "AAA": [
                {
                    "session_date": "2026-01-05",
                    "open_price": open_price,
                    "close_price": close_price,
                    "open_available_at": "2026-01-05T14:30:00+00:00",
                    "close_available_at": close_available_at,
                }
            ]
        },
    }


def _post(client: TestClient, payload: Any) -> Any:
    return client.post("/v1/datasets", content=json.dumps(payload), headers=_JSON)


def test_upload_returns_201_with_identities(client: TestClient, db: ApiSettings) -> None:
    response = _post(client, _upload_payload())
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {
        "dataset_id",
        "dataset_fingerprint",
        "calendar_fingerprint",
        "sessions",
        "assets",
        "first_session",
        "last_session",
        "asset_tickers",
    }
    assert len(body["dataset_id"]) == 64
    assert body["sessions"] == 1 and body["assets"] == 1


def _multi_session_payload() -> dict[str, Any]:
    """Two sessions, two assets (deliberately declared out of ticker order) — exercises the
    introspection projection's calendar bounds and canonical ticker ordering."""
    return {
        "calendar": {
            "exchange": "QSE",
            "timezone": "UTC-05:00",
            "sessions": [
                {
                    "session_date": "2026-01-05",
                    "open_at": "2026-01-05T14:30:00+00:00",
                    "close_at": "2026-01-05T21:00:00+00:00",
                },
                {
                    "session_date": "2026-01-06",
                    "open_at": "2026-01-06T14:30:00+00:00",
                    "close_at": "2026-01-06T21:00:00+00:00",
                },
            ],
        },
        "observations": {
            "ZZZ": [
                {
                    "session_date": "2026-01-05",
                    "open_price": 5.0,
                    "close_price": 5.5,
                    "open_available_at": "2026-01-05T14:30:00+00:00",
                    "close_available_at": "2026-01-05T21:00:00+00:00",
                },
            ],
            "AAA": [
                {
                    "session_date": "2026-01-06",
                    "open_price": 10.0,
                    "close_price": 10.5,
                    "open_available_at": "2026-01-06T14:30:00+00:00",
                    "close_available_at": "2026-01-06T21:00:00+00:00",
                },
            ],
        },
    }


def test_empty_calendar_upload_is_422(client: TestClient, db: ApiSettings) -> None:
    """An empty-calendar dataset has no sessions to introspect — rejected as invalid_dataset,
    never a 500 (regression: the introspection projection must not index an empty calendar)."""
    payload = {
        "calendar": {"exchange": "QSE", "timezone": "UTC-05:00", "sessions": []},
        "observations": {},
    }
    response = _post(client, payload)
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_dataset"


def test_describe_returns_introspection_projection(client: TestClient, db: ApiSettings) -> None:
    """M13.1: describe serves calendar bounds + canonical asset tickers (the Data Source card)."""
    dataset_id = _post(client, _multi_session_payload()).json()["dataset_id"]
    described = client.get(f"/v1/datasets/{dataset_id}").json()
    assert described["first_session"] == "2026-01-05"
    assert described["last_session"] == "2026-01-06"
    assert described["first_session"] <= described["last_session"]
    assert described["asset_tickers"] == ["AAA", "ZZZ"]  # ascending, not declaration order


def test_identical_reupload_is_200_same_id(client: TestClient, db: ApiSettings) -> None:
    first = _post(client, _upload_payload())
    second = _post(client, _upload_payload())
    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json()["dataset_id"] == second.json()["dataset_id"]


def test_fetch_metadata_roundtrip(client: TestClient, db: ApiSettings) -> None:
    dataset_id = _post(client, _upload_payload()).json()["dataset_id"]
    fetched = client.get(f"/v1/datasets/{dataset_id}")
    assert fetched.status_code == 200
    assert fetched.json()["dataset_id"] == dataset_id
    assert "payload" not in fetched.json()  # metadata only, never the data


def test_unknown_dataset_is_404(client: TestClient, db: ApiSettings) -> None:
    response = client.get(f"/v1/datasets/{'0' * 64}")
    assert response.status_code == 404
    assert response.json()["code"] == "artifact_not_found"


def test_non_positive_price_is_422_with_message(client: TestClient, db: ApiSettings) -> None:
    response = _post(client, _upload_payload(close_price=-5.0))
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "invalid_dataset"
    assert "positive" in body["message"]  # the domain constructor's message survives


def test_availability_before_session_close_is_422(client: TestClient, db: ApiSettings) -> None:
    early = "2026-01-05T20:00:00+00:00"  # before the 21:00 session close
    response = _post(client, _upload_payload(close_available_at=early))
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_dataset"


def test_malformed_json_is_400(client: TestClient, db: ApiSettings) -> None:
    response = client.post("/v1/datasets", content="{not json", headers=_JSON)
    assert response.status_code == 400


def test_wrong_dto_shape_is_422(client: TestClient, db: ApiSettings) -> None:
    """Valid JSON but not a DatasetUpload (missing calendar) → 422 (DTO-body semantics)."""
    response = _post(client, {"observations": {}})
    assert response.status_code == 422


def test_oversized_upload_is_413(client: TestClient, db: ApiSettings) -> None:
    oversized = b"x" * (DEFAULT_MAX_BODY_BYTES + 1)
    response = client.post("/v1/datasets", content=oversized, headers=_JSON)
    assert response.status_code == 413


def test_endpoint_observation_change_flips_dataset_id(client: TestClient, db: ApiSettings) -> None:
    base = _post(client, _upload_payload()).json()
    changed = _post(client, _upload_payload(close_price=11.0)).json()
    assert changed["dataset_id"] != base["dataset_id"]
    assert changed["dataset_fingerprint"] != base["dataset_fingerprint"]
    assert changed["calendar_fingerprint"] == base["calendar_fingerprint"]


# --- strict validation: reject inputs the governed schema rejects -----------------------------


def test_numeric_string_price_is_422(client: TestClient, db: ApiSettings) -> None:
    payload = _upload_payload()
    payload["observations"]["AAA"][0]["open_price"] = "10.0"  # schema: type number
    assert _post(client, payload).status_code == 422


def test_boolean_price_is_422(client: TestClient, db: ApiSettings) -> None:
    payload = _upload_payload()
    payload["observations"]["AAA"][0]["close_price"] = True  # bool is not a JSON number
    assert _post(client, payload).status_code == 422


def test_epoch_numeric_date_is_422(client: TestClient, db: ApiSettings) -> None:
    payload = _upload_payload()
    payload["observations"]["AAA"][0]["session_date"] = 123456  # schema: date string
    assert _post(client, payload).status_code == 422


def test_non_finite_price_is_422(client: TestClient, db: ApiSettings) -> None:
    """A non-finite JSON number (Infinity) is rejected (allow_inf_nan=False)."""
    raw = json.dumps(_upload_payload()).replace('"open_price": 10.0', '"open_price": Infinity')
    response = client.post("/v1/datasets", content=raw, headers=_JSON)
    assert response.status_code == 422
