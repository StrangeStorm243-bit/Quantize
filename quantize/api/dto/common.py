"""Shared API DTOs: the error envelope and the service metadata response.

``ApiError`` is the ONLY error body shape (infrastructure). It carries ``code`` + ``message`` and
nothing else — a ``PersistenceError``'s ``context`` (which can hold the server filesystem path) is
NEVER serialized. Domain diagnostics (validate) are a distinct, safe-to-expose contract.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _Dto(BaseModel):
    """Base for every API DTO: frozen, reject unknown fields."""

    model_config = ConfigDict(frozen=True, extra="forbid")


class ApiError(_Dto):
    """The uniform error envelope. ``code`` is a stable machine identifier; ``message`` is human
    text. Deliberately has no ``context``/``detail`` field — infrastructure internals never leak."""

    code: str
    message: str


class MetaResponse(_Dto):
    """Service identity: the API version plus the format versions a client must understand."""

    api_version: str
    schema_version: str
    record_format: int
    trace_format: int
