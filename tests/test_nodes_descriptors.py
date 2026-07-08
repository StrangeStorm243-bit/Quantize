"""M3: the core catalog's descriptors — assembly, M2 contract consistency, parameter schemas."""

from __future__ import annotations

import pytest

from quantize.nodes import build_core_catalog, core_node_implementations
from quantize.registry.registry import ResolutionStatus
from quantize.schema.primitives import JsonValue
from tests.registry_fixtures import build_reference_registry


def test_catalog_holds_the_twelve_core_nodes_plus_terminal() -> None:
    type_ids = {impl.type_id for impl in core_node_implementations()}
    assert type_ids == {
        "universe.fixed_list",
        "data.price",
        "transform.trailing_return",
        "transform.moving_average",
        "transform.latest",
        "transform.rank",
        "logic.greater_than",
        "portfolio.select_top_n",
        "portfolio.equal_weight",
        "portfolio.fixed_weight",
        "portfolio.apply_mask",
        "risk.max_weight",
        "output.target_portfolio",
    }


def test_all_core_nodes_are_pure_v0() -> None:
    assert all(impl.purity == "pure" for impl in core_node_implementations())


def test_core_descriptors_match_the_m2_reference_doubles() -> None:
    """The M2 test doubles pinned the port contract the committed strategy fixtures wire
    against; the real descriptors must agree exactly (names AND types, both directions)."""
    reference = build_reference_registry()
    catalog = build_core_catalog()
    for implementation in core_node_implementations():
        if implementation.type_id == "output.target_portfolio":
            continue  # the doubles include it too, but assert it below for clarity
        resolution = reference.resolve(implementation.type_id, implementation.type_version)
        assert resolution.status is ResolutionStatus.OK, implementation.type_id
        assert resolution.descriptor is not None
        expected = resolution.descriptor
        actual = catalog.resolve(implementation.type_id, implementation.type_version)
        assert actual.implementation is not None
        descriptor = actual.implementation.descriptor
        assert [(p.name, p.port_type) for p in descriptor.inputs] == [
            (p.name, p.port_type) for p in expected.inputs
        ], implementation.type_id
        assert [(p.name, p.port_type) for p in descriptor.outputs] == [
            (p.name, p.port_type) for p in expected.outputs
        ], implementation.type_id


def test_fresh_catalogs_are_independent() -> None:
    first = build_core_catalog()
    second = build_core_catalog()
    assert first is not second
    assert [i.type_id for i in first.implementations()] == [
        i.type_id for i in second.implementations()
    ]


def _schema_errors(type_id: str, params: dict[str, JsonValue]) -> bool:
    """True if the node's parameter schema rejects *params*."""
    for implementation in core_node_implementations():
        if implementation.type_id == type_id:
            schema = implementation.descriptor.parameter_schema
            assert schema is not None, f"{type_id} must declare a parameter schema"
            return bool(schema.errors(params))
    raise AssertionError(f"unknown type_id {type_id}")


@pytest.mark.parametrize(
    ("type_id", "params", "rejected"),
    [
        ("universe.fixed_list", {"tickers": ["SPY", "AGG"]}, False),
        ("universe.fixed_list", {"tickers": []}, True),
        ("universe.fixed_list", {"tickers": ["SPY", "SPY"]}, True),
        ("universe.fixed_list", {"tickers": ["SPY", 3]}, True),
        ("universe.fixed_list", {}, True),
        ("data.price", {}, False),
        ("data.price", {"extra": 1}, True),
        ("transform.trailing_return", {"lookback_sessions": 126}, False),
        ("transform.trailing_return", {"lookback_sessions": 0}, True),
        ("transform.trailing_return", {}, True),
        ("transform.moving_average", {"window": 200}, False),
        ("transform.moving_average", {"window": 1.5}, True),
        ("transform.latest", {}, False),
        ("transform.rank", {"descending": True}, False),
        ("transform.rank", {}, False),
        ("transform.rank", {"descending": "yes"}, True),
        ("logic.greater_than", {}, False),
        ("portfolio.select_top_n", {"n": 3}, False),
        ("portfolio.select_top_n", {"n": 0}, True),
        ("portfolio.equal_weight", {}, False),
        ("portfolio.fixed_weight", {"weight_per_asset": "equal"}, False),
        ("portfolio.fixed_weight", {"weight_per_asset": 0.25}, False),
        ("portfolio.fixed_weight", {"weight_per_asset": 0}, True),
        ("portfolio.fixed_weight", {"weight_per_asset": 1.5}, True),
        ("portfolio.fixed_weight", {}, True),
        ("portfolio.apply_mask", {}, False),
        ("risk.max_weight", {"max": 0.4}, False),
        ("risk.max_weight", {"max": 0}, True),
        ("risk.max_weight", {"max": 1.5}, True),
        ("output.target_portfolio", {}, False),
    ],
)
def test_parameter_schemas(type_id: str, params: dict[str, JsonValue], rejected: bool) -> None:
    assert _schema_errors(type_id, params) is rejected


