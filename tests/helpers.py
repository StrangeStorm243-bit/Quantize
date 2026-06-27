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


def load_invalid_fixture(name: str) -> dict[str, Any]:
    """Return the parsed JSON of a deliberately-invalid fixture under ``fixtures/invalid/``.

    These are structurally invalid (M1.2) but **parse** cleanly under the M1.1 models — the
    point of M1.2 validation is to catch faults Pydantic cannot express.
    """
    raw = (_FIXTURES / "invalid" / f"{name}.json").read_text(encoding="utf-8")
    data: dict[str, Any] = json.loads(raw)
    return data
