"""M14.1c — GET /v1/runs/{run_id}/values, the Node Value Tap's HTTP surface.

The route parses/validates the value address, delegates to the recompute service
(``quantize/valuetap``), and serializes through the frozen ``NodeValueResponse`` contract. Oracles
here are non-tautological: the happy-path body is compared against the PERSISTED run's target
weights (loaded via the repository, not a second recompute); the failure matrix asserts BOTH the
HTTP status and the stable ``code`` for each refusal condition. Runs are seeded directly through
the repositories against the fixture app's DB (same pattern as ``tests/test_valuetap_service.py``),
then read back over the wire via the module ``client``. All fixture data; no network.
"""

from __future__ import annotations

import copy
from typing import Any

import pytest
from fastapi.testclient import TestClient

from quantize.api.settings import ApiSettings
from quantize.components.resolve import ComponentCatalog
from quantize.engine.backtest import run_backtest
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository
from quantize.persistence.documents import ComponentRepository
from quantize.persistence.provenance import recorded_input_provenance, unknown_input_provenance
from quantize.persistence.records import (
    PersistedRunRecord,
    record_from_result,
)
from quantize.persistence.runs import RunRepository
from quantize.persistence.serialize import artifact_bytes, content_hash
from quantize.schema.document import StrategyDocument
from tests.helpers import load_fixture
from tests.valuetap_helpers import dual_component, dual_strategy, tamper_trace

RUN_ID = "99999999-9999-9999-9999-999999999999"
UNKNOWN_RUN_ID = "88888888-8888-8888-8888-888888888888"
CASH = 1_000_000.0

_ERROR_KEYS = {"code", "message"}


# --- module-scoped precomputed backtests (depend only on ``market``) ------------------------------


@pytest.fixture(scope="module")
def strategy_a_result(market: MarketDataSet) -> tuple[StrategyDocument, BacktestResult]:
    document = StrategyDocument.model_validate(load_fixture("strategy_a"))
    result = run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=CASH),
    )
    return document, result


@pytest.fixture(scope="module")
def dual_result(market: MarketDataSet) -> tuple[StrategyDocument, BacktestResult]:
    document = dual_strategy()
    result = run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=CASH),
        components=ComponentCatalog([dual_component()]),
    )
    return document, result


# --- seeding helpers (write into the fixture app's per-test DB) ---------------------------------


def _seed(
    db_path: str,
    document: StrategyDocument,
    result: BacktestResult,
    market: MarketDataSet,
    *,
    save_dataset: bool = True,
) -> PersistedRunRecord:
    with Database(db_path) as db:
        if save_dataset:
            DatasetRepository(db).save(market)
        runs = RunRepository(db)
        runs.save_run(document, result, input_provenance=recorded_input_provenance(market))
        return runs.load_run(RUN_ID)


def _seed_dual(
    db_path: str, document: StrategyDocument, result: BacktestResult, market: MarketDataSet
) -> PersistedRunRecord:
    with Database(db_path) as db:
        ComponentRepository(db).save(dual_component())
    return _seed(db_path, document, result, market)


@pytest.fixture
def strategy_a_run(
    db: ApiSettings,
    strategy_a_result: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
) -> PersistedRunRecord:
    document, result = strategy_a_result
    return _seed(db.db_path, document, result, market)


@pytest.fixture
def dual_run(
    db: ApiSettings,
    dual_result: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
) -> PersistedRunRecord:
    document, result = dual_result
    return _seed_dual(db.db_path, document, result, market)


# --- 1. happy path: non-tautological oracle -------------------------------------------------------


