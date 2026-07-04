"""Run orchestration — the API's ONLY run-execution site (no engine changes).

Each function loads the stored strategy + dataset, builds the initial portfolio state, mints a
server-side ``run_id``, runs the EXISTING engine (backtest or the forward exhaust loop), records
input provenance at the save boundary, and persists via ``RunRepository.save_run``. It owns NOTHING
numerical — every computation is an existing engine/persistence entrypoint. Handlers pass the raw
settings so this opens its own ``Database`` in one place per submission.
"""

from __future__ import annotations

import uuid

from quantize.api.dto.runs import BacktestRunRequest, ForwardRunRequest
from quantize.api.errors import ApiRequestError
from quantize.api.settings import ApiSettings
from quantize.engine.backtest import run_backtest
from quantize.engine.forward import ForwardReplay
from quantize.engine.state import PortfolioState
from quantize.nodes import build_core_catalog
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository
from quantize.persistence.documents import StrategyRepository
from quantize.persistence.provenance import recorded_input_provenance
from quantize.persistence.records import RUN_MODE_BACKTEST, RUN_MODE_FORWARD
from quantize.persistence.runs import RunRepository

INVALID_INITIAL_STATE = "invalid_initial_state"


def _portfolio_state(cash: float, positions: dict[str, float]) -> PortfolioState:
    try:
        return PortfolioState.of(cash, positions)
    except ValueError as error:
        raise ApiRequestError(422, INVALID_INITIAL_STATE, str(error)) from error


def execute_backtest_run(settings: ApiSettings, request: BacktestRunRequest) -> str:
    """Load, run a historical backtest, persist. Returns the minted run_id. Strategy/dataset not
    found → 404 (repository ARTIFACT_NOT_FOUND); bad initial state → 422."""
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        document = StrategyRepository(db).load(request.strategy_id, request.strategy_version)
        market_data = DatasetRepository(db).load(request.dataset_id)
        state = _portfolio_state(request.initial_cash, request.initial_positions)
        run_id = str(uuid.uuid4())  # server-minted; run submission is not idempotent (documented)
        result = run_backtest(
            document,
            catalog=build_core_catalog(),
            market_data=market_data,
            run_id=run_id,
            initial_state=state,
            first_session=request.first_session,
            last_session=request.last_session,
        )
        RunRepository(db).save_run(
            document,
            result,
            input_provenance=recorded_input_provenance(market_data),
            mode=RUN_MODE_BACKTEST,
        )
    return run_id


def execute_forward_run(settings: ApiSettings, request: ForwardRunRequest) -> str:
    """Load, run bounded forward replay to exhaustion, persist. ``last_session`` is required by the
    DTO (bounded replay). Same engine core as backtest → mode-agnostic record shape."""
    with Database(settings.db_path, busy_timeout_ms=settings.busy_timeout_ms) as db:
        document = StrategyRepository(db).load(request.strategy_id, request.strategy_version)
        market_data = DatasetRepository(db).load(request.dataset_id)
        state = _portfolio_state(request.initial_cash, request.initial_positions)
        run_id = str(uuid.uuid4())
        replay = ForwardReplay(
            document,
            catalog=build_core_catalog(),
            market_data=market_data,
            run_id=run_id,
            initial_state=state,
            first_session=request.first_session,
            last_session=request.last_session,
        )
        while not replay.exhausted:
            replay.advance()
        RunRepository(db).save_run(
            document,
            replay.result(),
            input_provenance=recorded_input_provenance(market_data),
            mode=RUN_MODE_FORWARD,
        )
    return run_id
