"""M11.1: the dataset list endpoint (``GET /v1/datasets``).

Datasets become discoverable across sessions — the list mirrors the other list endpoints
(strategies/runs): a pure column read of the stored identity + provenance + ``saved_at``, never a
payload decode and never the per-dataset counts (those come from ``GET /v1/datasets/{id}``).
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from quantize.api.settings import ApiSettings

_JSON = {"content-type": "application/json"}


def _upload_payload(*, timezone: str = "UTC-05:00", close_price: float = 10.5) -> dict[str, Any]:
    return {
        "calendar": {
            "exchange": "QSE",
            "timezone": timezone,
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
                    "open_price": 10.0,
                    "close_price": close_price,
                    "open_available_at": "2026-01-05T14:30:00+00:00",
                    "close_available_at": "2026-01-05T21:00:00+00:00",
                }
            ]
        },
    }


def _post(client: TestClient, payload: Any) -> Any:
    return client.post("/v1/datasets", content=json.dumps(payload), headers=_JSON)


def test_list_empty_is_empty_array(client: TestClient, db: ApiSettings) -> None:
    response = client.get("/v1/datasets")
    assert response.status_code == 200
    assert response.json() == {"datasets": []}


def test_list_returns_uploaded_datasets(client: TestClient, db: ApiSettings) -> None:
    first = _post(client, _upload_payload()).json()
    # A calendar-only perturbation → a distinct dataset_id (second discoverable row).
    second = _post(client, _upload_payload(timezone="UTC+00:00")).json()

    response = client.get("/v1/datasets")
    assert response.status_code == 200
    rows = response.json()["datasets"]
    assert len(rows) == 2
    by_id = {row["dataset_id"]: row for row in rows}
    assert set(by_id) == {first["dataset_id"], second["dataset_id"]}
    for uploaded in (first, second):
        row = by_id[uploaded["dataset_id"]]
        assert set(row) == {
            "dataset_id",
            "dataset_fingerprint",
            "calendar_fingerprint",
            "saved_at",
        }
        assert row["dataset_fingerprint"] == uploaded["dataset_fingerprint"]
        assert row["calendar_fingerprint"] == uploaded["calendar_fingerprint"]
        assert isinstance(row["saved_at"], str) and row["saved_at"]


def test_list_row_omits_counts_and_payload(client: TestClient, db: ApiSettings) -> None:
    """The discovery row is stored columns only — no ``sessions``/``assets`` counts, no payload."""
    _post(client, _upload_payload())
    row = client.get("/v1/datasets").json()["datasets"][0]
    assert "sessions" not in row
    assert "assets" not in row
    assert "payload" not in row
