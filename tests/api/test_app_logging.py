"""The instrument-logger bootstrap contract (``quantize/api/instrumentation.py``).

The documented run command is plain ``uvicorn quantize.api.app:create_app --factory`` (README
Quickstart): Uvicorn's default logging config configures only ``uvicorn.*`` and leaves the root
logger bare, so the ``quantize.valuetap`` INFO records — the flip-trigger-3 latency signal —
would be level-dropped and handler-less. ``create_app`` bootstraps the instrument via
``ensure_instrument``, under one crisp ordering contract:

- **Anything configured when the factory runs wins entirely** — a handler anywhere up the chain
  means the operator owns logging (levels included: a deliberate WARNING silence is respected),
  and the bootstrap touches NOTHING. Under pytest this is always the branch taken (pytest's
  capture handlers sit on root), so building apps in tests never mutates the global logger.
- **Only a truly bare chain gets the bootstrap** — INFO + one stderr handler +
  ``propagate=False``, so logging configured LATER can never double-emit the instrument lines.

The decision logic is exercised on hand-built ``logging.Logger`` chains (constructed directly,
never registered with the global manager) because pytest's own root capture handlers make the
bare-process state unstageable on the live tree.
"""

from __future__ import annotations

import io
import logging

import pytest

from quantize.api.app import create_app
from quantize.api.instrumentation import ensure_instrument
from quantize.api.settings import ApiSettings

INSTRUMENT = "quantize.valuetap"


def _stream_of(logger: logging.Logger) -> io.StringIO:
    """Swap the logger's sole StreamHandler onto a StringIO and return it."""
    handler = logger.handlers[0]
    assert isinstance(handler, logging.StreamHandler)
    stream = io.StringIO()
    handler.setStream(stream)
    return stream


def _ensured(name: str) -> logging.Logger:
    """Run ensure_instrument under a throwaway manager-registered name with a bare parent."""
    parent = logging.getLogger(f"{name}-parent")
    parent.handlers.clear()
    parent.setLevel(logging.WARNING)
    parent.propagate = False  # isolate the throwaway subtree from pytest's root handlers
    logger = logging.getLogger(f"{name}-parent.leaf")
    logger.handlers.clear()
    logger.setLevel(logging.NOTSET)
    logger.propagate = True
    ensure_instrument(logger.name)
    return logger


def test_unconfigured_subtree_gains_level_handler_and_no_propagation() -> None:
    logger = _ensured("t-bootstrap")
    assert logger.isEnabledFor(logging.INFO)
    assert len(logger.handlers) == 1
    assert logger.propagate is False
    stream = _stream_of(logger)
    logger.info("value tap probe elapsed_ms=1.0")
    assert "value tap probe elapsed_ms=1.0" in stream.getvalue()


def test_late_operator_config_never_double_emits() -> None:
    """The post-factory ordering: a handler added to an ANCESTOR after the bootstrap attached its
    own must not receive the instrument's records — one line, once, via the attached handler."""
    logger = _ensured("t-late")
    own = _stream_of(logger)
    late = io.StringIO()
    assert logger.parent is not None
    logger.parent.addHandler(logging.StreamHandler(late))  # the late basicConfig stand-in
    logger.info("value tap probe elapsed_ms=2.0")
    assert own.getvalue().count("value tap probe") == 1
    assert late.getvalue() == ""


def test_configured_chain_is_left_completely_untouched() -> None:
    """A handler anywhere up the chain = the operator owns logging: no handler is attached, the
    level is NOT forced (a deliberate WARNING silence survives), propagate stays True."""
    parent = logging.getLogger("t-owned-parent")
    parent.handlers.clear()
    parent.addHandler(logging.StreamHandler(io.StringIO()))
    parent.propagate = False
    logger = logging.getLogger("t-owned-parent.leaf")
    logger.handlers.clear()
    logger.setLevel(logging.WARNING)  # the operator silenced the instrument on purpose
    logger.propagate = True
    ensure_instrument(logger.name)
    assert logger.handlers == []
    assert logger.level == logging.WARNING
    assert logger.propagate is True
    parent.handlers.clear()


def test_configured_chain_leaves_a_notset_level_alone() -> None:
    """Even a NOTSET leaf under an operator handler stays NOTSET — levels belong to the operator
    the moment any handler exists (their root/parent level decides what emits)."""
    parent = logging.getLogger("t-owned2-parent")
    parent.handlers.clear()
    parent.addHandler(logging.StreamHandler(io.StringIO()))
    parent.propagate = False
    logger = logging.getLogger("t-owned2-parent.leaf")
    logger.handlers.clear()
    logger.setLevel(logging.NOTSET)
    ensure_instrument(logger.name)
    assert logger.level == logging.NOTSET
    assert logger.handlers == []
    parent.handlers.clear()


def test_bootstrap_is_idempotent_across_calls() -> None:
    logger = _ensured("t-idem")
    ensure_instrument(logger.name)
    assert len(logger.handlers) == 1


def test_handlers_beyond_a_propagate_false_boundary_do_not_count() -> None:
    """A handler the record can never reach (beyond a ``propagate=False`` ancestor) must not
    suppress the bootstrap — ``hasHandlers`` semantics."""
    logger = _ensured("t-boundary")  # parent is propagate=False with NO handlers of its own;
    # pytest's root handlers sit beyond that boundary and must not have counted:
    assert logger.handlers, "unreachable handlers suppressed the bootstrap"


def test_create_app_leaves_a_configured_process_untouched(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """Integration (the global-state finding): under pytest the root always carries capture
    handlers, so building an app must mutate NOTHING on the real instrument logger — no leaked
    INFO enablement across the test session, no attached handler, no propagate flip."""
    instrument = logging.getLogger(INSTRUMENT)
    saved = (instrument.level, list(instrument.handlers), instrument.propagate)
    instrument.setLevel(logging.NOTSET)
    instrument.handlers.clear()
    instrument.propagate = True
    try:
        assert instrument.hasHandlers(), "pytest root capture handlers expected"
        create_app(ApiSettings(db_path=str(tmp_path_factory.mktemp("app-log") / "q.db")))
        assert instrument.level == logging.NOTSET
        assert instrument.handlers == []
        assert instrument.propagate is True
    finally:
        instrument.setLevel(saved[0])
        instrument.handlers.clear()
        instrument.handlers.extend(saved[1])
        instrument.propagate = saved[2]
