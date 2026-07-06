"""M12.6a: the onboarding seed script, driven against the in-process API (no network).

The script (``scripts/seed_demo.py``) is stdlib-only and transport-injected: ``seed(post)`` takes a
``post(path, payload) -> (status, json)`` callable, so the test wires a ``TestClient``-backed
lambda and the ``__main__`` shim wires a urllib one. Here we prove the serialized fixture uploads
to the SAME content-addressed dataset the repository would store for ``build_market_fixture()``
(fingerprint identity), both reference strategies save, and a second run is idempotent (200s).
"""

from __future__ import annotations

import importlib.util
import json
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from fastapi.testclient import TestClient

from quantize.api.app import create_app
from quantize.api.settings import ApiSettings, get_settings
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository
from quantize.persistence.provenance import calendar_fingerprint, dataset_fingerprint
from tests.market_fixture import build_market_fixture

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SEED_PATH = _REPO_ROOT / "scripts" / "seed_demo.py"
_JSON = {"content-type": "application/json"}


def _load_seed_module() -> ModuleType:
    """Load ``scripts/seed_demo.py`` by path (``scripts`` is not an importable package)."""
    spec = importlib.util.spec_from_file_location("seed_demo", _SEED_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


seed_demo = _load_seed_module()


class _RecordingPost:
    """A ``post`` transport backed by the in-process TestClient that records each call's status."""

    def __init__(self, client: TestClient) -> None:
        self._client = client
        self.calls: list[tuple[str, int]] = []

    def __call__(self, path: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        response = self._client.post(path, content=json.dumps(payload), headers=_JSON)
        self.calls.append((path, response.status_code))
        return response.status_code, response.json()


@pytest.fixture
def api(tmp_path: Path) -> Iterator[tuple[TestClient, ApiSettings]]:
    """A fresh in-process app + isolated tmp DB (like tests/api/conftest.py, but self-contained)."""
    settings = ApiSettings(db_path=str(tmp_path / "quantize.db"))
    app = create_app(settings=settings)
    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as client:  # context-manager form runs lifespan (DB warm-up)
        yield client, settings


def test_dataset_upload_payload_matches_dto_shape() -> None:
    payload = seed_demo.dataset_upload_payload()
    assert set(payload) == {"calendar", "observations"}
    assert set(payload["calendar"]) == {"exchange", "timezone", "sessions"}
    session = payload["calendar"]["sessions"][0]
    assert set(session) == {"session_date", "open_at", "close_at"}
    assert isinstance(session["session_date"], str) and isinstance(session["open_at"], str)
    # The fixture carries eight assets, each a list of observation rows with the DTO field names.
    assert len(payload["observations"]) == 8
    row = payload["observations"]["SPY"][0]
    assert set(row) == {
        "session_date",
        "open_price",
        "close_price",
        "open_available_at",
        "close_available_at",
    }
    assert isinstance(row["open_price"], float) and isinstance(row["session_date"], str)


def test_seed_uploads_dataset_matching_fixture_fingerprints(
    api: tuple[TestClient, ApiSettings],
) -> None:
    client, settings = api
    post = _RecordingPost(client)

    summary = seed_demo.seed(post)

    # The dataset POST created (201) and its content-addressed identity/fingerprints equal what the
    # repository derives directly from build_market_fixture() — the serialization round-trips.
    assert post.calls[0] == ("/v1/datasets", 201)
    fixture = build_market_fixture()
    with Database(settings.db_path) as database:
        info = DatasetRepository(database).describe(summary["dataset_id"])
    assert info.dataset_id == summary["dataset_id"]
    assert info.dataset_fingerprint == dataset_fingerprint(fixture)
    assert info.calendar_fingerprint == calendar_fingerprint(fixture.calendar)
    assert info.assets == 8


def test_seed_saves_both_reference_strategies(api: tuple[TestClient, ApiSettings]) -> None:
    client, _ = api
    post = _RecordingPost(client)

    summary = seed_demo.seed(post)

    # Both strategy POSTs created (201).
    assert [status for path, status in post.calls if path == "/v1/strategies"] == [201, 201]
    names = {entry["name"] for entry in summary["strategies"]}
    assert names == {"ETF Momentum Rotation", "Trend-Filtered Portfolio"}
    for entry in summary["strategies"]:
        assert entry["version"] == 1
        assert isinstance(entry["id"], str) and entry["id"]


def test_suggested_window_is_the_strategy_a_evaluation_span(
    api: tuple[TestClient, ApiSettings],
) -> None:
    client, _ = api
    summary = seed_demo.seed(_RecordingPost(client))
    assert summary["suggested_window"] == {
        "first_session": "2025-07-31",
        "last_session": "2025-08-29",
    }


def test_second_seed_run_is_idempotent(api: tuple[TestClient, ApiSettings]) -> None:
    client, _ = api
    first = _RecordingPost(client)
    first_summary = seed_demo.seed(first)
    assert all(status == 201 for _, status in first.calls)

    second = _RecordingPost(client)
    second_summary = seed_demo.seed(second)
    # Content-addressed dataset + immutable strategy versions ⇒ every re-POST is a 200 no-op.
    assert all(status == 200 for _, status in second.calls)
    # A re-run reports the same identities.
    assert second_summary["dataset_id"] == first_summary["dataset_id"]
    assert second_summary["strategies"] == first_summary["strategies"]
