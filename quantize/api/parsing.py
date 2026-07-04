"""Raw-bytes request-body helpers shared by the IR-document routes (strategies/components/validate).

Bodies are validated straight from raw bytes via pydantic-core's Rust JSON path
(``model_validate_json``) — NEVER a Python ``json.loads`` of untrusted input — so a deeply nested
depth-bomb surfaces as a clean ``ValidationError`` (→ 400), never a Python ``RecursionError`` (→
500). The unsupported-``schema_version`` gate runs first, on the same Rust path, so a future-version
document (which may not even parse under the current model) yields a robust 422 rather than a 400.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from pydantic import BaseModel, ConfigDict, ValidationError

from quantize.api.errors import INVALID_BODY, INVALID_JSON, ApiRequestError
from quantize.api.settings import ApiSettings, get_settings
from quantize.schema.version import is_supported_schema_version, supported_schema_versions

# Stable code for the pre-parse version gate (a domain-ish 422, distinct from the 400 parse codes).
UNSUPPORTED_SCHEMA_VERSION = "unsupported_schema_version"


async def _raw_body(request: Request) -> bytes:
    """Return the untouched request body bytes.

    An ASYNC dependency (resolved in the event loop) so a SYNCHRONOUS handler receives raw bytes
    without ``await`` — a ``Body(bytes)`` parameter would let FastAPI JSON-parse the body first
    when the content-type is application/json, defeating the raw-bytes (depth-safe) contract. The
    body-size middleware has already 413'd anything over the cap.
    """
    return await request.body()


# The raw request body for IR-document / DTO POSTs (validated on the Rust path by the handler).
JsonBody = Annotated[bytes, Depends(_raw_body)]
SettingsDep = Annotated[ApiSettings, Depends(get_settings)]


class _SchemaVersionProbe(BaseModel):
    """Extract only ``schema_version`` via the Rust path, ignoring everything else."""

    model_config = ConfigDict(extra="ignore")

    schema_version: str | None = None


def gate_schema_version(raw: bytes) -> None:
    """Raise 422 if the body declares a ``schema_version`` outside the supported set.

    A missing or unreadable version is left to full model validation (which yields the precise
    400 required-field / parse error). Depth-safe: parses on the Rust path.
    """
    try:
        probe = _SchemaVersionProbe.model_validate_json(raw)
    except ValidationError:
        return  # not a readable object; full validation will produce the precise 400
    version = probe.schema_version
    if version is not None and not is_supported_schema_version(version):
        raise ApiRequestError(
            422,
            UNSUPPORTED_SCHEMA_VERSION,
            f"schema_version {version!r} is not supported "
            f"(supported: {', '.join(supported_schema_versions())})",
        )


def load_ir_document[M: BaseModel](raw: bytes, model: type[M]) -> M:
    """Depth-safe raw-bytes load of an IR document: version gate (422) then validation (400)."""
    gate_schema_version(raw)
    try:
        return model.model_validate_json(raw)
    except ValidationError as error:
        errors = error.errors()
        if errors and errors[0].get("type") == "json_invalid":
            raise ApiRequestError(400, INVALID_JSON, "request body is not valid JSON") from error
        raise ApiRequestError(
            400,
            INVALID_BODY,
            f"request body is not a valid document: {error.error_count()} validation error(s)",
        ) from error


def load_dto[M: BaseModel](raw: bytes, model: type[M]) -> M:
    """Depth-safe raw-bytes load of a request DTO: unparseable JSON → 400, but a shape failure on
    a governed DTO body → 422 (the run/dataset-body semantics, distinct from IR documents)."""
    try:
        return model.model_validate_json(raw)
    except ValidationError as error:
        errors = error.errors()
        if errors and errors[0].get("type") == "json_invalid":
            raise ApiRequestError(400, INVALID_JSON, "request body is not valid JSON") from error
        raise ApiRequestError(
            422,
            INVALID_BODY,
            f"request body failed validation: {error.error_count()} error(s)",
        ) from error
