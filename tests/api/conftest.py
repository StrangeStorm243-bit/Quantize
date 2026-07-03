"""Shared API test fixtures.

The ``TestClient`` is module-scoped (built once, runs the app in-process — **no network**); each
test gets an isolated ``tmp_path`` SQLite DB by overriding ``get_settings`` (the ``db`` fixture).
The fixture app additionally mounts a **test-only** router (``/_test/*``) that exists ONLY here —
never in ``create_app()`` — to exercise the error/middleware paths end-to-end before the real POST
routes land (M9.4+). Those same assertions re-run against real routes later.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from quantize.api.app import create_app
from quantize.api.errors import INVALID_JSON, ApiRequestError
from quantize.api.settings import ApiSettings, get_settings
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository
from quantize.persistence.errors import PersistenceError
from tests.helpers import load_fixture
from tests.market_fixture import build_market_fixture


def _test_only_router() -> APIRouter:
    """Routes present ONLY in the fixture app: they drive handler/middleware paths generically."""
    router = APIRouter(prefix="/_test")

    @router.post("/echo")
    async def echo(request: Request) -> dict[str, object]:
        raw = await request.body()  # within the cap: the middleware already 413'd oversize bodies
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ApiRequestError(
                400, INVALID_JSON, f"request body is not valid JSON: {error}"
            ) from error
        return {"echoed": parsed}

    @router.post("/raise-persistence")
    async def raise_persistence(request: Request) -> dict[str, object]:
        body = await request.body()
        payload = json.loads(body)
        # context carries a would-be-leaked server path; the handler must scrub it.
        raise PersistenceError(
            payload["code"], payload["message"], {"path": "/server/secret/quantize.db"}
        )

    return router


def _build_test_app(settings: ApiSettings) -> FastAPI:
    app = create_app(settings=settings)
    app.dependency_overrides[get_settings] = lambda: settings
    app.include_router(_test_only_router())
    return app


@pytest.fixture(scope="module")
def _module_settings(tmp_path_factory: pytest.TempPathFactory) -> ApiSettings:
    db = tmp_path_factory.mktemp("api-module") / "quantize.db"
    return ApiSettings(db_path=str(db))


@pytest.fixture(scope="module")
def app(_module_settings: ApiSettings) -> FastAPI:
    return _build_test_app(_module_settings)


@pytest.fixture(scope="module")
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as test_client:  # context-manager form runs lifespan (warm-up open)
        yield test_client


@pytest.fixture
def db(app: FastAPI, tmp_path: Path) -> Iterator[ApiSettings]:
    """Point handlers at a fresh per-test DB; restore the module default afterwards."""
    settings = ApiSettings(db_path=str(tmp_path / "quantize.db"))
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        yield settings
    finally:
        module_default = app.state.settings
        app.dependency_overrides[get_settings] = lambda: module_default


@pytest.fixture
def seeded(client: TestClient, db: ApiSettings) -> SimpleNamespace:
    """Seed Strategy A (via the API) and the reference market dataset (via the repository, same DB
    file) so run tests have valid ``strategy_id``/``version``/``dataset_id`` to submit against."""
    document = load_fixture("strategy_a")
    saved = client.post(
        "/v1/strategies",
        content=json.dumps(document),
        headers={"content-type": "application/json"},
    )
    assert saved.status_code == 201
    with Database(db.db_path) as database:
        info, _ = DatasetRepository(database).save(build_market_fixture())
    return SimpleNamespace(
        strategy_id=document["strategy"]["id"], version=1, dataset_id=info.dataset_id
    )
