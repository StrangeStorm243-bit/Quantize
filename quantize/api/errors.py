"""HTTP error mapping for the API boundary.

Two fault families, mapped to ``ApiError{code, message}`` — never anything wider:

* **Request-level** faults the routes raise deliberately (``ApiRequestError``): unparseable body
  (400), pydantic shape failure on an IR document (400), the pre-parse unsupported
  ``schema_version`` gate (422), an oversized body (413). The route chooses the status because the
  same underlying failure means 400 on an IR-document body but 422 on a run/dataset DTO body.
* **Persistence** faults (``PersistenceError``) mapped per the Track-4 table by stable ``code``.
  The GLOBAL handler maps every code flat (``invalid_artifact`` defaults to 500 — reachable there
  only via server-internal invariants); client-save ROUTES catch ``PersistenceError`` locally and
  map ``invalid_artifact`` → 422 before it reaches this handler (the split mechanism).

**Context scrubbing (invariant): ``PersistenceError.context`` is NEVER serialized** — the
``corrupt_database`` context carries the server's filesystem path. Only ``code`` + ``message`` ever
cross the wire.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from quantize.api.dto.common import ApiError
from quantize.persistence.errors import (
    ARTIFACT_CONFLICT,
    ARTIFACT_NOT_FOUND,
    CORRUPT_ARTIFACT,
    CORRUPT_DATABASE,
    DATABASE_LOCKED,
    INTEGRITY_VIOLATION,
    INVALID_ARTIFACT,
    UNSUPPORTED_ARTIFACT_VERSION,
    UNSUPPORTED_DATABASE_VERSION,
    PersistenceError,
)

# Request-level stable codes (distinct from persistence/validation codes).
INVALID_JSON = "invalid_json"
INVALID_BODY = "invalid_body"
PAYLOAD_TOO_LARGE = "payload_too_large"

# Per-(code → HTTP) for persistence faults reaching the GLOBAL handler. ``invalid_artifact``
# defaults to 500: client-caused invalid saves are re-mapped to 422 IN the route before they get
# here, so at this layer it can only mean a server-internal invariant tripped. See the module
# docstring for the split, and the M9 plan's amendment on unsupported_artifact_version → 500.
_STATUS_FOR_PERSISTENCE_CODE: dict[str, int] = {
    ARTIFACT_NOT_FOUND: 404,
    ARTIFACT_CONFLICT: 409,
    DATABASE_LOCKED: 503,
    INVALID_ARTIFACT: 500,
    UNSUPPORTED_ARTIFACT_VERSION: 500,
    CORRUPT_ARTIFACT: 500,
    CORRUPT_DATABASE: 500,
    UNSUPPORTED_DATABASE_VERSION: 500,
    INTEGRITY_VIOLATION: 500,
}


class ApiRequestError(Exception):
    """A request-level fault a route raises with an explicit status. Rendered as ``ApiError``."""

    def __init__(
        self, status_code: int, code: str, message: str, *, retry_after: int | None = None
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retry_after = retry_after


def status_for_persistence_code(code: str) -> int:
    """The HTTP status for a persistence ``code`` at the global layer (unknown codes → 500)."""
    return _STATUS_FOR_PERSISTENCE_CODE.get(code, 500)


def _error_response(
    status_code: int, code: str, message: str, *, retry_after: int | None = None
) -> JSONResponse:
    """Build the ``ApiError`` envelope. Only ``code`` + ``message`` — nothing else, ever."""
    headers = {"Retry-After": str(retry_after)} if retry_after is not None else None
    return JSONResponse(
        status_code=status_code,
        content=ApiError(code=code, message=message).model_dump(),
        headers=headers,
    )


def persistence_error_response(error: PersistenceError) -> JSONResponse:
    """Map a ``PersistenceError`` to its HTTP response, scrubbing ``context`` entirely.

    ``database_locked`` additionally carries a ``Retry-After`` header (the fault is transient).
    """
    status_code = status_for_persistence_code(error.code)
    retry_after = 1 if error.code == DATABASE_LOCKED else None
    return _error_response(status_code, error.code, error.message, retry_after=retry_after)


def api_request_error_response(error: ApiRequestError) -> JSONResponse:
    return _error_response(
        error.status_code, error.code, error.message, retry_after=error.retry_after
    )


def install_error_handlers(app: FastAPI) -> None:
    """Register the global exception handlers on *app*."""

    async def _handle_persistence(_request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, PersistenceError)
        return persistence_error_response(exc)

    async def _handle_api_request(_request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, ApiRequestError)
        return api_request_error_response(exc)

    async def _handle_request_validation(_request: Request, exc: Exception) -> JSONResponse:
        # Reached only for path/query-parameter validation (route bodies are validated with
        # explicit raw-bytes handling that raises ApiRequestError). Rendered as our envelope.
        return _error_response(422, INVALID_BODY, "request parameters failed validation")

    app.add_exception_handler(PersistenceError, _handle_persistence)
    app.add_exception_handler(ApiRequestError, _handle_api_request)
    app.add_exception_handler(RequestValidationError, _handle_request_validation)
