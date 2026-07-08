"""Dataset-upload endpoint DTOs — the cross-language projection of the market dataclasses.

``DatasetUpload`` mirrors ``ExchangeCalendar`` + per-asset ``PriceObservation`` series; the M9.6
conversion constructs the frozen domain dataclasses and lets THEIR ``__post_init__`` contracts
(calendar membership, ascending dates, positive-finite prices, availability ≥ session instants)
validate — this DTO only pins the JSON shape, not the domain invariants.
"""

from __future__ import annotations

from datetime import date, datetime

from quantize.api.dto.common import _Dto


class SessionDto(_Dto):
    """One trading session: the exchange-local date plus UTC open/close instants."""

    session_date: date
    open_at: datetime
    close_at: datetime


class CalendarDto(_Dto):
    exchange: str
    timezone: str
    sessions: tuple[SessionDto, ...]


class ObservationDto(_Dto):
    """One session's open/close prices for one asset, with explicit availability instants."""

    session_date: date
    open_price: float
    close_price: float
    open_available_at: datetime
    close_available_at: datetime


class DatasetUpload(_Dto):
    """A full uploaded dataset: the calendar plus per-asset observation series (asset -> rows)."""

    calendar: CalendarDto
    observations: dict[str, tuple[ObservationDto, ...]]


class DatasetStored(_Dto):
    """Metadata for a stored dataset — the content-addressed id plus both provenance fingerprints,
    simple counts, and a read-only introspection projection (calendar bounds + canonical asset
    tickers, M13.1) computed from the stored payload. NEVER carries the payload itself. The same
    DTO serves both the upload response and describe — do not fork it."""

    dataset_id: str
    dataset_fingerprint: str
    calendar_fingerprint: str
    sessions: int
    assets: int
    first_session: date
    last_session: date
    asset_tickers: tuple[str, ...]


class DatasetListRow(_Dto):
    """One dataset discovery row — mirrors ``persistence.datasets.DatasetSummary``.

    Stored columns ONLY (identity + both fingerprints + ``saved_at``); deliberately no
    ``sessions``/``assets`` counts — those need a per-dataset payload decode (use ``DatasetStored``
    from ``GET /v1/datasets/{id}`` when a dataset is selected)."""

    dataset_id: str
    dataset_fingerprint: str
    calendar_fingerprint: str
    saved_at: str


class DatasetList(_Dto):
    datasets: tuple[DatasetListRow, ...]
