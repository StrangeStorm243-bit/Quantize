"""Pytest configuration: the golden-update switch (M4 plan, golden format section) plus the shared
per-test ``db`` and per-module ``market`` fixtures used across the persistence/value-tap suites."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from quantize.market.data import MarketDataSet
from quantize.persistence.database import Database
from tests.market_fixture import build_market_fixture


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--update-goldens",
        action="store_true",
        default=False,
        help="Rewrite committed golden files from the current run (review the diff!).",
    )


@pytest.fixture
def update_goldens(request: pytest.FixtureRequest) -> bool:
    return bool(request.config.getoption("--update-goldens"))


@pytest.fixture
def db(tmp_path: Path) -> Iterator[Database]:
    database = Database(tmp_path / "q.db")
    yield database
    database.close()


@pytest.fixture(scope="module")
def market() -> MarketDataSet:
    return build_market_fixture()
