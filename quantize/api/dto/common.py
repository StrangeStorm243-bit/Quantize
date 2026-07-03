"""Shared API DTOs: the error envelope and the service metadata response.

``ApiError`` is the ONLY error body shape (infrastructure). It carries ``code`` + ``message`` and
nothing else — a ``PersistenceError``'s ``context`` (which can hold the server filesystem path) is
NEVER serialized. Domain diagnostics (validate) are a distinct, safe-to-expose contract.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _Dto(BaseModel):
    """Base for every API DTO: frozen, reject unknown fields, and STRICT + finite.

    Strict parsing makes request-body validation match the governed JSON Schema: a numeric string,
    a boolean-as-number, or a numeric epoch date/datetime — all accepted by pydantic's default
    coercion but rejected by ``schema/quantize-api.schema.json`` — now fail with the route's 422.
    (Strict still accepts JSON integers for ``number`` fields and ISO strings for date/datetime,
    which the schema also accepts.) ``allow_inf_nan=False`` rejects non-finite numbers, which
    ``type: number`` implies.
    """

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True, allow_inf_nan=False)


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
