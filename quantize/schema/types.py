"""Port types — the v0 type lattice (closed / governed).

These describe the type of a port. In the persisted IR they appear only on a component's exposed
ports (M1.1b); the lattice itself is defined here. ``OrderList`` is engine-only and is deliberately
**not** a constructible port type (HIGH-4) — it cannot appear on any graph or component port.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class _PortTypeBase(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ScalarType(_PortTypeBase):
    kind: Literal["Scalar"]
    dtype: Literal["Number", "Integer", "Boolean"]


class AssetSetType(_PortTypeBase):
    kind: Literal["AssetSet"]


class CrossSectionType(_PortTypeBase):
    kind: Literal["CrossSection"]
    dtype: Literal["Number", "Boolean"]


class TimeSeriesType(_PortTypeBase):
    kind: Literal["TimeSeries"]
    dtype: Literal["Number"]


class PortfolioTargetsType(_PortTypeBase):
    kind: Literal["PortfolioTargets"]


# Discriminated union over `kind`. OrderList is intentionally absent (engine-only).
PortType = Annotated[
    ScalarType | AssetSetType | CrossSectionType | TimeSeriesType | PortfolioTargetsType,
    Field(discriminator="kind"),
]
