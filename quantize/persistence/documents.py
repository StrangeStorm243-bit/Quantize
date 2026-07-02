"""Strategy-document and component repositories (M7.4).

Immutable, versioned artifacts under their natural keys — ``(strategy.id, strategy.version)``
and ``(component_id, version)``. Saves are idempotent for byte-identical content and a
structured ``artifact_conflict`` for divergent content under an existing key; there is no
update API. Loads gate the stored IR ``schema_version`` against M1's supported set BEFORE
domain validation, re-hash the stored bytes against the recorded ``content_hash``, and return a
freshly validated model — never a partial object.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime

from pydantic import ValidationError

from quantize.persistence.database import Database
from quantize.persistence.errors import (
    ARTIFACT_CONFLICT,
    ARTIFACT_NOT_FOUND,
    CORRUPT_ARTIFACT,
    INVALID_ARTIFACT,
    UNSUPPORTED_ARTIFACT_VERSION,
    PersistenceError,
)
from quantize.persistence.serialize import (
    artifact_bytes,
    content_hash,
    strict_json_loads,
)
from quantize.schema.components import ComponentDefinition
from quantize.schema.document import StrategyDocument
from quantize.schema.version import SUPPORTED_SCHEMA_VERSIONS, is_supported_schema_version


@dataclass(frozen=True)
class StrategyKey:
    strategy_id: str
    version: int


@dataclass(frozen=True)
class StrategySummary:
    strategy_id: str
    version: int
    name: str
    schema_version: str
    saved_at: str


@dataclass(frozen=True)
class ComponentKey:
    component_id: str
    version: str


@dataclass(frozen=True)
class ComponentSummary:
    component_id: str
    version: str
    name: str
    schema_version: str
    saved_at: str


def _now() -> str:
    return datetime.now(UTC).isoformat()  # row metadata only — never part of artifact identity


def _decode_json(raw: object, *, kind: str, key: object) -> dict[str, object]:
    if not isinstance(raw, str):
        raise PersistenceError(
            CORRUPT_ARTIFACT, f"stored {kind} payload is not text", {"kind": kind, "key": key}
        )
    try:
        decoded = strict_json_loads(raw)
    except (json.JSONDecodeError, ValueError) as error:
        raise PersistenceError(
            CORRUPT_ARTIFACT,
            f"stored {kind} is not portable JSON: {error}",
            {"kind": kind, "key": key},
        ) from error
    if not isinstance(decoded, dict):
        raise PersistenceError(
            CORRUPT_ARTIFACT, f"stored {kind} is not a JSON object", {"kind": kind, "key": key}
        )
    return decoded


def _gate_schema_version(
    payload: dict[str, object], row_version: object, *, kind: str, key: object
) -> None:
    # M1's model validation checks SemVer SYNTAX only; supportedness is gated here (the same
    # posture as structural load). The PAYLOAD is the source of truth — the row column is
    # metadata and must agree with it (a divergence is corruption, not a version problem).
    payload_version = payload.get("schema_version")
    if not isinstance(payload_version, str) or not is_supported_schema_version(payload_version):
        raise PersistenceError(
            UNSUPPORTED_ARTIFACT_VERSION,
            f"stored {kind} payload has unsupported schema_version {payload_version!r}",
            {"kind": kind, "key": key, "supported": sorted(SUPPORTED_SCHEMA_VERSIONS)},
        )
    if row_version != payload_version:
        raise PersistenceError(
            CORRUPT_ARTIFACT,
            f"stored {kind} row schema_version {row_version!r} does not match the payload's "
            f"{payload_version!r}",
            {"kind": kind, "key": key},
        )


def _require_supported_for_save(version: str, *, kind: str, key: object) -> None:
    # Save-side gate: the repository stores VALIDATED IR only; a well-formed future
    # schema_version is syntactically valid to pydantic but must not be persisted.
    if not is_supported_schema_version(version):
        raise PersistenceError(
            INVALID_ARTIFACT,
            f"{kind} schema_version {version!r} is not supported and cannot be persisted",
            {"kind": kind, "key": key, "supported": sorted(SUPPORTED_SCHEMA_VERSIONS)},
        )


def _verify_hash(stored: bytes, recorded: object, *, kind: str, key: object) -> None:
    if content_hash(stored) != recorded:
        raise PersistenceError(
            CORRUPT_ARTIFACT,
            f"stored {kind} bytes do not match their recorded content hash",
            {"kind": kind, "key": key},
        )


class StrategyRepository:
    def __init__(self, database: Database) -> None:
        self._db = database

    def save(self, document: StrategyDocument) -> StrategyKey:
        """Idempotent immutable save under the document's own identity. Never mutates input."""
        key, pending = self.prepare_save(document)
        if pending is None:
            return key  # byte-identical duplicate: no-op
        try:
            with self._db.transaction() as connection:
                connection.execute(*pending)
        except sqlite3.IntegrityError as error:
            raise PersistenceError(
                ARTIFACT_CONFLICT,
                f"strategy {key.strategy_id} v{key.version} was concurrently saved with "
                "different content",
                {"strategy_id": key.strategy_id, "version": key.version},
            ) from error
        return key

    def prepare_save(
        self, document: StrategyDocument
    ) -> tuple[StrategyKey, tuple[str, tuple[object, ...]] | None]:
        """Validate + duplicate-check now; return the INSERT for the caller's transaction.

        ``None`` means a byte-identical duplicate already exists (idempotent no-op). Used by
        ``save`` and by ``RunRepository.save_run`` so the strategy row joins the run+trace
        transaction (the plan's in-transaction auto-save).
        """
        key = StrategyKey(document.strategy.id, document.strategy.version)
        _require_supported_for_save(
            document.schema_version, kind="strategy", key=(key.strategy_id, key.version)
        )
        stored = artifact_bytes(document, kind="strategy", key=(key.strategy_id, key.version))
        digest = content_hash(stored)
        existing = self._db.query(
            "SELECT content_hash FROM strategies WHERE strategy_id = ? AND version = ?",
            (key.strategy_id, key.version),
        )
        if existing:
            if existing[0][0] == digest:
                return key, None
            raise PersistenceError(
                ARTIFACT_CONFLICT,
                f"strategy {key.strategy_id} v{key.version} already exists with "
                "different content; persisted artifacts are immutable",
                {"strategy_id": key.strategy_id, "version": key.version},
            )
        statement = (
            "INSERT INTO strategies (strategy_id, version, schema_version, name, "
            "content_hash, document, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        parameters: tuple[object, ...] = (
            key.strategy_id,
            key.version,
            document.schema_version,
            document.strategy.name,
            digest,
            stored.decode("utf-8"),
            _now(),
        )
        return key, (statement, parameters)

    def load(self, strategy_id: str, version: int) -> StrategyDocument:
        rows = self._db.query(
            "SELECT document, content_hash, schema_version FROM strategies "
            "WHERE strategy_id = ? AND version = ?",
            (strategy_id, version),
        )
        if not rows:
            raise PersistenceError(
                ARTIFACT_NOT_FOUND,
                f"strategy {strategy_id} v{version} is not stored",
                {"strategy_id": strategy_id, "version": version},
            )
        raw, recorded_hash, schema_version = rows[0]
        key = (strategy_id, version)
        if not isinstance(raw, str):
            raise PersistenceError(CORRUPT_ARTIFACT, "stored strategy is not text", {"key": key})
        _verify_hash(raw.encode("utf-8"), recorded_hash, kind="strategy", key=key)
        payload = _decode_json(raw, kind="strategy", key=key)
        _gate_schema_version(payload, schema_version, kind="strategy", key=key)
        try:
            return StrategyDocument.model_validate(payload)
        except ValidationError as error:
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"stored strategy failed domain validation: {error.error_count()} error(s)",
                {"strategy_id": strategy_id, "version": version},
            ) from error

    def list_strategies(self) -> tuple[StrategySummary, ...]:
        rows = self._db.query(
            "SELECT strategy_id, version, name, schema_version, saved_at FROM strategies "
            "ORDER BY strategy_id, version"
        )
        return tuple(
            StrategySummary(str(r[0]), int(r[1]), str(r[2]), str(r[3]), str(r[4]))  # type: ignore[call-overload]
            for r in rows
        )

    def list_versions(self, strategy_id: str) -> tuple[int, ...]:
        rows = self._db.query(
            "SELECT version FROM strategies WHERE strategy_id = ? ORDER BY version",
            (strategy_id,),
        )
        return tuple(int(r[0]) for r in rows)  # type: ignore[call-overload]


