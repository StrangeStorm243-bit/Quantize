"""M14.1a' — envelope-level fresh-vs-persisted trace cross-check.

After the recompute succeeds, the tap compares the tapped node's FRESH trace events against the
run's PERSISTED events at the same (evaluation_instant, component_path, node_id). Divergence means
the current node code no longer reproduces what the run recorded, so the tap refuses with
``engine_drift`` rather than serve a number the bot never acted on.

Drift is simulated HONESTLY: one event's payload is mutated in ``result.trace`` BEFORE ``save_run``
(trace payloads are plain mutable dicts; ``save_run`` hashes whatever it is given), so the stored
stream is internally consistent — ``load_trace`` verifies against the run row's hash and passes —
yet differs from any faithful recompute, exactly as real code drift produces. All fixture data; no
network. The shared module result is NEVER mutated: drift cases ``deepcopy`` it first.
"""

from __future__ import annotations

import copy
from datetime import date

import pytest

from quantize.engine.backtest import run_backtest
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository
from quantize.persistence.provenance import recorded_input_provenance
from quantize.persistence.records import PersistedRunRecord
from quantize.persistence.runs import RunRepository
from quantize.runtime.values import PortfolioTargetsValue
from quantize.schema.document import StrategyDocument
from quantize.valuetap import ENGINE_DRIFT, ValueTapError, resolve_node_value
from tests.helpers import load_fixture

RUN_ID = "99999999-9999-9999-9999-999999999999"
CASH = 1_000_000.0


def _document(name: str) -> StrategyDocument:
    return StrategyDocument.model_validate(load_fixture(name))


def _run(
    document: StrategyDocument, market: MarketDataSet, *, collect_trace: bool = True
) -> BacktestResult:
    return run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=CASH),
        collect_trace=collect_trace,
    )


@pytest.fixture(scope="module")
def strategy_a_result(market: MarketDataSet) -> tuple[StrategyDocument, BacktestResult]:
    """The pure backtest for strategy_a — computed ONCE per module. NEVER mutated in place; drift
    cases ``deepcopy`` it before tampering a trace payload."""
    document = _document("strategy_a")
    return document, _run(document, market)


def _persist(
    db: Database, document: StrategyDocument, result: BacktestResult, market: MarketDataSet
) -> PersistedRunRecord:
    """Persist a (possibly pre-tampered) backtest + its dataset into a fresh db; return the row."""
    DatasetRepository(db).save(market)
    runs = RunRepository(db)
    runs.save_run(document, result, input_provenance=recorded_input_provenance(market))
    return runs.load_run(RUN_ID)


@pytest.fixture
def strategy_a_run(
    db: Database,
    strategy_a_result: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
) -> PersistedRunRecord:
    document, result = strategy_a_result
    return _persist(db, document, result, market)


def _tamper_trace(result: BacktestResult, node_id: str, when: date) -> None:
    """Corrupt ``node_id``'s recorded trace at session ``when``, in place, to a value no faithful
    recompute can produce: append a sentinel to the first list-valued field of the node's first
    event's payload (for ``ret`` this is exactly its ``computed`` asset list). Envelope-level drift
    is detected regardless of which field or event type carries it. Asserts a target was found."""
    for event in result.trace:
        if (
            event.node_id == node_id
            and tuple(event.component_path) == ()
            and event.timestamp.date() == when
        ):
            for key, current in event.payload.items():
                if isinstance(current, list):
                    event.payload[key] = [*current, "__DRIFTED__"]  # frozen model, mutable dict
                    return
            raise AssertionError(f"{node_id}'s event at {when} has no list payload field to tamper")
    raise AssertionError(f"no trace event for {node_id} at {when} to tamper")


# --- 2. drifted run refuses (written FIRST; RED = serves instead of refusing) ---------------------


