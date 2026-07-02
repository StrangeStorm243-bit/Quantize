"""Canonical persistence serialization (M7).

Documents and record envelopes serialize through the M1 boundary (``to_ir_dict``/``to_ir_json``
— aliased, portable, rejects NaN/non-finite/unsafe ints; model/insertion key order). The
``content_hash`` of every artifact is SHA-256 of its EXACT stored bytes — never a re-sorted
form — so save-time idempotency checks and load-time integrity re-hashing always compare the
same bytes. ``canonical_json_bytes`` (sorted keys) exists only for plain non-model dicts and is
never applied to model-derived payloads.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel

from quantize.persistence.errors import INVALID_ARTIFACT, PersistenceError
from quantize.schema.serialization import to_ir_json


def model_bytes(model: BaseModel) -> bytes:
    """The exact stored bytes of a governed model (M1 canonical form, UTF-8)."""
    return to_ir_json(model).encode("utf-8")


def artifact_bytes(model: BaseModel, *, kind: str, key: object) -> bytes:
    """``model_bytes`` for SAVE paths: a non-portable model (NaN/Infinity/unsafe int) surfaces
    as structured ``invalid_artifact``, never a raw ``ValueError``."""
    try:
        return model_bytes(model)
    except ValueError as error:
        raise PersistenceError(
            INVALID_ARTIFACT,
            f"{kind} cannot be persisted: {error}",
            {"kind": kind, "key": key},
        ) from error


def canonical_json_bytes(payload: dict[str, Any]) -> bytes:
    """Deterministic bytes for a plain JSON dict (sorted keys; non-model data only)."""
    dumped = json.dumps(
        payload, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")
    )
    return dumped.encode("utf-8")


def _reject_constant(token: str) -> float:
    raise ValueError(f"non-portable JSON constant {token!r} is not loadable")


def strict_json_loads(text: str) -> Any:
    """``json.loads`` that REJECTS the non-standard NaN/Infinity tokens the default parser
    silently accepts — load-side mirror of the save-side ``allow_nan=False`` discipline."""
    return json.loads(text, parse_constant=_reject_constant)


def content_hash(stored_bytes: bytes) -> str:
    """SHA-256 hex of the exact stored bytes (artifact identity; excludes row metadata)."""
    return hashlib.sha256(stored_bytes).hexdigest()
