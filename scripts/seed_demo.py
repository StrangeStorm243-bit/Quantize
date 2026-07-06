"""Seed a running Quantize API with the demo dataset + the two reference strategies (M12.6a).

Onboarding helper: a new user launches the API (``uvicorn quantize.api.app:create_app --factory``)
and runs ``python scripts/seed_demo.py`` to populate their local workspace with everything the
README journey needs — the deterministic synthetic market dataset and Strategies A/B — then loads a
strategy in the editor and runs a backtest over the suggested window.

Design (matches docs/plans/2026-07-05-m12-implementation-plan.md §4 E12):

* **stdlib only** — ``urllib`` for the HTTP transport; no new dependencies.
* **transport-injected** — the work lives in ``seed(post)`` where ``post(path, payload) ->
  (status, json)`` is a caller-supplied callable. ``__main__`` wires a urllib-backed ``post`` bound
  to a base URL; the test wires an in-process ``TestClient`` one (so the tests need no network).
* **idempotent by the API contract** — the dataset is content-addressed and strategy versions are
  immutable, so a re-run is a sequence of harmless 200 no-ops.

``dataset_upload_payload()`` is the inverse of the M9.6 server-side conversion
(``quantize/api/routes/datasets.py:_to_market_dataset``): it serializes the frozen ``MarketDataSet``
domain dataclasses back into the ``DatasetUpload`` JSON shape (``quantize/api/dto/datasets.py``) —
dates and instants as ISO strings, prices as JSON numbers.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

# ``scripts`` is not an importable package; put the repo root on the path so ``python
# scripts/seed_demo.py`` can import the fixture builder (harmless when already importable, e.g.
# under pytest). Deriving the dataset from the single fixture source keeps it authoritative (E12).
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tests.market_fixture import build_market_fixture  # noqa: E402  (after the sys.path insert)

# The transport seam: (path, json-serializable payload) -> (HTTP status, parsed JSON body).
Post = Callable[[str, dict[str, Any]], "tuple[int, dict[str, Any]]"]

DEFAULT_BASE_URL = "http://127.0.0.1:8000"
_BASE_URL_ENV = "QUANTIZE_API_URL"

# Strategy A's two monthly evaluations both fall inside this window, so a backtest over it is small
# and hand-checkable (mirrors tests/api/test_run_endpoint.py).
SUGGESTED_WINDOW = {"first_session": "2025-07-31", "last_session": "2025-08-29"}

_STRATEGY_FIXTURES = ("strategy_a", "strategy_b")
_FIXTURES_DIR = _REPO_ROOT / "tests" / "fixtures"


class SeedError(RuntimeError):
    """A seed step returned a non-2xx status (the API rejected the dataset or a strategy)."""


def dataset_upload_payload() -> dict[str, Any]:
    """Serialize ``build_market_fixture()`` into the ``DatasetUpload`` JSON shape.

    The inverse of the route's ``_to_market_dataset``: the calendar's sessions and each asset's
    observation rows, with every ``date``/``datetime`` rendered as an ISO string and every price as
    a JSON number — exactly the field names ``CalendarDto``/``SessionDto``/``ObservationDto`` pin.
    """
    market = build_market_fixture()
    calendar = market.calendar
    return {
        "calendar": {
            "exchange": calendar.exchange,
            "timezone": calendar.timezone,
            "sessions": [
                {
                    "session_date": session.session_date.isoformat(),
                    "open_at": session.open_at.isoformat(),
                    "close_at": session.close_at.isoformat(),
                }
                for session in calendar.sessions
            ],
        },
        "observations": {
            asset: [
                {
                    "session_date": observation.session_date.isoformat(),
                    "open_price": observation.open_price,
                    "close_price": observation.close_price,
                    "open_available_at": observation.open_available_at.isoformat(),
                    "close_available_at": observation.close_available_at.isoformat(),
                }
                for observation in series
            ]
            for asset, series in market.observations.items()
        },
    }


def _load_strategy_fixture(name: str) -> dict[str, Any]:
    """The raw reference-strategy document (POSTed verbatim — proven saveable by the API tests)."""
    raw = (_FIXTURES_DIR / f"{name}.json").read_text(encoding="utf-8")
    document: dict[str, Any] = json.loads(raw)
    return document


def _post_ok(post: Post, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    """POST *payload* to *path*; return the JSON body or raise ``SeedError`` on a non-2xx status.

    201 (created) and 200 (idempotent no-op on re-run) are both success by the API contract.
    """
    status, body = post(path, payload)
    if status not in (200, 201):
        code = body.get("code") if isinstance(body, dict) else None
        message = body.get("message") if isinstance(body, dict) else None
        raise SeedError(f"POST {path} failed with status {status} ({code}: {message})")
    return body


def seed(post: Post) -> dict[str, Any]:
    """Seed the dataset + both reference strategies through *post*; return a summary.

    ``{"dataset_id": str, "strategies": [{"id", "version", "name"}, ...],
    "suggested_window": {"first_session", "last_session"}}``. Idempotent by the API contract.
    """
    dataset = _post_ok(post, "/v1/datasets", dataset_upload_payload())
    strategies: list[dict[str, Any]] = []
    for name in _STRATEGY_FIXTURES:
        document = _load_strategy_fixture(name)
        saved = _post_ok(post, "/v1/strategies", document)
        strategies.append(
            {
                "id": saved["strategy_id"],
                "version": saved["version"],
                # The save response carries only id+version; the human-readable name is the
                # document's own metadata (the endpoint does not echo it).
                "name": document["strategy"]["name"],
            }
        )
    return {
        "dataset_id": dataset["dataset_id"],
        "strategies": strategies,
        "suggested_window": dict(SUGGESTED_WINDOW),
    }


def _urllib_post(base_url: str) -> Post:
    """A urllib-backed ``post`` bound to *base_url* — the real over-HTTP transport for ``main``."""
    root = base_url.rstrip("/")

    def post(path: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        request = urllib.request.Request(
            root + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request) as response:  # noqa: S310 (localhost, documented)
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # A 4xx/5xx still carries a JSON error envelope ({"code", "message"}); surface it.
            body = error.read().decode("utf-8")
            try:
                parsed = json.loads(body)
            except json.JSONDecodeError:
                parsed = {"code": "http_error", "message": body}
            return error.code, parsed

    return post


def _print_summary(summary: dict[str, Any], base_url: str) -> None:
    window = summary["suggested_window"]
    print(f"Seeded {base_url} - demo dataset + reference strategies.\n")
    print(f"  dataset_id: {summary['dataset_id']}")
    print("  strategies:")
    for entry in summary["strategies"]:
        print(f"    - {entry['name']}  (id {entry['id']}, version {entry['version']})")
    print(f"\n  suggested backtest window: {window['first_session']}..{window['last_session']}\n")
    print("Next steps:")
    print("  1. Open the editor (npm run dev in web/) and load a strategy.")
    print("  2. Select the seeded dataset, then run a backtest over the suggested window.")
    print("  3. Inspect results and the decision trace; extract a subgraph into a component.")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    base_url = args[0] if args else os.environ.get(_BASE_URL_ENV, DEFAULT_BASE_URL)
    try:
        summary = seed(_urllib_post(base_url))
    except urllib.error.URLError as error:
        print(
            f"Could not reach the API at {base_url} ({error}).\n"
            "Start it first: uvicorn quantize.api.app:create_app --factory "
            "--host 127.0.0.1 --port 8000",
            file=sys.stderr,
        )
        return 1
    except SeedError as error:
        print(str(error), file=sys.stderr)
        return 1
    _print_summary(summary, base_url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
