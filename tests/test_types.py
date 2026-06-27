"""Tests for the v0 port-type lattice (M1.1a)."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from quantize.schema.types import PortType

_port: TypeAdapter[Any] = TypeAdapter(PortType)


def test_port_type_accepts_each_v0_variant() -> None:
    cases = [
        {"kind": "Scalar", "dtype": "Integer"},
        {"kind": "AssetSet"},
        {"kind": "CrossSection", "dtype": "Boolean"},
        {"kind": "TimeSeries", "dtype": "Number"},
        {"kind": "PortfolioTargets"},
    ]
    for case in cases:
        assert _port.validate_python(case).model_dump(exclude_none=True) == case


def test_port_type_rejects_orderlist() -> None:
    # OrderList is engine-only and not a constructible port type (HIGH-4).
    with pytest.raises(ValidationError) as exc:
        _port.validate_python({"kind": "OrderList"})
    assert exc.value.errors()[0]["type"] == "union_tag_invalid"


def test_port_type_rejects_unknown_kind_and_bad_dtype() -> None:
    with pytest.raises(ValidationError) as exc:
        _port.validate_python({"kind": "Matrix"})
    assert exc.value.errors()[0]["type"] == "union_tag_invalid"

    with pytest.raises(ValidationError) as exc:
        _port.validate_python({"kind": "TimeSeries", "dtype": "Boolean"})  # only Number allowed
    err = exc.value.errors()[0]
    assert err["type"] == "literal_error"
    assert "dtype" in str(err["loc"])


def test_port_type_forbids_extra_fields() -> None:
    with pytest.raises(ValidationError) as exc:
        _port.validate_python({"kind": "AssetSet", "surprise": 1})
    assert exc.value.errors()[0]["type"] == "extra_forbidden"
