"""M9.8: cross-cutting hardening sweeps + automated self-review checks.

These run against EVERY POST route uniformly (not per-endpoint): the body-size cap and the
depth-safe Rust parse path must hold everywhere. Plus two boundary invariants as executable
checks: the API layer carries no numerics (no pandas/numpy), and the exposed endpoint set matches
the contract.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from quantize.api.app import create_app
from quantize.api.settings import DEFAULT_MAX_BODY_BYTES, ApiSettings

_JSON = {"content-type": "application/json"}

# Every production POST route (the fixture-only /_test/* echo is excluded by construction).
_POST_ROUTES = (
    "/v1/strategies",
    "/v1/strategies/validate",
    "/v1/components",
    "/v1/datasets",
    "/v1/runs/backtest",
    "/v1/runs/forward",
)


@pytest.mark.parametrize("path", _POST_ROUTES)
def test_every_post_route_enforces_the_body_cap(
    client: TestClient, db: ApiSettings, path: str
) -> None:
    oversized = b"x" * (DEFAULT_MAX_BODY_BYTES + 1)
    response = client.post(path, content=oversized, headers=_JSON)
    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"


@pytest.mark.parametrize("path", _POST_ROUTES)
def test_every_post_route_is_depth_bomb_safe(
    client: TestClient, db: ApiSettings, path: str
) -> None:
    """A 2000-deep payload resolves to a clean 400/422 on the Rust parse path — never a 500."""
    bomb = "[" * 2000 + "]" * 2000
    response = client.post(path, content=bomb, headers=_JSON)
    assert response.status_code in (400, 422)


# --- self-review invariants as executable checks ----------------------------------------------


def test_api_layer_has_no_numerics() -> None:
    """Boundary purity (AGENTS.md checklist): quantize/api imports no pandas/numpy — all
    numerical/portfolio logic stays in the domain packages."""
    banned = re.compile(r"^\s*(import|from)\s+(pandas|numpy)\b", re.MULTILINE)
    offenders = [
        str(path)
        for path in Path("quantize/api").rglob("*.py")
        if banned.search(path.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_exposed_endpoints_match_the_contract() -> None:
    """The production app exposes exactly the §Contracts endpoint set — no more, no fewer."""
    paths = set(create_app().openapi()["paths"])
    assert paths == {
        "/v1/meta",
        "/v1/strategies",
        "/v1/strategies/validate",
        "/v1/strategies/{strategy_id}/versions",
        "/v1/strategies/{strategy_id}/versions/{version}",
        "/v1/node-types",
        "/v1/components",
        "/v1/components/{component_id}/versions/{version}",
        "/v1/datasets",
        "/v1/datasets/{dataset_id}",
        "/v1/runs/backtest",
        "/v1/runs/forward",
        "/v1/runs",
        "/v1/runs/{run_id}",
        "/v1/runs/{run_id}/trace",
    }
