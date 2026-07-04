"""Pure-domain export primitives for the (future) read-only node-type metadata API (M10).

Enabling seams only: the canonical v0 port-type lattice, the compatible-edge enumeration derived
from the single shared ``is_compatible``, and a stable content digest over a portable-JSON body.
No DTOs, no API imports, no codegen — those layers land in later M10 packets. Everything here is a
pure function of its inputs so the API layer can compose it deterministically.
"""

from __future__ import annotations

import hashlib
import json

from quantize.compatibility import is_compatible
from quantize.schema.primitives import JsonObject
from quantize.schema.types import (
    AssetSetType,
    CrossSectionType,
    PortfolioTargetsType,
    PortType,
    ScalarType,
    TimeSeriesType,
)

# The full v0 port-type lattice, in sort-key order ``(kind, dtype or "")``. Governed and closed:
# every constructible PortType appears exactly once (a test derives this set from the union and
# fails if a variant/dtype is added without updating this tuple).
PORT_TYPE_LATTICE: tuple[PortType, ...] = (
    AssetSetType(kind="AssetSet"),
    CrossSectionType(kind="CrossSection", dtype="Boolean"),
    CrossSectionType(kind="CrossSection", dtype="Number"),
    PortfolioTargetsType(kind="PortfolioTargets"),
    ScalarType(kind="Scalar", dtype="Boolean"),
    ScalarType(kind="Scalar", dtype="Integer"),
    ScalarType(kind="Scalar", dtype="Number"),
    TimeSeriesType(kind="TimeSeries", dtype="Number"),
)


def compatible_pairs() -> tuple[tuple[PortType, PortType], ...]:
    """Every allowed ``(source, destination)`` edge over the lattice, source-major.

    Derived from the single shared ``is_compatible`` — never a second table. In v0 this is exactly
    9 pairs: the 8 identities plus the one widening ``Scalar[Integer] -> Scalar[Number]``.
    """
    return tuple(
        (source, destination)
        for source in PORT_TYPE_LATTICE
        for destination in PORT_TYPE_LATTICE
        if is_compatible(source, destination)
    )


def catalog_digest(body: JsonObject) -> str:
    """A stable SHA-256 hex digest of a portable-JSON *body* (canonical, sorted-key encoding)."""
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
