"""The ``generate`` and ``check`` operations that tie the codegen steps together.

``generate`` writes the committed artifacts; ``check`` verifies them without touching the working
tree (so it is safe to run in CI and as a pre-commit gate). Both build everything from the pinned
Pydantic models, so a drift between the models and the committed artifacts is always detected.
Every governed bundle in ``BUNDLES`` (the IR contract and the M9 API contract) is generated and
checked identically.
"""

from __future__ import annotations

from pathlib import Path

from quantize.codegen.schema import (
    BUNDLES,
    REPO_ROOT,
    BundleSpec,
    build_ts_input,
    canonical_json,
)
from quantize.codegen.typescript import generate_typescript


def _read_text(path: Path) -> str | None:
    """Return the file's text with LF newlines, or None if it does not exist."""
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def _expected_for(spec: BundleSpec) -> tuple[str, str]:
    """Return the (schema_text, typescript_text) *spec*'s committed artifacts should contain."""
    bundle = spec.build()
    schema_text = canonical_json(bundle)
    ts_text = generate_typescript(build_ts_input(bundle), REPO_ROOT)
    return schema_text, ts_text


def generate() -> list[Path]:
    """Emit every bundle's JSON Schema and TypeScript artifacts. Returns the paths written."""
    written: list[Path] = []
    for spec in BUNDLES:
        schema_text, ts_text = _expected_for(spec)
        spec.schema_path.parent.mkdir(parents=True, exist_ok=True)
        spec.ts_path.parent.mkdir(parents=True, exist_ok=True)
        spec.schema_path.write_text(schema_text, encoding="utf-8", newline="\n")
        spec.ts_path.write_text(ts_text, encoding="utf-8", newline="\n")
        written.extend((spec.schema_path, spec.ts_path))
    return written


def check() -> list[str]:
    """Return a list of staleness errors (empty == all artifacts current). Performs no writes."""
    errors: list[str] = []
    for spec in BUNDLES:
        schema_text, ts_text = _expected_for(spec)
        for path, expected in ((spec.schema_path, schema_text), (spec.ts_path, ts_text)):
            actual = _read_text(path)
            rel = path.relative_to(REPO_ROOT)
            if actual is None:
                errors.append(f"{rel} is missing; run `python -m quantize.codegen generate`.")
            elif actual != expected:
                errors.append(f"{rel} is stale; run `python -m quantize.codegen generate`.")
    return errors