def test_drifted_node_trace_is_refused_with_engine_drift(
    db: Database,
    strategy_a_result: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
) -> None:
    """A persisted run whose tapped node's recorded trace no longer matches the recompute is refused
    with ``engine_drift`` — the bot must never be served a number the run never recorded."""
    document, pristine = strategy_a_result
    result = copy.deepcopy(pristine)  # never mutate the shared module result
    when = result.evaluations[-1].session_date
    _tamper_trace(result, "ret", when)
    _persist(db, document, result, market)

    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="ret", session_date=when)
    assert excinfo.value.code == ENGINE_DRIFT
    assert excinfo.value.subject == "ret"


# --- 1. clean run: the cross-check passes and the success path is not mangled --------------------


def test_clean_run_serves_and_value_matches_persisted_weights(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    """With a faithful trace, the cross-check passes and the served value is unchanged: tapping the
    last graph node still reproduces EXACTLY the run's persisted target weights."""
    evaluation = strategy_a_run.evaluations[-1]
    resolved = resolve_node_value(
        db, run_id=RUN_ID, node_id="cap", session_date=evaluation.session_date
    )
    assert isinstance(resolved.value, PortfolioTargetsValue)
    assert dict(resolved.value.weights) == dict(evaluation.target_weights)
    # And a traced node passes through the cross-check comparison (not merely the empty-skip path).
    served = resolve_node_value(
        db, run_id=RUN_ID, node_id="ret", session_date=evaluation.session_date
    )
    assert served.fresh_trace  # ret records events, so the ordered comparison actually ran


# --- 3. trace-less run: cross-check skipped, value still serves ----------------------------------


def test_run_without_persisted_trace_serves(
    db: Database,
    strategy_a_result: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
) -> None:
    """A run persisted with no trace events (``collect_trace=False``) has nothing to cross-check
    against; the tap must stay usable (skip silently), not become permanently un-tappable."""
    document, _ = strategy_a_result
    result = _run(document, market, collect_trace=False)
    assert not result.trace  # the persisted run records no events for any node
    record = _persist(db, document, result, market)
    when = record.evaluations[-1].session_date
    resolved = resolve_node_value(db, run_id=RUN_ID, node_id="cap", session_date=when)
    assert isinstance(resolved.value, PortfolioTargetsValue)


# --- 4. scope isolation: drift on one node does not condemn a sibling ----------------------------


def test_drift_is_scoped_to_the_tapped_node(
    db: Database,
    strategy_a_result: tuple[StrategyDocument, BacktestResult],
    market: MarketDataSet,
) -> None:
    """Tampering ``rk``'s recorded trace condemns ``rk`` but not ``ret``: the persisted filter keys
    on (node_id, component_path), so a sibling's drift is neither hidden nor spuriously blamed."""
    document, pristine = strategy_a_result
    result = copy.deepcopy(pristine)
    when = result.evaluations[-1].session_date
    _tamper_trace(result, "rk", when)
    _persist(db, document, result, market)

    served = resolve_node_value(db, run_id=RUN_ID, node_id="ret", session_date=when)
    assert served.fresh_trace  # ret's faithful trace still serves
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="rk", session_date=when)
    assert excinfo.value.code == ENGINE_DRIFT


# --- 5. engine.* events never participate in the node-scoped cross-check --------------------------


def test_engine_events_do_not_participate(db: Database, strategy_a_run: PersistedRunRecord) -> None:
    """On a session whose persisted stream also carries engine-origin (``node_id == "engine"``)
    events, tapping a graph node still serves: both sides filter to the node, so engine events are
    excluded by construction and cannot trip the cross-check."""
    runs = RunRepository(db)
    when = next(
        (
            evaluation.session_date
            for evaluation in strategy_a_run.evaluations
            if any(e.node_id == "engine" for e in runs.load_trace(RUN_ID, evaluation.session_date))
        ),
        None,
    )
    assert when is not None  # honest: the chosen session really does carry engine.* events
    stream = runs.load_trace(RUN_ID, when)
    assert any(e.node_id == "engine" for e in stream)
    resolved = resolve_node_value(db, run_id=RUN_ID, node_id="cap", session_date=when)
    assert isinstance(resolved.value, PortfolioTargetsValue)
