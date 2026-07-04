"""Run-submission and result/trace/list endpoint DTOs.

Run requests carry the initial portfolio state (``initial_cash`` required and positive;
``initial_positions`` optional) plus an optional session window; ``ForwardRunRequest`` additionally
REQUIRES ``last_session`` (forward replay is bounded run-to-exhaustion). Results reuse the governed
persistence/tracing models verbatim: ``RunRecordResponse`` embeds ``PersistedRunRecord`` and pairs
it with ``replay_verifiable``; ``TraceResponse`` wraps the stored ``TraceEvent`` stream. The
list-row DTO mirrors ``persistence.runs.RunSummary`` field-for-field.
"""

from __future__ import annotations

from datetime import date

from pydantic import Field

from quantize.api.dto.common import _Dto
from quantize.persistence.records import PersistedRunRecord
from quantize.tracing.events import TraceEvent


class BacktestRunRequest(_Dto):
    """A backtest submission. ``last_session`` is optional (defaults to the dataset's last)."""

    strategy_id: str
    strategy_version: int
    dataset_id: str
    initial_cash: float
    initial_positions: dict[str, float] = Field(default_factory=dict)
    first_session: date | None = None
    last_session: date | None = None


class ForwardRunRequest(_Dto):
    """A forward-replay submission — identical to backtest but ``last_session`` is REQUIRED."""

    strategy_id: str
    strategy_version: int
    dataset_id: str
    initial_cash: float
    initial_positions: dict[str, float] = Field(default_factory=dict)
    first_session: date | None = None
    last_session: date


class RunCreated(_Dto):
    """Acknowledgement of a submitted (and synchronously executed + persisted) run."""

    run_id: str


class RunListRow(_Dto):
    """One run summary row — mirrors ``persistence.runs.RunSummary``."""

    run_id: str
    strategy_id: str
    strategy_version: int
    mode: str
    ok: bool
    first_session: str | None
    last_session: str | None
    total_return: float
    saved_at: str


class RunList(_Dto):
    runs: tuple[RunListRow, ...]


class RunRecordResponse(_Dto):
    """The stored run record plus whether its inputs were fingerprinted (recorded provenance).

    ``replay_verifiable`` lives BESIDE the record, never inside it: the ``record`` value is the
    stored artifact verbatim; ``replay_verifiable`` is a derived, non-persisted flag."""

    record: PersistedRunRecord
    replay_verifiable: bool


class TraceResponse(_Dto):
    """The run's decision-trace events in stored sequence order (optionally session-filtered)."""

    events: tuple[TraceEvent, ...]
