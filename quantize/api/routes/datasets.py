"""Dataset-upload endpoints: store uploaded market data (content-addressed), fetch its metadata.

The route does the DTO↔domain conversion: ``DatasetUpload`` → the frozen ``MarketDataSet`` domain
dataclasses, whose ``__post_init__`` contracts validate (a violated contract → 422 with the
constructor message). The repository is content-addressed and idempotent (identical re-upload →
200). ``GET`` returns metadata only — never the payload.
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status

from quantize.api.dto.datasets import DatasetStored, DatasetUpload
from quantize.api.errors import ApiRequestError
from quantize.api.parsing import JsonBody, SettingsDep, load_dto
from quantize.market.calendar import ExchangeCalendar, MarketSession
from quantize.market.data import MarketDataSet, PriceObservation
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository, StoredDatasetInfo

router = APIRouter(prefix="/v1/datasets", tags=["datasets"])

INVALID_DATASET = "invalid_dataset"


def _to_market_dataset(upload: DatasetUpload) -> MarketDataSet:
    """Construct the domain dataclasses; their ``__post_init__`` contracts do the validation."""
    sessions = tuple(
        MarketSession(session_date=s.session_date, open_at=s.open_at, close_at=s.close_at)
        for s in upload.calendar.sessions
    )
    calendar = ExchangeCalendar(
        exchange=upload.calendar.exchange, timezone=upload.calendar.timezone, sessions=sessions
    )
    observations = {
        asset: [
            PriceObservation(
                session_date=obs.session_date,
                open_price=obs.open_price,
                close_price=obs.close_price,
                open_available_at=obs.open_available_at,
                close_available_at=obs.close_available_at,
            )
            for obs in series
        ]
        for asset, series in upload.observations.items()
    }
    return MarketDataSet(calendar=calendar, observations=observations)


def _stored(info: StoredDatasetInfo) -> DatasetStored:
    return DatasetStored(
        dataset_id=info.dataset_id,
        dataset_fingerprint=info.dataset_fingerprint,
        calendar_fingerprint=info.calendar_fingerprint,
        sessions=info.sessions,
        assets=info.assets,
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def upload_dataset(body: JsonBody, settings: SettingsDep, response: Response) -> DatasetStored:
    upload = load_dto(body, DatasetUpload)  # 400 parse, 422 DTO shape
    try:
        market_data = _to_market_dataset(upload)  # domain __post_init__: ValueError → 422
    except ValueError as error:
        raise ApiRequestError(422, INVALID_DATASET, str(error)) from error
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        info, created = DatasetRepository(db).save(market_data)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return _stored(info)


@router.get("/{dataset_id}")
def describe_dataset(dataset_id: str, settings: SettingsDep) -> DatasetStored:
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        info = DatasetRepository(db).describe(dataset_id)
    return _stored(info)
