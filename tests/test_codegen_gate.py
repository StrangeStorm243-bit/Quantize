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
from quantize.codegen.schema import BundleSpec
from quantize.codegen.typescript import CodegenToolError


@pytest.fixture
def fake_artifacts(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, Path]:
    """Point the gate at two tmp bundles (IR + API) with known expected content (no Node required).

    ``_expected_for`` is stubbed per-spec so the comparison/error-formatting logic is what's under
    test, never the Node generator; ``BUNDLES`` is replaced with tmp-backed specs.
    """
    files = {
        "ir_schema": tmp_path / "quantize.schema.json",
        "ir_ts": tmp_path / "quantize-ir.d.ts",
        "api_schema": tmp_path / "quantize-api.schema.json",
        "api_ts": tmp_path / "quantize-api.d.ts",
    }
    expected = {
        "quantize.schema.json": "IR-SCHEMA\n",
        "quantize-ir.d.ts": "IR-TS\n",
        "quantize-api.schema.json": "API-SCHEMA\n",
        "quantize-api.d.ts": "API-TS\n",
    }
    for path in files.values():
        path.write_text(expected[path.name], encoding="utf-8", newline="\n")

    ir_spec = BundleSpec("IR", dict, files["ir_schema"], files["ir_ts"])
    api_spec = BundleSpec("API", dict, files["api_schema"], files["api_ts"])

    def _fake_expected(spec: BundleSpec) -> tuple[str, str]:
        return expected[spec.schema_path.name], expected[spec.ts_path.name]

    monkeypatch.setattr(pipeline, "BUNDLES", (ir_spec, api_spec))
    monkeypatch.setattr(pipeline, "_expected_for", _fake_expected)
    monkeypatch.setattr(pipeline, "REPO_ROOT", tmp_path)  # so relative_to() in messages works
    return files


def test_check_passes_when_current(fake_artifacts: dict[str, Path]) -> None:
    assert pipeline.check() == []


def test_check_flags_stale_ir_artifact(fake_artifacts: dict[str, Path]) -> None:
    fake_artifacts["ir_schema"].write_text("DRIFTED\n", encoding="utf-8", newline="\n")
    errors = pipeline.check()
    assert any("stale" in e and "quantize.schema.json" in e for e in errors)


def test_check_flags_stale_api_artifact(fake_artifacts: dict[str, Path]) -> None:
    """A stale API artifact is flagged by its own filename (the second-bundle staleness gate)."""
    fake_artifacts["api_ts"].write_text("DRIFTED\n", encoding="utf-8", newline="\n")
    errors = pipeline.check()
    assert any("stale" in e and "quantize-api.d.ts" in e for e in errors)


def test_check_flags_missing_artifact(fake_artifacts: dict[str, Path]) -> None:
    fake_artifacts["ir_ts"].unlink()
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