class ComponentRepository:
    def __init__(self, database: Database) -> None:
        self._db = database

    def save(self, definition: ComponentDefinition) -> ComponentKey:
        key = ComponentKey(definition.component_id, definition.version)
        _require_supported_for_save(
            definition.schema_version, kind="component", key=(key.component_id, key.version)
        )
        stored = artifact_bytes(definition, kind="component", key=(key.component_id, key.version))
        digest = content_hash(stored)
        existing = self._db.query(
            "SELECT content_hash FROM components WHERE component_id = ? AND version = ?",
            (key.component_id, key.version),
        )
        if existing:
            if existing[0][0] == digest:
                return key
            raise PersistenceError(
                ARTIFACT_CONFLICT,
                f"component {key.component_id} v{key.version} already exists with "
                "different content; persisted artifacts are immutable",
                {"component_id": key.component_id, "version": key.version},
            )
        try:
            with self._db.transaction() as connection:
                connection.execute(
                    "INSERT INTO components (component_id, version, schema_version, name, "
                    "content_hash, document, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        key.component_id,
                        key.version,
                        definition.schema_version,
                        definition.name,
                        digest,
                        stored.decode("utf-8"),
                        _now(),
                    ),
                )
        except sqlite3.IntegrityError as error:
            # A racing writer through a second Database handle: surface the contract error,
            # never a backend-shaped exception.
            raise PersistenceError(
                ARTIFACT_CONFLICT,
                f"component {key.component_id} v{key.version} was concurrently saved with "
                "different content",
                {"component_id": key.component_id, "version": key.version},
            ) from error
        return key

    def load(self, component_id: str, version: str) -> ComponentDefinition:
        rows = self._db.query(
            "SELECT document, content_hash, schema_version FROM components "
            "WHERE component_id = ? AND version = ?",
            (component_id, version),
        )
        if not rows:
            raise PersistenceError(
                ARTIFACT_NOT_FOUND,
                f"component {component_id} v{version} is not stored",
                {"component_id": component_id, "version": version},
            )
        raw, recorded_hash, schema_version = rows[0]
        key = (component_id, version)
        if not isinstance(raw, str):
            raise PersistenceError(CORRUPT_ARTIFACT, "stored component is not text", {"key": key})
        _verify_hash(raw.encode("utf-8"), recorded_hash, kind="component", key=key)
        payload = _decode_json(raw, kind="component", key=key)
        _gate_schema_version(payload, schema_version, kind="component", key=key)
        try:
            return ComponentDefinition.model_validate(payload)
        except ValidationError as error:
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"stored component failed domain validation: {error.error_count()} error(s)",
                {"component_id": component_id, "version": version},
            ) from error

    def list_components(self) -> tuple[ComponentSummary, ...]:
        rows = self._db.query(
            "SELECT component_id, version, name, schema_version, saved_at FROM components "
            "ORDER BY component_id, version"
        )
        return tuple(
            ComponentSummary(str(r[0]), str(r[1]), str(r[2]), str(r[3]), str(r[4])) for r in rows
        )
