"""Strategy- and component-document endpoint DTOs.

The list-row DTOs mirror the persistence summaries field-for-field (``StrategySummary`` /
``ComponentSummary``); the saved-acknowledgement DTOs echo the minted identity. The stored
documents themselves are the IR models (``StrategyDocument`` / ``ComponentDefinition``), returned
verbatim as stored bytes — never re-declared here.
"""

from __future__ import annotations

from quantize.api.dto.common import _Dto


class StrategySaved(_Dto):
    """Acknowledgement of a persisted strategy version."""

    strategy_id: str
    version: int


class StrategyListRow(_Dto):
    """One strategy summary row — mirrors ``persistence.documents.StrategySummary``."""

    strategy_id: str
    version: int
    name: str
    schema_version: str
    saved_at: str


class StrategyList(_Dto):
    strategies: tuple[StrategyListRow, ...]


class VersionList(_Dto):
    """The ascending version numbers stored for one strategy id."""

    versions: tuple[int, ...]


class ComponentSaved(_Dto):
    """Acknowledgement of a persisted component definition (version is a SemVer string)."""

    component_id: str
    version: str


class ComponentListRow(_Dto):
    """One component summary row — mirrors ``persistence.documents.ComponentSummary``."""

    component_id: str
    version: str
    name: str
    schema_version: str
    saved_at: str


class ComponentList(_Dto):
    components: tuple[ComponentListRow, ...]