def test_happy_path_targets_equal_persisted_weights(
    client: TestClient, strategy_a_run: PersistedRunRecord
) -> None:
    """Tapping ``cap`` at an evaluated session returns 200 with a portfolio_targets summary whose
    asset_values equal the run's PERSISTED target weights (loaded record, not a recompute)."""
    evaluation = strategy_a_run.evaluations[-1]
    response = client.get(
        f"/v1/runs/{RUN_ID}/values",
        params={"node_id": "cap", "session_date": evaluation.session_date.isoformat()},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["value_summary"]["kind"] == "portfolio_targets"
    assert {av["asset"]: av["value"] for av in body["asset_values"]} == dict(
        evaluation.target_weights
    )
    assert body["provenance"] == {
        "run_id": RUN_ID,
        "dataset_fingerprint": strategy_a_run.input_provenance.dataset_hash,
        "captured": False,
    }
    assert body["node_id"] == "cap"
    assert body["component_path"] == []
    assert body["output_port"] == "targets"


# --- 2. nested component addressing ---------------------------------------------------------------


def test_nested_inner_node_and_exposed_output(
    client: TestClient, dual_run: PersistedRunRecord
) -> None:
    """An inner node resolves by component_path; the instance's exposed multi-output port resolves
    at top level with an explicit output_port."""
    when = dual_run.evaluations[-1].session_date.isoformat()
    inner = client.get(
        f"/v1/runs/{RUN_ID}/values",
        params={"node_id": "ret", "session_date": when, "component_path": "mom"},
    )
    assert inner.status_code == 200, inner.text
    assert inner.json()["value_summary"]["kind"] == "cross_section"
    assert inner.json()["component_path"] == ["mom"]

    exposed = client.get(
        f"/v1/runs/{RUN_ID}/values",
        params={"node_id": "mom", "session_date": when, "output_port": "assets"},
    )
    assert exposed.status_code == 200, exposed.text
    assert exposed.json()["value_summary"]["kind"] == "asset_set"


# --- 3. failure matrix: exact status + stable code ------------------------------------------------


def test_unknown_run_is_404_artifact_not_found(
    client: TestClient, strategy_a_run: PersistedRunRecord
) -> None:
    """An unknown run flows to the GLOBAL persistence handler (not caught in the route)."""
    when = strategy_a_run.evaluations[-1].session_date.isoformat()
    response = client.get(
        f"/v1/runs/{UNKNOWN_RUN_ID}/values",
        params={"node_id": "cap", "session_date": when},
    )
    assert response.status_code == 404
    assert response.json()["code"] == "artifact_not_found"


def test_unknown_node_is_404_value_address_not_found(
    client: TestClient, strategy_a_run: PersistedRunRecord
) -> None:
    when = strategy_a_run.evaluations[-1].session_date.isoformat()
    response = client.get(
        f"/v1/runs/{RUN_ID}/values", params={"node_id": "nope", "session_date": when}
    )
    assert response.status_code == 404
    body = response.json()
    assert body["code"] == "value_address_not_found"
    assert set(body) == _ERROR_KEYS  # no subject/diagnostics leak


def test_no_evaluation_session_is_404_with_recorded_note(
    client: TestClient, strategy_a_run: PersistedRunRecord
) -> None:
    """A session the monthly strategy did not evaluate: 404 no_evaluation_at_session whose message
    quotes the run's recorded note verbatim."""
    note = next(iter(strategy_a_run.notes), None)
    assert note is not None, "strategy_a leaves un-evaluated sessions with recorded notes"
    response = client.get(
        f"/v1/runs/{RUN_ID}/values",
        params={"node_id": "cap", "session_date": note.session_date.isoformat()},
    )
    assert response.status_code == 404
    body = response.json()
    assert body["code"] == "no_evaluation_at_session"
    assert note.message in body["message"]


def test_omitted_port_on_multi_output_instance_is_422_ambiguous(
    client: TestClient, dual_run: PersistedRunRecord
) -> None:
    when = dual_run.evaluations[-1].session_date.isoformat()
    response = client.get(
        f"/v1/runs/{RUN_ID}/values", params={"node_id": "mom", "session_date": when}
    )
    assert response.status_code == 422
    assert response.json()["code"] == "ambiguous_output_port"


def test_deleted_dataset_is_409_dataset_mismatch(
    client: TestClient, strategy_a_run: PersistedRunRecord, db: ApiSettings
) -> None:
    """The run's input dataset row removed out-of-band: the fingerprint no longer resolves."""
    when = strategy_a_run.evaluations[-1].session_date.isoformat()
    with Database(db.db_path) as database, database.transaction() as connection:
        connection.execute("DELETE FROM datasets")
    response = client.get(
        f"/v1/runs/{RUN_ID}/values", params={"node_id": "cap", "session_date": when}
    )
    assert response.status_code == 409
    assert response.json()["code"] == "dataset_mismatch"


def test_unknown_provenance_run_is_409(
    client: TestClient,
    strategy_a_run: PersistedRunRecord,
    db: ApiSettings,
    strategy_a_result: tuple[StrategyDocument, BacktestResult],
) -> None:
    """A run migrated to explicit unknown provenance cannot be verified — swap the stored record
    for one carrying unknown provenance (+ its matching content hash), as the service tests do."""
    document, result = strategy_a_result
    unknown_record = record_from_result(
        result,
        strategy_id=document.strategy.id,
        strategy_version=document.strategy.version,
        input_provenance=unknown_input_provenance(),
    )
    stored = artifact_bytes(unknown_record, kind="run_record", key=RUN_ID)
    with Database(db.db_path) as database, database.transaction() as connection:
        connection.execute(
            "UPDATE runs SET record = ?, content_hash = ? WHERE run_id = ?",
            (stored.decode("utf-8"), content_hash(stored), RUN_ID),
        )
    when = result.evaluations[-1].session_date.isoformat()
    response = client.get(
        f"/v1/runs/{RUN_ID}/values", params={"node_id": "cap", "session_date": when}
    )
    assert response.status_code == 409
    assert response.json()["code"] == "unknown_provenance"


def test_drifted_run_is_409_engine_drift(
    client: TestClient,
    db: ApiSettings,
    strategy_a_result: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
) -> None:
    """A run whose tapped node's recorded trace no longer matches the recompute is refused: mutate
    one trace payload BEFORE save (the stored stream stays internally consistent, yet no faithful
    recompute reproduces it)."""
    document, pristine = strategy_a_result
    result = copy.deepcopy(pristine)  # never mutate the shared module result
    when = result.evaluations[-1].session_date
    tamper_trace(result, "ret", when)
    _seed(db.db_path, document, result, market)
    response = client.get(
        f"/v1/runs/{RUN_ID}/values", params={"node_id": "ret", "session_date": when.isoformat()}
    )
    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "engine_drift"
    assert set(body) == _ERROR_KEYS  # subject not serialized


def test_calendar_only_mismatch_is_409(
    client: TestClient, strategy_a_run: PersistedRunRecord, db: ApiSettings
) -> None:
    """A stored row matching the dataset fingerprint but NOT the calendar fingerprint is not a
    valid recompute input — a distinct 409 from a wholly-absent dataset."""
    when = strategy_a_run.evaluations[-1].session_date.isoformat()
    dataset_hash = strategy_a_run.input_provenance.dataset_hash
    assert dataset_hash is not None  # recorded provenance
    with Database(db.db_path) as database, database.transaction() as connection:
        connection.execute("DELETE FROM datasets")
        connection.execute(
            "INSERT INTO datasets (dataset_id, dataset_fingerprint, calendar_fingerprint, "
            "payload, saved_at) VALUES (?, ?, ?, ?, ?)",
            ("forged-dataset-id", dataset_hash, "0" * 64, "{}", "2026-07-12T00:00:00Z"),
        )
    response = client.get(
        f"/v1/runs/{RUN_ID}/values", params={"node_id": "cap", "session_date": when}
    )
    assert response.status_code == 409
    assert response.json()["code"] == "calendar_mismatch"


def test_unrecomputable_run_is_409_recompute_failed_with_diagnostic(
    client: TestClient,
    db: ApiSettings,
    dual_result: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
) -> None:
    """A componentized run whose pinned definition is no longer stored cannot be recomputed: 409
    recompute_failed, and the message carries the failing diagnostic (design §6: the diagnostics
    are surfaced, not swallowed into a generic sentence)."""
    document, result = dual_result
    _seed(db.db_path, document, result, market)  # deliberately WITHOUT saving the component
    when = result.evaluations[-1].session_date.isoformat()
    response = client.get(
        f"/v1/runs/{RUN_ID}/values", params={"node_id": "cap", "session_date": when}
    )
    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "recompute_failed"
    assert "component_definition_unavailable" in body["message"]  # the diagnostic reaches the wire
    assert set(body) == _ERROR_KEYS


# --- 4. param validation --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "params",
    [
        {"node_id": "cap", "session_date": "2025-08-29", "component_path": "a,b c"},
        {"node_id": "cap", "session_date": "2025-08-29", "component_path": "a,,b"},
        {"node_id": "bad-id!", "session_date": "2025-08-29"},
        {"node_id": "cap", "session_date": "2025-08-29", "output_port": "bad port"},
        # Trailing newline (%0A on the wire): Python re's $ would accept it via .match — the
        # validator must use .fullmatch to be as strict as the IR's Rust-regex _IDENT.
        {"node_id": "cap\n", "session_date": "2025-08-29"},
        {"node_id": "cap", "session_date": "2025-08-29", "component_path": "a\n,b"},
    ],
)
def test_invalid_value_address_is_422(client: TestClient, params: dict[str, str]) -> None:
    # No run fixture: segment validation fires at the handler top, before any DB access.
    response = client.get(f"/v1/runs/{RUN_ID}/values", params=params)
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_value_address"