# --- M13.1: category + doc completeness over the real catalog ----------------------------------

# The D-14 assignment table (design W2), asserted as a literal so any drift is a reviewed diff.
_CATEGORY_BY_TYPE_ID = {
    "universe.fixed_list": "universe",
    "data.price": "data",
    "transform.trailing_return": "transform",
    "transform.moving_average": "transform",
    "transform.latest": "transform",
    "transform.rank": "selection",
    "logic.greater_than": "signal",
    "portfolio.select_top_n": "selection",
    "portfolio.equal_weight": "weighting",
    "portfolio.fixed_weight": "weighting",
    "portfolio.apply_mask": "weighting",
    "risk.max_weight": "risk",
    "output.target_portfolio": "output",
}

# Nodes whose meaning is mathematical enough to owe a plain-text formula.
_FORMULA_REQUIRED = {
    "transform.trailing_return",
    "transform.moving_average",
    "transform.latest",
    "transform.rank",
    "risk.max_weight",
    "portfolio.equal_weight",
    "portfolio.fixed_weight",
}

# Nodes with an explicit missing-data rule that must be stated in doc.semantics.
_SEMANTICS_REQUIRED = {
    "logic.greater_than",
    "transform.trailing_return",
    "transform.moving_average",
    "transform.latest",
    "transform.rank",
}


def _schema_property_names(type_id: str) -> set[str]:
    for implementation in core_node_implementations():
        if implementation.type_id == type_id:
            schema = implementation.descriptor.parameter_schema
            if schema is None:
                return set()
            properties = schema.document.get("properties", {})
            return set(properties) if isinstance(properties, dict) else set()
    raise AssertionError(f"unknown type_id {type_id}")


@pytest.mark.parametrize("implementation", core_node_implementations(), ids=lambda i: i.type_id)
def test_every_node_declares_its_d14_category(implementation: object) -> None:
    descriptor = implementation.descriptor  # type: ignore[attr-defined]
    assert descriptor.metadata.category == _CATEGORY_BY_TYPE_ID[descriptor.type_id]


@pytest.mark.parametrize("implementation", core_node_implementations(), ids=lambda i: i.type_id)
def test_every_node_has_a_role_first_doc(implementation: object) -> None:
    descriptor = implementation.descriptor  # type: ignore[attr-defined]
    doc = descriptor.metadata.doc
    assert doc is not None, f"{descriptor.type_id} must declare a doc block"
    assert doc.summary.strip(), f"{descriptor.type_id} summary must be non-empty"


@pytest.mark.parametrize("implementation", core_node_implementations(), ids=lambda i: i.type_id)
def test_doc_parameters_cover_the_schema_exactly(implementation: object) -> None:
    descriptor = implementation.descriptor  # type: ignore[attr-defined]
    doc = descriptor.metadata.doc
    assert doc is not None
    assert set(doc.parameters) == _schema_property_names(descriptor.type_id), descriptor.type_id


@pytest.mark.parametrize("type_id", sorted(_FORMULA_REQUIRED))
def test_mathematical_nodes_have_a_formula(type_id: str) -> None:
    catalog = build_core_catalog()
    resolved = catalog.resolve(type_id, "1.0.0").implementation
    assert resolved is not None
    doc = resolved.descriptor.metadata.doc
    assert doc is not None and doc.formula, f"{type_id} must document a formula"


@pytest.mark.parametrize("type_id", sorted(_SEMANTICS_REQUIRED))
def test_missing_data_nodes_have_semantics(type_id: str) -> None:
    catalog = build_core_catalog()
    resolved = catalog.resolve(type_id, "1.0.0").implementation
    assert resolved is not None
    doc = resolved.descriptor.metadata.doc
    assert doc is not None and doc.semantics, f"{type_id} must document semantics"


def test_declared_warmups() -> None:
    # Convention (STRATEGY_LANGUAGE §2): declared warm-up = sessions required STRICTLY BEFORE
    # the evaluation session. trailing_return needs L prior closes for its anchor; an MA of
    # window W has its first full window AT the W-th visible session (W-1 prior); latest needs
    # only the current session.
    catalog = build_core_catalog()
    ret = catalog.resolve("transform.trailing_return", "1.0.0").implementation
    ma = catalog.resolve("transform.moving_average", "1.0.0").implementation
    latest = catalog.resolve("transform.latest", "1.0.0").implementation
    assert ret is not None and ret.warmup({"lookback_sessions": 126}) == 126
    assert ma is not None and ma.warmup({"window": 200}) == 199
    assert ma.warmup({"window": 1}) == 0  # a 1-session MA is computable at the first session
    assert latest is not None and latest.warmup({}) == 0
