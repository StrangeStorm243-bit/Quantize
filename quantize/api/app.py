"""FastAPI application factory.

``create_app`` wires the settings, the body-size guard, the error handlers, a startup warm-up
(one migrating ``Database`` open so the first request never pays first-open), and the ``/v1``
routes. It is referenced by the documented run command
(``uvicorn quantize.api.app:create_app --factory``).

Handlers are synchronous ``def`` (threadpool) and own their ``Database`` handle in their own body
(guaranteeing sqlite3's same-thread contract); this factory holds NO shared mutable state.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from quantize.api.dto.common import ApiError, MetaResponse
from quantize.api.errors import PAYLOAD_TOO_LARGE, install_error_handlers
from quantize.api.routes import catalog, components, datasets, runs, strategies, validate
from quantize.api.settings import ApiSettings, get_settings
from quantize.api.version import API_VERSION
from quantize.persistence.database import Database
from quantize.persistence.records import RECORD_FORMAT, TRACE_FORMAT
from quantize.schema.version import CURRENT_SCHEMA_VERSION

v1 = APIRouter(prefix="/v1")


@v1.get("/meta")
def get_meta() -> MetaResponse:
    """Service identity and the format versions a client must understand (no DB, no settings)."""
    return MetaResponse(
        api_version=API_VERSION,
        schema_version=CURRENT_SCHEMA_VERSION,
        record_format=RECORD_FORMAT,
        trace_format=TRACE_FORMAT,
    )


async def _empty_receive() -> Message:
    return {"type": "http.request", "body": b"", "more_body": False}


class _BodySizeLimitMiddleware:
    """Reject bodies larger than ``max_body_bytes`` with 413, BEFORE any parsing.

    Guards two ways (audit m7): the ``Content-Length`` header pre-read, and the actual streamed
    byte count (a missing or lying header must not bypass the cap). Bodies within the cap are
    buffered once and replayed to the handler, so ``request.body()`` downstream is unaffected —
    a plain ``BaseHTTPMiddleware`` would consume the stream and starve the route.
    """

    def __init__(self, app: ASGIApp, *, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {key.decode("latin-1").lower(): value for key, value in scope.get("headers", [])}
        content_length = headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > self.max_body_bytes:
                    await self._reject(scope, send)
                    return
            except ValueError:
                pass  # unparseable header: fall through to the streamed guard below

        body = bytearray()
        buffered: list[Message] = []
        more_body = True
        while more_body:
            message = await receive()
            buffered.append(message)
            if message["type"] != "http.request":
                break  # http.disconnect: hand the buffered messages straight through
            body.extend(message.get("body", b""))
            more_body = message.get("more_body", False)
            if len(body) > self.max_body_bytes:
                await self._reject(scope, send)
                return

        replayed = iter(buffered)

        async def _replay() -> Message:
            try:
                return next(replayed)
            except StopIteration:
                return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, _replay, send)

    async def _reject(self, scope: Scope, send: Send) -> None:
        response = JSONResponse(
            status_code=413,
            content=ApiError(
                code=PAYLOAD_TOO_LARGE,
                message=f"request body exceeds the {self.max_body_bytes}-byte limit",
            ).model_dump(),
        )
        await response(scope, _empty_receive, send)


def _ensure_valuetap_instrument(logger: logging.Logger | None = None) -> None:
    """Make the flip-trigger-3 latency instrument visible under the documented launch.

    The documented run command is plain ``uvicorn quantize.api.app:create_app --factory``, and
    Uvicorn's default logging config configures only the ``uvicorn.*`` loggers — the root logger
    stays unconfigured, so ``quantize.valuetap`` INFO records (``value tap … elapsed_ms=``) would
    be both level-dropped and handler-less. Enable INFO on the instrument logger, and attach a
    stderr handler ONLY when nothing up the ancestor chain would emit the record — an operator's
    own configuration (e.g. ``logging.basicConfig``) wins, and propagation must never double-emit.
    Idempotent: a handler this function attached satisfies the chain check on the next call.
    *logger* exists for tests (a hand-built chain); production always uses the real instrument.
    """
    if logger is None:
        logger = logging.getLogger("quantize.valuetap")
    if logger.getEffectiveLevel() > logging.INFO:
        logger.setLevel(logging.INFO)
    current: logging.Logger | None = logger
    while current is not None:
        if current.handlers:
            return
        if not current.propagate:
            break
        current = current.parent
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s %(message)s"))
    logger.addHandler(handler)


def create_app(settings: ApiSettings | None = None) -> FastAPI:
    """Build the API app. *settings* (defaulting to the environment) drive the body cap and the
    startup warm-up; handlers resolve settings via ``get_settings`` (overridden in tests)."""
    resolved = settings or get_settings()
    _ensure_valuetap_instrument()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # One migrating open so the first real request never pays first-open/migration cost.
        with Database(resolved.db_path, busy_timeout_ms=resolved.busy_timeout_ms):
            pass
        yield

    app = FastAPI(title="Quantize API", version=API_VERSION, lifespan=lifespan)
    app.state.settings = resolved
    app.add_middleware(_BodySizeLimitMiddleware, max_body_bytes=resolved.max_body_bytes)
    install_error_handlers(app)
    app.include_router(v1)
    app.include_router(validate.router)  # POST /v1/strategies/validate (before the save router)
    app.include_router(strategies.router)
    app.include_router(catalog.router)
    app.include_router(components.router)
    app.include_router(datasets.router)
    app.include_router(runs.router)
    return app
