"""Provenance & visibility — shared by strategy documents and component definitions.

Fork ancestry is entity-specific: a strategy fork references a strategy version (a positive
integer); a component fork references a component version (SemVer). Provenance is generic over
the fork-ref type, so the two version axes are never conflated (HIGH-5).
"""

from __future__ import annotations

from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict

from quantize.schema.primitives import Count, EntityId, SemVer, Utc

Visibility = Literal["private", "unlisted_readonly", "unlisted_duplicable"]


class StrategyForkRef(BaseModel):
    """Lineage pointer to a (strategy id, strategy version) — version is a positive integer."""

    model_config = ConfigDict(extra="forbid")

    id: EntityId
    version: Count


class ComponentForkRef(BaseModel):
    """Lineage pointer to a (component id, component version) — version is SemVer."""

    model_config = ConfigDict(extra="forbid")

    id: EntityId
    version: SemVer


_ForkRefT = TypeVar("_ForkRefT")


class Provenance(BaseModel, Generic[_ForkRefT]):  # noqa: UP046  (Pydantic generic-model form)
    """Ownership, contributors, lineage, visibility, and creation time."""

    model_config = ConfigDict(extra="forbid")

    owner: EntityId
    creator: EntityId
    contributors: list[EntityId]  # required (may be empty)
    forked_from: _ForkRefT | None = None
    visibility: Visibility
    duplicable: bool
    created_at: Utc
