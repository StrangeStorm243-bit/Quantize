"""Instrument-logger bootstrap for the API process.

The documented run command is plain ``uvicorn quantize.api.app:create_app --factory``, and
Uvicorn's default logging config configures only the ``uvicorn.*`` loggers — the root logger
stays bare, so an instrument logger's INFO records (e.g. ``quantize.valuetap``'s
``value tap … elapsed_ms=`` flip-trigger-3 signal) would be both level-dropped and handler-less.
``ensure_instrument`` makes such a logger visible under that launch, under one crisp ordering
contract: **any logging configuration present when the factory runs wins outright.**
"""

from __future__ import annotations

import logging


def ensure_instrument(name: str) -> None:
    """Make instrument logger *name* visible in an otherwise-unconfigured process.

    The contract is drawn at handler PRESENCE (``Logger.hasHandlers`` — a ``propagate=False``
    boundary stops the search), checked once, at factory time:

    - **Anything configured wins entirely.** A reachable handler anywhere up the chain means the
      operator owns logging, and this function touches NOTHING — no handler, no level, no
      propagate flip. Operator levels are respected as intent, including a deliberate WARNING
      that silences the instrument and a WARNING-level root handler that drops INFO records.
      Under pytest (capture handlers on root) this is always the branch taken, so building apps
      in tests never mutates the process-global logger.
    - **Only a truly bare chain gets the bootstrap:** INFO level, one stderr handler, and
      ``propagate = False`` — so logging configured LATER (a root handler added after the
      factory returns) can never double-emit the instrument's records; the attached handler
      stays the single emitter. To own the instrument's emission entirely, configure logging
      BEFORE the factory runs (as Uvicorn's ``--log-config`` and a pre-``uvicorn.run``
      ``basicConfig`` do).
    - Idempotent: the attached handler satisfies the presence check on the next call.
    """
    logger = logging.getLogger(name)
    if logger.hasHandlers():
        return
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s %(message)s"))
    logger.addHandler(handler)