def test_malformed_session_date_is_422(client: TestClient) -> None:
    """FastAPI's own query-parameter validation rejects a non-date — assert only the status.
    No run fixture: date parsing fires before the handler body, before any DB access."""
    response = client.get(
        f"/v1/runs/{RUN_ID}/values", params={"node_id": "cap", "session_date": "not-a-date"}
    )
    assert response.status_code == 422


# --- 5. contract + 6. determinism -----------------------------------------------------------------


def test_body_validates_against_committed_schema(
    client: TestClient,
    strategy_a_run: PersistedRunRecord,
    def_validator: Any,
) -> None:
    when = strategy_a_run.evaluations[-1].session_date.isoformat()
    payload = client.get(
        f"/v1/runs/{RUN_ID}/values", params={"node_id": "cap", "session_date": when}
    ).json()
    errors = sorted(def_validator("NodeValueResponse").iter_errors(payload), key=str)
    assert not errors, "; ".join(e.message for e in errors[:5])


def test_identical_gets_are_byte_identical(
    client: TestClient, strategy_a_run: PersistedRunRecord
) -> None:
    when = strategy_a_run.evaluations[-1].session_date.isoformat()
    first = client.get(f"/v1/runs/{RUN_ID}/values", params={"node_id": "ret", "session_date": when})
    second = client.get(
        f"/v1/runs/{RUN_ID}/values", params={"node_id": "ret", "session_date": when}
    )
    assert first.content == second.content
