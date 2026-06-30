"""M2.3 — the single shared is_compatible function (compatibility table)."""

import pytest

from quantize.compatibility import is_compatible
from quantize.schema.types import (
    AssetSetType,
    CrossSectionType,
    PortfolioTargetsType,
    PortType,
    ScalarType,
    TimeSeriesType,
)

_S_INT = ScalarType(kind="Scalar", dtype="Integer")
_S_NUM = ScalarType(kind="Scalar", dtype="Number")
_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")
_CS_BOOL = CrossSectionType(kind="CrossSection", dtype="Boolean")
_TS_NUM = TimeSeriesType(kind="TimeSeries", dtype="Number")
_AS = AssetSetType(kind="AssetSet")
_PT = PortfolioTargetsType(kind="PortfolioTargets")


def test_exact_match_is_compatible() -> None:
    assert is_compatible(_CS_NUM, _CS_NUM)
    assert is_compatible(_AS, _AS)
    assert is_compatible(_PT, _PT)


def test_value_equality_across_instances() -> None:
    # the exact-match rule relies on value equality of independently constructed instances
    assert CrossSectionType(kind="CrossSection", dtype="Number") == _CS_NUM
    assert is_compatible(
        CrossSectionType(kind="CrossSection", dtype="Number"),
        CrossSectionType(kind="CrossSection", dtype="Number"),
    )


def test_scalar_integer_widens_to_number() -> None:
    assert is_compatible(_S_INT, _S_NUM)


@pytest.mark.parametrize(
    ("source", "destination"),
    [
        (_S_NUM, _S_INT),  # narrowing
        (_CS_NUM, _CS_BOOL),  # dtype differs
        (_TS_NUM, _CS_NUM),  # collapse needs a node
        (_CS_BOOL, _AS),  # mask is not a universe
        (_CS_NUM, _PT),  # weighting needs a node
        (_PT, _CS_NUM),  # portfolio is not generic numbers
    ],
)
def test_incompatible_pairs(source: PortType, destination: PortType) -> None:
    assert not is_compatible(source, destination)
