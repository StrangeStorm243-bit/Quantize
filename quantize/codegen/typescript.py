"""Generate the TypeScript declaration artifact from the bundled JSON Schema.

The Pydantic -> JSON Schema step (``schema.py``) is the contract; this step derives the TypeScript
the editor will consume. It shells out to the pinned ``json-schema-to-typescript`` (installed under
``node_modules`` via ``npm ci`` on Node 24). The generated ``.d.ts`` is a derived artifact and must
never be hand-edited — regenerate it from the schema instead.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from quantize.codegen.schema import canonical_json


class CodegenToolError(RuntimeError):
    """Raised when the Node toolchain (node / json-schema-to-typescript) is missing or fails."""


def _resolve_json2ts_cli(repo_root: Path) -> Path:
    """Return the absolute path to the json-schema-to-typescript CLI entry under node_modules."""
    pkg_dir = repo_root / "node_modules" / "json-schema-to-typescript"
    pkg_json = pkg_dir / "package.json"
    if not pkg_json.is_file():
        raise CodegenToolError(
            "json-schema-to-typescript is not installed. Run `npm ci` under Node 24 first "
            f"(expected {pkg_dir})."
        )
    bin_field = json.loads(pkg_json.read_text(encoding="utf-8")).get("bin")
    rel = bin_field if isinstance(bin_field, str) else (bin_field or {}).get("json2ts")
    if not rel:
        raise CodegenToolError(
            "json-schema-to-typescript exposes no `json2ts` bin entry (unexpected package layout)."
        )
    cli = pkg_dir / rel
    if not cli.is_file():
        raise CodegenToolError(f"json-schema-to-typescript CLI entry not found at {cli}.")
    return cli


def _normalize_eol(text: str) -> str:
    """Force LF and exactly one trailing newline, so output is byte-stable across OSes."""
    return text.replace("\r\n", "\n").rstrip("\n") + "\n"


def generate_typescript(ts_input: dict[str, Any], repo_root: Path) -> str:
    """Run the pinned generator over *ts_input* and return the normalized TypeScript text.

    Writes only to a temporary directory — never the working tree — so this is safe in `check`.
    """
    cli = _resolve_json2ts_cli(repo_root)
    with tempfile.TemporaryDirectory() as tmp:
        in_path = Path(tmp) / "ir.schema.json"
        out_path = Path(tmp) / "ir.d.ts"
        in_path.write_text(canonical_json(ts_input), encoding="utf-8", newline="\n")
        try:
            subprocess.run(
                ["node", str(cli), "-i", str(in_path), "-o", str(out_path)],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError as exc:  # `node` not on PATH
            raise CodegenToolError(
                "`node` was not found on PATH. Activate Node 24 (e.g. via fnm) before running "
                "codegen."
            ) from exc
        except subprocess.CalledProcessError as exc:
            raise CodegenToolError(
                f"json-schema-to-typescript failed (exit {exc.returncode}):\n{exc.stderr}"
            ) from exc
        return _normalize_eol(out_path.read_text(encoding="utf-8"))
