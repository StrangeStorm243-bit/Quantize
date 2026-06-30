"""M2.1 — synthetic fixture-registry harness tests."""

from quantize.registry.registry import ResolutionStatus
from tests.registry_fixtures import build_fixture_registry


def test_fixture_registry_resolves_source_and_sink() -> None:
    r = build_fixture_registry()
    assert r.resolve("test.source", "1.0.0").status is ResolutionStatus.OK
    assert r.resolve("test.sink", "1.0.0").status is ResolutionStatus.OK
    assert r.available_versions("test.source") == ("1.0.0", "1.1.0")


def test_fixture_sink_has_required_and_optional_inputs() -> None:
    r = build_fixture_registry()
    sink = r.resolve("test.sink", "1.0.0").descriptor
    assert sink is not None
    required = {p.name: p.required for p in sink.inputs}
    assert required == {"in": True, "opt": False}
