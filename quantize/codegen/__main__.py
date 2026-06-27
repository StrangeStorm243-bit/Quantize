"""Command-line entry point: ``python -m quantize.codegen {generate,check}``.

A single cross-platform Python entry coordinates the (Node) generator subprocess, so there is no
shell-specific script. ``generate`` writes the artifacts; ``check`` verifies them and exits nonzero
on staleness without modifying the working tree.
"""

from __future__ import annotations

import argparse
import sys

from quantize.codegen.pipeline import check, generate
from quantize.codegen.schema import REPO_ROOT
from quantize.codegen.typescript import CodegenToolError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m quantize.codegen")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("generate", help="emit the JSON Schema and TypeScript artifacts")
    sub.add_parser("check", help="verify committed artifacts are current (no writes)")
    args = parser.parse_args(argv)

    try:
        if args.command == "generate":
            written = generate()
            print("Generated Quantize IR artifacts:")
            for path in written:
                print(f"  - {path.relative_to(REPO_ROOT)}")
            return 0

        if args.command == "check":
            errors = check()
            if errors:
                print("Generated artifacts are out of date:", file=sys.stderr)
                for err in errors:
                    print(f"  - {err}", file=sys.stderr)
                return 1
            print("Generated artifacts are up to date.")
            return 0
    except CodegenToolError as exc:
        print(f"codegen: {exc}", file=sys.stderr)
        return 2

    parser.error(f"unknown command {args.command!r}")  # unreachable (subparser is required)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
