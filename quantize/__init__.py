"""Quantize runtime package.

M1 builds only ``quantize.schema`` (the IR Pydantic models) and ``quantize.validation``
(structural validation). Engine, registry, nodes, adapters, and codegen arrive in later
milestones — see ``docs/plans/M1_IMPLEMENTATION_PLAN.md`` and ``docs/MVP_PLAN.md``.
"""

__all__: list[str] = []
