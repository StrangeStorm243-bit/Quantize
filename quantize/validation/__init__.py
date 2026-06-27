"""Structural validation (M1.2).

Structural-only: no node registry, catalog, or descriptor is consulted (those are M2). See the
M1-vs-M2 boundary in ``docs/plans/M1_IMPLEMENTATION_PLAN.md`` §4.
"""

from quantize.validation.errors import (
    ComponentKey,
    ComponentSetValidation,
    StructuralError,
    StructuralValidation,
)
from quantize.validation.structural import (
    validate_component_definition,
    validate_component_set,
    validate_strategy_document,
)

__all__ = [
    "ComponentKey",
    "ComponentSetValidation",
    "StructuralError",
    "StructuralValidation",
    "validate_component_definition",
    "validate_component_set",
    "validate_strategy_document",
]
