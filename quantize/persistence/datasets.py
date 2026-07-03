"""Content-addressed uploaded-market-data store (M9.6, database migration v2).

A dataset's identity is the SHA-256 of its full canonical payload — calendar AND observations —
so two uploads with identical observations but different calendars never collide (the calendar is
execution-material). Saves are idempotent by that id (a byte-identical re-upload is a no-op);
divergence is impossible by construction. Loads reconstruct a ``MarketDataSet`` whose domain
contracts (calendar membership, ascending dates, positive-finite prices, availability instants)
re-validate; a corrupt stored row surfaces as ``corrupt_artifact``.

This module knows the market DOMAIN (``MarketDataSet``) but NOT the API layer — the route does the
DTO↔domain conversion (invariant 6: no API types in persistence).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataSet, PriceObservation
from quantize.persistence.database import Database
from quantize.persistence.errors import (
    ARTIFACT_NOT_FOUND,
    CORRUPT_ARTIFACT,
    IntegrityViolationError,
    PersistenceError,
)
from quantize.persistence.provenance import calendar_fingerprint, dataset_fingerprint
from quantize.persistence.serialize import canonical_json_bytes, content_hash, strict_json_loads


@dataclass(frozen=True)
class StoredDatasetInfo:
    """Metadata for a stored dataset (never the payload): identity + provenance + simple counts."""

    dataset_id: str
    dataset_fingerprint: str
    calendar_fingerprint: str
    sessions: int
    assets: int


def _now() -> str:
    return datetime.now(UTC).isoformat()  # row metadata only — never part of dataset identity


def _canonical_payload(market_data: MarketDataSet) -> dict[str, Any]:
    """The full, deterministic, UTC-normalized payload that IS the dataset's identity source."""
    return {
        "calendar": {
            "exchange": market_data.calendar.exchange,
            "timezone": market_data.calendar.timezone,
            "sessions": [
                {
                    "session_date": session.session_date.isoformat(),
                    "open_at": session.open_at.isoformat(),
                    "close_at": session.close_at.isoformat(),
                }
                for session in market_data.calendar.sessions
            ],
        },
        "observations": {
            asset: [
                {
                    "session_date": obs.session_date.isoformat(),
                    "open_price": obs.open_price,
                    "close_price": obs.close_price,
                    "open_available_at": obs.open_available_at.isoformat(),
                    "close_available_at": obs.close_available_at.isoformat(),
                }
                for obs in series
            ]
            for asset, series in market_data.observations.items()
        },
    }


def _market_from_payload(payload: dict[str, Any], dataset_id: str) -> MarketDataSet:
    """Reconstruct a ``MarketDataSet`` from a stored payload; a malformed row is corrupt."""
    try:
        calendar_payload = payload["calendar"]
        sessions = tuple(
            MarketSession(
                session_date=date.fromisoformat(session["session_date"]),
                open_at=datetime.fromisoformat(session["open_at"]),
                close_at=datetime.fromisoformat(session["close_at"]),
            )
            for session in calendar_payload["sessions"]
        )
        calendar = ExchangeCalendar(
            exchange=calendar_payload["exchange"],
            timezone=calendar_payload["timezone"],
            sessions=sessions,
        )
        observations = {
            asset: [
                PriceObservation(
                    session_date=date.fromisoformat(obs["session_date"]),
                    open_price=obs["open_price"],
                    close_price=obs["close_price"],
                    open_available_at=datetime.fromisoformat(obs["open_available_at"]),
                    close_available_at=datetime.fromisoformat(obs["close_available_at"]),
                )
                for obs in series
            ]
            for asset, series in payload["observations"].items()
        }
        return MarketDataSet(calendar=calendar, observations=observations)
    except (KeyError, TypeError, ValueError) as error:
        raise PersistenceError(
            CORRUPT_ARTIFACT,
            f"stored dataset {dataset_id} is not a reconstructable MarketDataSet: {error}",
            {"dataset_id": dataset_id},
        ) from error


class DatasetRepository:
    def __init__(self, database: Database) -> None:
        self._db = database

    def _info(self, market_data: MarketDataSet, dataset_id: str) -> StoredDatasetInfo:
        return StoredDatasetInfo(
            dataset_id=dataset_id,
            dataset_fingerprint=dataset_fingerprint(market_data),
            calendar_fingerprint=calendar_fingerprint(market_data.calendar),
            sessions=len(market_data.calendar.sessions),
            assets=len(market_data.observations),
        )

    def save(self, market_data: MarketDataSet) -> tuple[StoredDatasetInfo, bool]:
        """Store *market_data* content-addressed. Returns (info, created) — created is False for a
        byte-identical re-upload (idempotent no-op; divergence is impossible by construction)."""
        payload_bytes = canonical_json_bytes(_canonical_payload(market_data))
        dataset_id = content_hash(payload_bytes)
        info = self._info(market_data, dataset_id)
        existing = self._db.query("SELECT 1 FROM datasets WHERE dataset_id = ?", (dataset_id,))
        if existing:
            return info, False
        try:
            with self._db.transaction() as connection:
                connection.execute(
                    "INSERT INTO datasets (dataset_id, dataset_fingerprint, "
                    "calendar_fingerprint, payload, saved_at) VALUES (?, ?, ?, ?, ?)",
                    (
                        dataset_id,
                        info.dataset_fingerprint,
                        info.calendar_fingerprint,
                        payload_bytes.decode("utf-8"),
                        _now(),
                    ),
                )
        except IntegrityViolationError:
            # A racing writer stored the same content-addressed id: idempotent, not a conflict.
            return info, False
        return info, True

    def load(self, dataset_id: str) -> MarketDataSet:
        payload = self._payload(dataset_id)
        return _market_from_payload(payload, dataset_id)

    def describe(self, dataset_id: str) -> StoredDatasetInfo:
        rows = self._db.query(
            "SELECT dataset_fingerprint, calendar_fingerprint, payload FROM datasets "
            "WHERE dataset_id = ?",
            (dataset_id,),
        )
        if not rows:
            raise PersistenceError(
                ARTIFACT_NOT_FOUND,
                f"dataset {dataset_id} is not stored",
                {"dataset_id": dataset_id},
            )
        dataset_fp, calendar_fp, payload_text = rows[0]
        market_data = _market_from_payload(self._decode(payload_text, dataset_id), dataset_id)
        return StoredDatasetInfo(
            dataset_id=dataset_id,
            dataset_fingerprint=str(dataset_fp),
            calendar_fingerprint=str(calendar_fp),
            sessions=len(market_data.calendar.sessions),
            assets=len(market_data.observations),
        )

    def _payload(self, dataset_id: str) -> dict[str, Any]:
        rows = self._db.query("SELECT payload FROM datasets WHERE dataset_id = ?", (dataset_id,))
        if not rows:
            raise PersistenceError(
                ARTIFACT_NOT_FOUND,
                f"dataset {dataset_id} is not stored",
                {"dataset_id": dataset_id},
            )
        return self._decode(rows[0][0], dataset_id)

    def _decode(self, raw: object, dataset_id: str) -> dict[str, Any]:
        if not isinstance(raw, str):
            raise PersistenceError(
                CORRUPT_ARTIFACT, "stored dataset payload is not text", {"dataset_id": dataset_id}
            )
        try:
            decoded = strict_json_loads(raw)
        except ValueError as error:
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"stored dataset {dataset_id} is not portable JSON: {error}",
                {"dataset_id": dataset_id},
            ) from error
        if not isinstance(decoded, dict):
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"stored dataset {dataset_id} is not a JSON object",
                {"dataset_id": dataset_id},
            )
        return decoded
