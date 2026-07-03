"""Run-input provenance (pre-M9 E): WHAT data a run consumed, as deterministic content identity.

A persisted run already links its strategy by ``(strategy_id, strategy_version)``; this module
binds it to the OTHER material inputs — the market dataset and the exchange calendar — via
canonical content hashes, so a stored run is verifiably replayable: re-supplying data with the
same fingerprints reproduces the run (deterministic engine), and a mismatch is reported
precisely rather than discovered as silent divergence.

``RunInputProvenance`` is deliberately NOT the document's ``StrategyProvenance``
(creator/owner/visibility): this is input identity, not authorship. Legacy (M7-era, format-1)
run rows migrate to an EXPLICIT ``unknown`` provenance — hashes recorded before this module
existed cannot be honestly invented, so they are not.

Identity covers exactly the facts that can affect execution and nothing environmental:
observation prices AND availability instants per asset (a delayed close changes what a replay
could see); session membership plus each session's open/close instants and the calendar's
exchange/timezone labels. Fingerprints are pure functions of content (canonical sorted-key
JSON, UTC-normalized ISO instants, SHA-256) — no paths, object identity, wall-clock, or
platform detail — computed once at the save boundary, never per evaluation.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, model_validator

from quantize.market.calendar import ExchangeCalendar
from quantize.market.data import MarketDataSet
from quantize.persistence.serialize import canonical_json_bytes, content_hash

PROVENANCE_RECORDED: Literal["recorded"] = "recorded"
PROVENANCE_UNKNOWN: Literal["unknown"] = "unknown"

DATASET_MISMATCH = "dataset_mismatch"
CALENDAR_MISMATCH = "calendar_mismatch"
UNKNOWN_PROVENANCE = "unknown_provenance"

_SHA256_HEX = re.compile(r"[0-9a-f]{64}\Z")


def calendar_fingerprint(calendar: ExchangeCalendar) -> str:
    """SHA-256 of the calendar's canonical content: exchange, timezone, and every session's
    date + UTC open/close instants (holiday changes, added/removed sessions, and boundary
    shifts all change the identity)."""
    payload: dict[str, Any] = {
        "exchange": calendar.exchange,
        "timezone": calendar.timezone,
        "sessions": [
            [
                session.session_date.isoformat(),
                session.open_at.isoformat(),
                session.close_at.isoformat(),
            ]
            for session in calendar.sessions
        ],
    }
    return content_hash(canonical_json_bytes(payload))


def dataset_fingerprint(dataset: MarketDataSet) -> str:
    """SHA-256 of the observations' canonical content: per asset, every session's open/close
    price AND both availability instants (delayed availability is execution-material)."""
    payload: dict[str, Any] = {
        "observations": {
            asset: [
                [
                    observation.session_date.isoformat(),
                    observation.open_price,
                    observation.close_price,
                    observation.open_available_at.isoformat(),
                    observation.close_available_at.isoformat(),
                ]
                for observation in series
            ]
            for asset, series in dataset.observations.items()
        }
    }
    return content_hash(canonical_json_bytes(payload))


class RunInputProvenance(BaseModel):
    """The run's input identity: recorded content hashes, or an explicit honest unknown."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    status: Literal["recorded", "unknown"]
    dataset_hash: str | None = None
    calendar_hash: str | None = None

    @model_validator(mode="after")
    def _hashes_match_status(self) -> RunInputProvenance:
        recorded = self.status == PROVENANCE_RECORDED
        has_hashes = self.dataset_hash is not None and self.calendar_hash is not None
        has_none = self.dataset_hash is None and self.calendar_hash is None
        if recorded and not has_hashes:
            raise ValueError("recorded provenance requires both dataset and calendar hashes")
        if not recorded and not has_none:
            raise ValueError("unknown provenance must not carry hashes (never fabricated)")
        # Recorded hashes are REAL digests (Codex pre-M9 review): 64-char lowercase hex only —
        # a malformed 'hash' in the durable envelope is worse than none at all.
        for label, value in (
            ("dataset_hash", self.dataset_hash),
            ("calendar_hash", self.calendar_hash),
        ):
            if value is not None and not _SHA256_HEX.fullmatch(value):
                raise ValueError(f"{label} must be a 64-character lowercase hex SHA-256 digest")
        return self


def recorded_input_provenance(market_data: MarketDataSet) -> RunInputProvenance:
    """The provenance of a run executed over *market_data* — computed at the save boundary."""
    return RunInputProvenance(
        status=PROVENANCE_RECORDED,
        dataset_hash=dataset_fingerprint(market_data),
        calendar_hash=calendar_fingerprint(market_data.calendar),
    )


def unknown_input_provenance() -> RunInputProvenance:
    """The explicit honest unknown (legacy format-1 rows; see the module docstring)."""
    return RunInputProvenance(status=PROVENANCE_UNKNOWN)


def input_provenance_mismatches(
    recorded: RunInputProvenance, market_data: MarketDataSet
) -> tuple[str, ...]:
    """Compare a stored run's provenance against candidate replay inputs, precisely.

    Returns ``()`` when the inputs match; otherwise the sorted stable mismatch codes:
    ``unknown_provenance`` (nothing was recorded — replay cannot be VERIFIED, only attempted),
    ``calendar_mismatch``, and/or ``dataset_mismatch``.
    """
    if recorded.status == PROVENANCE_UNKNOWN:
        return (UNKNOWN_PROVENANCE,)
    mismatches: list[str] = []
    if recorded.calendar_hash != calendar_fingerprint(market_data.calendar):
        mismatches.append(CALENDAR_MISMATCH)
    if recorded.dataset_hash != dataset_fingerprint(market_data):
        mismatches.append(DATASET_MISMATCH)
    return tuple(sorted(mismatches))
