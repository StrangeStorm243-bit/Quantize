"""Shared test helpers: loading the committed reference-strategy fixtures."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict[str, Any]:
    """Return the parsed JSON of a committed fixture (e.g. ``"strategy_a"``)."""
    raw = (_FIXTURES / f"{name}.json").read_text(encoding="utf-8")
    data: dict[str, Any] = json.loads(raw)
    return data
