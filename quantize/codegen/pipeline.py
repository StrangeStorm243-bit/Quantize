"""The ``generate`` and ``check`` operations that tie the codegen steps together.

``generate`` writes the committed artifacts; ``check`` verifies them without touching the working
tree (so it is safe to run in CI and as a pre-commit gate). Both build everything from the pinned
Pydantic models, so a drift between the models and the committed artifacts is always detected.
"""

from __future__ import annotations

from pathlib import Path

from quantize.codegen.schema import (
    REPO_ROOT,
    SCHEMA_PATH,
    TS_PATH,
    build_bundle,
    build_ts_input,
    canonical_json,
)
from quantize.codegen.typescript import generate_typescript


def _read_text(path: Path) -> str | None:
    """Return the file's text with LF newlines, or None if it does not exist."""
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def _build_expected() -> tuple[str, str]:
    """Return the (schema_text, typescript_text) the committed artifacts should contain."""
    bundle = build_bundle()
    schema_text = canonical_json(bundle)
    ts_text = generate_typescript(build_ts_input(bundle), REPO_ROOT)
    return schema_text, ts_text


def generate() -> list[Path]:
    """Emit the JSON Schema and TypeScript artifacts. Returns the paths written."""
    schema_text, ts_text = _build_expected()
    SCHEMA_PATH.parent.mkdir(parents=True, exist_ok=True)
    TS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_PATH.write_text(schema_text, encoding="utf-8", newline="\n")
    TS_PATH.write_text(ts_text, encoding="utf-8", newline="\n")
    return [SCHEMA_PATH, TS_PATH]


def check() -> list[str]:
    """Return a list of staleness errors (empty == artifacts are current). Performs no writes."""
    schema_text, ts_text = _build_expected()
    errors: list[str] = []
    for path, expected in ((SCHEMA_PATH, schema_text), (TS_PATH, ts_text)):
        actual = _read_text(path)
        rel = path.relative_to(REPO_ROOT)
        if actual is None:
            errors.append(f"{rel} is missing; run `python -m quantize.codegen generate`.")
        elif actual != expected:
            errors.append(f"{rel} is stale; run `python -m quantize.codegen generate`.")
    return errors
