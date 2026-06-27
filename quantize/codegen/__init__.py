"""Deterministic Quantize IR code generation (M1.3).

Pipeline: Pydantic IR models -> bundled JSON Schema artifact -> TypeScript declaration artifact.
The JSON Schema is the exported, language-neutral structural contract; the TypeScript is a derived
artifact. Both are committed and verified by a staleness gate (`check`); neither is hand-edited.

Run as a module:

    python -m quantize.codegen generate   # write schema/ and ts/ artifacts
    python -m quantize.codegen check       # verify committed artifacts are current (no writes)
"""

from quantize.codegen.pipeline import check, generate
from quantize.codegen.schema import (
    SCHEMA_PATH,
    TS_PATH,
    build_bundle,
    build_ts_input,
    canonical_json,
)
from quantize.codegen.typescript import CodegenToolError, generate_typescript

__all__ = [
    "SCHEMA_PATH",
    "TS_PATH",
    "CodegenToolError",
    "build_bundle",
    "build_ts_input",
    "canonical_json",
    "check",
    "generate",
    "generate_typescript",
]
