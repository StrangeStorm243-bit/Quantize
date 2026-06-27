"""The codegen *gate* failure paths — what `check` and the CLI do when things are wrong.

The happy path (artifacts current) is covered elsewhere; the gate exists to catch the unhappy
cases, so those are exercised here. All tests are Node-free: the Node generator is monkeypatched so
the comparison/error-formatting logic is what's under test, not the toolchain.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from quantize.codegen import pipeline
from quantize.codegen import typescript as ts_mod
from quantize.codegen.typescript import CodegenToolError


@pytest.fixture
def fake_artifacts(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[Path, Path]:
    """Point the gate at tmp artifacts with a known expected content (no Node required)."""
    schema_file = tmp_path / "quantize.schema.json"
    ts_file = tmp_path / "quantize-ir.d.ts"
    schema_file.write_text("EXPECTED-SCHEMA\n", encoding="utf-8", newline="\n")
    ts_file.write_text("EXPECTED-TS\n", encoding="utf-8", newline="\n")
    monkeypatch.setattr(pipeline, "_build_expected", lambda: ("EXPECTED-SCHEMA\n", "EXPECTED-TS\n"))
    monkeypatch.setattr(pipeline, "SCHEMA_PATH", schema_file)
    monkeypatch.setattr(pipeline, "TS_PATH", ts_file)
    monkeypatch.setattr(pipeline, "REPO_ROOT", tmp_path)  # so relative_to() in messages works
    return schema_file, ts_file


def test_check_passes_when_current(fake_artifacts: tuple[Path, Path]) -> None:
    assert pipeline.check() == []


def test_check_flags_stale_artifact(fake_artifacts: tuple[Path, Path]) -> None:
    schema_file, _ = fake_artifacts
    schema_file.write_text("DRIFTED\n", encoding="utf-8", newline="\n")
    errors = pipeline.check()
    assert any("stale" in e and "quantize.schema.json" in e for e in errors)


def test_check_flags_missing_artifact(fake_artifacts: tuple[Path, Path]) -> None:
    _, ts_file = fake_artifacts
    ts_file.unlink()
    errors = pipeline.check()
    assert any("missing" in e and "quantize-ir.d.ts" in e for e in errors)


def test_resolve_cli_errors_without_node_modules(tmp_path: Path) -> None:
    with pytest.raises(CodegenToolError, match="npm ci"):
        ts_mod._resolve_json2ts_cli(tmp_path)


def test_generate_typescript_errors_when_node_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(ts_mod, "_resolve_json2ts_cli", lambda root: tmp_path / "cli.js")

    def _no_node(*_args: object, **_kwargs: object) -> None:
        raise FileNotFoundError("node")

    monkeypatch.setattr(subprocess, "run", _no_node)  # typescript.py calls subprocess.run
    with pytest.raises(CodegenToolError, match="node"):
        ts_mod.generate_typescript({"x": 1}, tmp_path)
