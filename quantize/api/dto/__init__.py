"""Governed API DTOs — fastapi-free pydantic models.

These modules import NOTHING from fastapi (the codegen CI job stays lock-only) and are the roots
of the second codegen bundle (``schema/quantize-api.schema.json`` + ``ts/quantize-api.d.ts``,
wired in M9.3). Every DTO is frozen with ``extra="forbid"``; IR/persistence domain models are
REUSED, never re-declared.
"""
