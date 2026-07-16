"""M14.9 review fix — the latency instrument must be visible under the DOCUMENTED launch.

The documented run command is plain ``uvicorn quantize.api.app:create_app --factory`` (README
Quickstart). Uvicorn's default logging config configures only the ``uvicorn.*`` loggers and leaves
the root logger unconfigured, so ``quantize.valuetap`` INFO records — the flip-trigger-3 latency
signal — would be dropped (root's WARNING default) and unemitted (no handler anywhere up the
chain). ``create_app`` must therefore enable the instrument itself, WITHOUT double-emitting when
an operator has configured logging (e.g. ``logging.basicConfig``): their handler wins.

``_ensure_valuetap_instrument``'s decision logic is exercised on hand-built ``logging.Logger``
chains (constructed directly, never registered with the global manager) because pytest's own
logging plugin keeps capture handlers on the real root — the plain-uvicorn "no handler anywhere"
state cannot be faithfully staged on the live tree. The integration test asserts the part that IS
observable under pytest: ``create_app`` enables INFO on the real instrument logger.
"""

from __future__ import annotations

import io
import logging

import pytest

from quantize.api.app import _ensure_valuetap_instrument, create_app
from quantize.api.settings import ApiSettings


def _unconfigured_chain() -> logging.Logger:
    """A two-level chain reproducing the plain-uvicorn state: the instrument logger NOTSET with
    no handlers, its terminal ancestor at WARNING (the unconfigured root's default) with no
    handlers. Built directly — no global-manager registration, nothing to restore."""
    root_like = logging.Logger("test-root-like")
    root_like.setLevel(logging.WARNING)
    logger = logging.Logger("test-valuetap")
    logger.parent = root_like
    return logger


def test_unconfigured_chain_gains_level_and_handler() -> None:
    """Plain-uvicorn state: the helper must leave an INFO ``value tap`` record actually
    emittable — level enabled AND a handler that receives it."""
    logger = _unconfigured_chain()
    _ensure_valuetap_instrument(logger)
    assert logger.isEnabledFor(logging.INFO)
    assert logger.handlers, "no handler anywhere up the chain — records vanish"
    handler = logger.handlers[0]
    assert isinstance(handler, logging.StreamHandler)
    stream = io.StringIO()
    handler.setStream(stream)
    logger.info("value tap probe elapsed_ms=1.0")
    assert "value tap probe elapsed_ms=1.0" in stream.getvalue()


def test_instrument_setup_is_idempotent() -> None:
    """The factory runs many times (tests, reloads) — the instrument handler must not stack."""
    logger = _unconfigured_chain()
    _ensure_valuetap_instrument(logger)
    _ensure_valuetap_instrument(logger)
    assert len(logger.handlers) == 1


def test_operator_logging_config_wins_no_double_emission() -> None:
    """When the operator configured logging (a handler on the root — the ``logging.basicConfig``
    case), the helper must NOT attach its own handler — propagation would emit every line twice —
    but must still enable INFO on the instrument logger."""
    logger = _unconfigured_chain()
    stream = io.StringIO()
    assert logger.parent is not None
    logger.parent.addHandler(logging.StreamHandler(stream))
    _ensure_valuetap_instrument(logger)
    assert logger.handlers == []
    assert logger.isEnabledFor(logging.INFO)
    logger.info("value tap probe elapsed_ms=2.0")
    assert stream.getvalue().count("value tap probe") == 1


def test_propagate_false_ancestor_stops_the_chain_walk() -> None:
    """An ancestor with handlers BEYOND a ``propagate=False`` boundary never receives the record —
    the walk must stop at the boundary and attach locally, or the instrument stays silent."""
    logger = _unconfigured_chain()
    assert logger.parent is not None
    logger.parent.propagate = False
    grandparent = logging.Logger("test-grandparent")
    grandparent.addHandler(logging.StreamHandler(io.StringIO()))
    logger.parent.parent = grandparent
    _ensure_valuetap_instrument(logger)
    assert logger.handlers, "the grandparent handler is unreachable — a local handler is required"


def test_create_app_enables_info_on_the_real_instrument(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """Integration: building the app wires the real ``quantize.valuetap`` logger for INFO (the
    handler half is proven on hand-built chains above — pytest holds root capture handlers, so
    under pytest the operator-wins branch correctly attaches nothing)."""
    instrument = logging.getLogger("quantize.valuetap")
    saved_level = instrument.level
    instrument.setLevel(logging.NOTSET)
    try:
        create_app(ApiSettings(db_path=str(tmp_path_factory.mktemp("app-log") / "q.db")))
        assert instrument.isEnabledFor(logging.INFO)
    finally:
        instrument.setLevel(saved_level)
