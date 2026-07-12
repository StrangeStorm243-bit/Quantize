"""M14.1a — Node Value Tap recompute service.

The service recomputes a run's pinned strategy at the run's OWN recorded evaluation instant and
projects one node-output value out of the result. Oracles here are deliberately non-tautological:
tapped values are asserted against the run's PERSISTED facts (target weights, trace ``computed``
sets) and against hand-computed fixture arithmetic — never against a second recompute. Look-ahead
safety is proven by the tap honouring each session's own instant (GLD's late listing is excluded
early and present late). All fixture data; no network.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping
from datetime import date, datetime

import pytest

from quantize.components.resolve import ComponentCatalog
from quantize.engine.backtest import run_backtest
from quantize.engine.records import BacktestResult
from quantize.engine.state import PortfolioState
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog, core_node_implementations
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository
from quantize.persistence.documents import ComponentRepository
from quantize.persistence.errors import ARTIFACT_NOT_FOUND, PersistenceError
from quantize.persistence.provenance import (
    CALENDAR_MISMATCH,
    DATASET_MISMATCH,
    UNKNOWN_PROVENANCE,
    recorded_input_provenance,
    unknown_input_provenance,
)
from quantize.persistence.records import PersistedRunRecord, record_from_result
from quantize.persistence.runs import RunRepository
from quantize.persistence.serialize import artifact_bytes, content_hash
from quantize.runtime.binding import ImplementationCatalog, NodeInvocation
from quantize.runtime.values import (
    AssetSetValue,
    CrossSectionValue,
    PortfolioTargetsValue,
    RuntimeValue,
)
from quantize.schema.document import StrategyDocument
from quantize.valuetap import (
    AMBIGUOUS_OUTPUT_PORT,
    NO_EVALUATION_AT_SESSION,
    RECOMPUTE_FAILED,
    VALUE_ADDRESS_NOT_FOUND,
    ResolvedNodeValue,
    ValueTapError,
    resolve_node_value,
)
from quantize.valuetap.service import _select_output_port
from tests.helpers import load_fixture
from tests.market_fixture import fixture_close
from tests.valuetap_helpers import dual_component, dual_strategy

RUN_ID = "99999999-9999-9999-9999-999999999999"
UNKNOWN_RUN_ID = "88888888-8888-8888-8888-888888888888"
CASH = 1_000_000.0
LOOKBACK = 126  # strategy_a's trailing-return window (the fixture-arithmetic anchor)


def _document(name: str) -> StrategyDocument:
    return StrategyDocument.model_validate(load_fixture(name))


def _run(
    document: StrategyDocument,
    market: MarketDataSet,
    *,
    components: ComponentCatalog | None = None,
) -> BacktestResult:
    return run_backtest(
        document,
        catalog=build_core_catalog(),
        market_data=market,
        run_id=RUN_ID,
        initial_state=PortfolioState.of(cash=CASH),
        components=components,
    )


@pytest.fixture(scope="module")
def strategy_a_result(market: MarketDataSet) -> tuple[StrategyDocument, BacktestResult]:
    """The pure backtest for strategy_a — computed ONCE per module (depends only on ``market``, not
    the per-test db), then persisted into each fresh db by ``_persist``."""
    document = _document("strategy_a")
    return document, _run(document, market)


@pytest.fixture(scope="module")
def dual_result(market: MarketDataSet) -> tuple[StrategyDocument, BacktestResult]:
    """The pure backtest for the dual-output component pair — computed ONCE per module."""
    document = dual_strategy()
    return document, _run(document, market, components=ComponentCatalog([dual_component()]))


def _persist(
    db: Database,
    document: StrategyDocument,
    result: BacktestResult,
    market: MarketDataSet,
    *,
    save_dataset: bool = True,
) -> PersistedRunRecord:
    """Persist a PRECOMPUTED backtest (and, by default, its dataset) into a fresh db. Returns the
    loaded record."""
    if save_dataset:
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


def _computed_assets(
    db: Database, node_id: str, when: date, component_path: tuple[str, ...] = ()
) -> set[str]:
    """The assets the PERSISTED run recorded as ``transform.computed`` for a node at
    ``component_path`` (empty tuple = top level) — the run's own fact, used as a non-tautological
    oracle for a recompute."""
    for event in RunRepository(db).load_trace(RUN_ID, when):
        if (
            event.node_id == node_id
            and tuple(event.component_path) == component_path
            and event.event_type == "transform.computed"
        ):
            return set(event.payload["computed"])  # type: ignore[arg-type]
    raise AssertionError(f"no transform.computed for {component_path}/{node_id} at {when}")


# --- 1. happy path: non-tautological oracles ------------------------------------------------------


def test_terminal_targets_equal_persisted_target_weights(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    """Tapping the last graph node (``cap``, feeding the terminal) reproduces EXACTLY the run's
    persisted target weights at that session — recompute vs. stored facts, not vs. a recompute."""
    evaluation = strategy_a_run.evaluations[-1]
    resolved = resolve_node_value(
        db, run_id=RUN_ID, node_id="cap", session_date=evaluation.session_date
    )
    assert isinstance(resolved.value, PortfolioTargetsValue)
    assert dict(resolved.value.weights) == dict(evaluation.target_weights)
    assert resolved.output_port == "targets"
    assert resolved.captured is False
    assert resolved.evaluation_instant == evaluation.evaluation_instant
    assert resolved.dataset_fingerprint == strategy_a_run.input_provenance.dataset_hash


def test_trailing_return_matches_hand_computed_fixture_value(
    db: Database, market: MarketDataSet, strategy_a_run: PersistedRunRecord
) -> None:
    """``ret.values['QQQ']`` equals the exact fixture trailing return ``close[i]/close[i-126]-1``,
    with ``i`` the calendar index of the tapped evaluation session — a hand-computed oracle."""
    when = strategy_a_run.evaluations[-1].session_date
    session_dates = list(market.calendar.session_dates)
    index = session_dates.index(when)
    expected = fixture_close("QQQ", index) / fixture_close("QQQ", index - LOOKBACK) - 1.0
    resolved = resolve_node_value(db, run_id=RUN_ID, node_id="ret", session_date=when)
    assert isinstance(resolved.value, CrossSectionValue)
    assert resolved.value.as_dict()["QQQ"] == pytest.approx(expected)
    # And the recomputed present set equals the run's own recorded computed set (not a recompute).
    assert set(resolved.value.present_assets) == _computed_assets(db, "ret", when)


# --- 2. session_date -> persisted evaluation instant ----------------------------------------------


def test_session_without_evaluation_is_refused_with_recorded_note(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    """A monthly strategy leaves most sessions un-evaluated; tapping one is an honest refusal that
    quotes the run's recorded note verbatim when present."""
    note = next(iter(strategy_a_run.notes), None)
    when = note.session_date if note is not None else date(2025, 1, 3)
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="cap", session_date=when)
    assert excinfo.value.code == NO_EVALUATION_AT_SESSION
    if note is not None:
        assert note.message in excinfo.value.message


def test_datetime_session_is_normalized_to_its_date(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    """A ``datetime`` at an evaluated session must RESOLVE: ``datetime`` subclasses ``date`` but
    ``datetime(...) == date(...)`` is always False, so without normalization the recorded-evaluation
    scan would spuriously miss and raise ``NO_EVALUATION_AT_SESSION``."""
    when = strategy_a_run.evaluations[-1].session_date
    resolved = resolve_node_value(
        db, run_id=RUN_ID, node_id="cap", session_date=datetime(when.year, when.month, when.day)
    )
    assert isinstance(resolved.value, PortfolioTargetsValue)
    assert resolved.session_date == when


# --- 3. unknown run: persistence fault propagates unwrapped ---------------------------------------


def test_unknown_run_propagates_artifact_not_found(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    with pytest.raises(PersistenceError) as excinfo:
        resolve_node_value(db, run_id=UNKNOWN_RUN_ID, node_id="cap", session_date=date(2025, 1, 3))
    assert excinfo.value.code == ARTIFACT_NOT_FOUND


# --- 4. address validation: unknown node / path / port -------------------------------------------


def test_unknown_node_is_value_address_not_found(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    when = strategy_a_run.evaluations[-1].session_date
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="nope", session_date=when)
    assert excinfo.value.code == VALUE_ADDRESS_NOT_FOUND
    assert excinfo.value.subject == "nope"


def test_unknown_component_path_segment_is_value_address_not_found(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    """A path segment that is a registered (non-component) node cannot be descended into."""
    when = strategy_a_run.evaluations[-1].session_date
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(
            db, run_id=RUN_ID, node_id="ret", session_date=when, component_path=("cap",)
        )
    assert excinfo.value.code == VALUE_ADDRESS_NOT_FOUND
    assert excinfo.value.subject == "cap"


def test_unknown_output_port_is_value_address_not_found(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    when = strategy_a_run.evaluations[-1].session_date
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="ret", session_date=when, output_port="ghost")
    assert excinfo.value.code == VALUE_ADDRESS_NOT_FOUND
    assert excinfo.value.subject == "ghost"


def test_terminal_node_produces_no_output_values(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    """``output.target_portfolio`` is a real node with zero output ports — a distinct, honest
    address error, not a crash."""
    when = strategy_a_run.evaluations[-1].session_date
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="tp", session_date=when)
    assert excinfo.value.code == VALUE_ADDRESS_NOT_FOUND


# --- 5. ok:false / unrecomputable run -------------------------------------------------------------


def test_missing_component_definition_yields_recompute_failed(
    db: Database, dual_result: tuple[StrategyDocument, BacktestResult], market: MarketDataSet
) -> None:
    """A componentized run whose pinned definition is no longer stored cannot be recomputed: the
    tap fails loud with the recompute's diagnostics, never a bare not-found or a silent serve."""
    document, result = dual_result
    # The run was computed WITH the catalog (so an ok run persists) but the definition is NOT saved
    # to the store, so the recompute's closure walk cannot resolve it (a deleted component).
    record = _persist(db, document, result, market)
    when = record.evaluations[-1].session_date
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="cap", session_date=when)
    assert excinfo.value.code == RECOMPUTE_FAILED
    assert excinfo.value.diagnostics  # carries the runtime diagnostics
    # Design §6: the diagnostics are SURFACED — the first one is folded into the wire message.
    assert "component_definition_unavailable" in excinfo.value.message


def test_ok_false_recompute_serves_completed_upstream_nodes(
    db: Database, strategy_a_run: PersistedRunRecord, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Design §6, the ok:false row's SERVE side: a recompute that fails mid-graph still serves
    the addresses that COMPLETED before the failure; only unproduced addresses surface the
    diagnostics. Constructed by breaking ``transform.rank`` at recompute time (the persisted run
    is healthy — this simulates a broken node implementation DOWNSTREAM of the tapped node; the
    missing-component construction can't reach this row because a preflight failure returns an
    EMPTY store, serving nothing)."""

    def _broken_rank(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
        raise RuntimeError("synthetic mid-graph failure")

    def _broken_catalog() -> ImplementationCatalog:
        catalog = ImplementationCatalog()
        for implementation in core_node_implementations():
            if implementation.type_id == "transform.rank":
                implementation = dataclasses.replace(implementation, evaluate=_broken_rank)
            catalog.register(implementation)
        return catalog

    monkeypatch.setattr("quantize.valuetap.service.build_core_catalog", _broken_catalog)
    when = strategy_a_run.evaluations[-1].session_date

    # Upstream of the failure: ``ret`` completed before ``rk`` raised — it serves normally, and
    # its unchanged trace still passes the drift cross-check.
    served = resolve_node_value(db, run_id=RUN_ID, node_id="ret", session_date=when)
    assert isinstance(served.value, CrossSectionValue)

    # Downstream: ``sel`` never produced — RECOMPUTE_FAILED carrying the diagnostics, never a
    # bare not-found, and the failing node's fault reaches the message.
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="sel", session_date=when)
    assert excinfo.value.code == RECOMPUTE_FAILED
    assert excinfo.value.diagnostics
    assert "synthetic mid-graph failure" in excinfo.value.message


# --- 6. output_port defaulting and ambiguity ------------------------------------------------------


def test_sole_output_port_defaults_when_omitted(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    when = strategy_a_run.evaluations[-1].session_date
    resolved = resolve_node_value(db, run_id=RUN_ID, node_id="ret", session_date=when)
    assert resolved.output_port == "values"


def test_select_output_port_helper() -> None:
    """The pure port-selection branch: one -> use, many -> ambiguous, explicit hit/miss."""
    assert _select_output_port(frozenset({"only"}), None, (), "n") == "only"
    assert _select_output_port(frozenset({"a", "b"}), "b", (), "n") == "b"
    with pytest.raises(ValueTapError) as ambiguous:
        _select_output_port(frozenset({"a", "b"}), None, (), "n")
    assert ambiguous.value.code == AMBIGUOUS_OUTPUT_PORT
    with pytest.raises(ValueTapError) as missing:
        _select_output_port(frozenset({"a"}), "z", (), "n")
    assert missing.value.code == VALUE_ADDRESS_NOT_FOUND


def test_multi_output_component_instance_is_ambiguous_without_port(
    db: Database, dual_result: tuple[StrategyDocument, BacktestResult], market: MarketDataSet
) -> None:
    """A component instance exposing two outputs cannot be tapped with an omitted port — the only
    way a real address reaches >1 produced port (no core node has multiple outputs)."""
    document, result = dual_result
    _persist_dual(db, document, result, market)
    record = RunRepository(db).load_run(RUN_ID)
    when = record.evaluations[-1].session_date
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="mom", session_date=when)
    assert excinfo.value.code == AMBIGUOUS_OUTPUT_PORT


# --- 7. dataset resolution by fingerprint ---------------------------------------------------------


def test_dataset_resolves_by_fingerprint(db: Database, strategy_a_run: PersistedRunRecord) -> None:
    """The run stores no dataset id; the tap resolves its input by matching both fingerprints."""
    when = strategy_a_run.evaluations[-1].session_date
    resolved = resolve_node_value(db, run_id=RUN_ID, node_id="cap", session_date=when)
    assert resolved.dataset_fingerprint == strategy_a_run.input_provenance.dataset_hash
    assert resolved.calendar_fingerprint == strategy_a_run.input_provenance.calendar_hash


def test_absent_dataset_is_refused(
    db: Database, strategy_a_result: tuple[StrategyDocument, BacktestResult], market: MarketDataSet
) -> None:
    document, result = strategy_a_result
    record = _persist(db, document, result, market, save_dataset=False)
    when = record.evaluations[-1].session_date
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="cap", session_date=when)
    assert excinfo.value.code == DATASET_MISMATCH


def test_calendar_only_mismatch_is_refused(
    db: Database, strategy_a_result: tuple[StrategyDocument, BacktestResult], market: MarketDataSet
) -> None:
    """A stored row matching the dataset fingerprint but NOT the calendar fingerprint is not a
    valid input — a distinct refusal from a wholly-absent dataset."""
    document, result = strategy_a_result
    record = _persist(db, document, result, market, save_dataset=False)
    # Forge a row: right dataset fingerprint, wrong calendar fingerprint (payload never loaded).
    dataset_hash = record.input_provenance.dataset_hash
    assert dataset_hash is not None  # recorded provenance
    _insert_dataset_row(db, "forged-dataset-id", dataset_hash, "0" * 64)
    when = record.evaluations[-1].session_date
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="cap", session_date=when)
    assert excinfo.value.code == CALENDAR_MISMATCH


def test_duplicate_content_dataset_rows_still_serve(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    """Two rows with identical fingerprints (only constructible out-of-band) resolve
    deterministically to a loadable row and serve."""
    dataset_hash = strategy_a_run.input_provenance.dataset_hash
    calendar_hash = strategy_a_run.input_provenance.calendar_hash
    assert dataset_hash is not None and calendar_hash is not None  # recorded provenance
    real_id = DatasetRepository(db).list_datasets()[0].dataset_id
    # A second row with the same fingerprints and a lexicographically-greater id, so the
    # deterministic min() still selects the real (loadable) row.
    _insert_dataset_row(db, real_id + "0", dataset_hash, calendar_hash)
    when = strategy_a_run.evaluations[-1].session_date
    resolved = resolve_node_value(db, run_id=RUN_ID, node_id="cap", session_date=when)
    assert isinstance(resolved.value, PortfolioTargetsValue)


# --- 8. unknown provenance (legacy migrated run) --------------------------------------------------


def test_unknown_provenance_run_is_refused(
    db: Database, strategy_a_result: tuple[StrategyDocument, BacktestResult], market: MarketDataSet
) -> None:
    """A run whose provenance is the migrated ``unknown`` (no recorded fingerprints) cannot be
    verified. ``save_run`` rejects unknown provenance for new saves, so the durable row is written
    directly — reproducing the post-1->2-migration state ``load_run`` would return."""
    document, result = strategy_a_result
    DatasetRepository(db).save(market)
    RunRepository(db).save_run(document, result, input_provenance=recorded_input_provenance(market))
    # Swap the stored record for one carrying unknown provenance (+ its matching content hash).
    unknown_record = record_from_result(
        result,
        strategy_id=document.strategy.id,
        strategy_version=document.strategy.version,
        input_provenance=unknown_input_provenance(),
    )
    stored = artifact_bytes(unknown_record, kind="run_record", key=RUN_ID)
    with db.transaction() as connection:
        connection.execute(
            "UPDATE runs SET record = ?, content_hash = ? WHERE run_id = ?",
            (stored.decode("utf-8"), content_hash(stored), RUN_ID),
        )
    when = result.evaluations[-1].session_date
    with pytest.raises(ValueTapError) as excinfo:
        resolve_node_value(db, run_id=RUN_ID, node_id="cap", session_date=when)
    assert excinfo.value.code == UNKNOWN_PROVENANCE


# --- 9. look-ahead safety: each session uses its OWN instant --------------------------------------


def test_lookahead_gld_excluded_early_present_late(
    db: Database, strategy_a_run: PersistedRunRecord
) -> None:
    """GLD lists late (calendar index 60) and needs 126 sessions of history. At an EARLY evaluation
    it lacks warm-up and is excluded; at a LATE one it is present. If the tap used a fixed instant
    instead of each session's own, both taps would agree — so divergence proves instant gating.
    (Also: the excluded asset is absent from values but present in the domain.)"""
    early_session = strategy_a_run.evaluations[0].session_date
    late_session = strategy_a_run.evaluations[-1].session_date
    early = resolve_node_value(db, run_id=RUN_ID, node_id="ret", session_date=early_session)
    late = resolve_node_value(db, run_id=RUN_ID, node_id="ret", session_date=late_session)
    assert isinstance(early.value, CrossSectionValue)
    assert isinstance(late.value, CrossSectionValue)
    assert "GLD" not in early.value.present_assets  # not warmed up at the early instant
    assert "GLD" in early.value.domain  # still in the bound universe
    assert "GLD" in late.value.present_assets  # warmed up at the late instant


# --- 10. nested component addressing --------------------------------------------------------------


def test_nested_inner_node_and_exposed_output(
    db: Database, dual_result: tuple[StrategyDocument, BacktestResult], market: MarketDataSet
) -> None:
    """A node INSIDE a component resolves by component_path, and the component instance's own
    exposed output resolves at top level — both against the run's persisted facts."""
    document, result = dual_result
    _persist_dual(db, document, result, market)
    record = RunRepository(db).load_run(RUN_ID)
    when = record.evaluations[-1].session_date

    inner = resolve_node_value(
        db, run_id=RUN_ID, node_id="ret", session_date=when, component_path=("mom",)
    )
    assert isinstance(inner.value, CrossSectionValue)
    assert set(inner.value.present_assets) == _computed_assets(db, "ret", when, ("mom",))

    exposed = resolve_node_value(
        db, run_id=RUN_ID, node_id="mom", session_date=when, output_port="assets"
    )
    assert isinstance(exposed.value, AssetSetValue)
    # The component's selected assets are exactly the assets carried into the target weights.
    assert set(exposed.value.assets) == set(dict(record.evaluations[-1].target_weights))


# --- 11. determinism ------------------------------------------------------------------------------


def test_two_identical_taps_are_equal(db: Database, strategy_a_run: PersistedRunRecord) -> None:
    when = strategy_a_run.evaluations[-1].session_date
    first = resolve_node_value(db, run_id=RUN_ID, node_id="ret", session_date=when)
    second = resolve_node_value(db, run_id=RUN_ID, node_id="ret", session_date=when)
    assert isinstance(first, ResolvedNodeValue)
    assert first == second


# --- dual-output component seeding (builders shared in tests/valuetap_helpers.py) -----------


def _persist_dual(
    db: Database, document: StrategyDocument, result: BacktestResult, market: MarketDataSet
) -> PersistedRunRecord:
    ComponentRepository(db).save(dual_component())
    return _persist(db, document, result, market)


def _insert_dataset_row(
    db: Database, dataset_id: str, dataset_fingerprint: str, calendar_fingerprint: str
) -> None:
    with db.transaction() as connection:
        connection.execute(
            "INSERT INTO datasets (dataset_id, dataset_fingerprint, calendar_fingerprint, "
            "payload, saved_at) VALUES (?, ?, ?, ?, ?)",
            (dataset_id, dataset_fingerprint, calendar_fingerprint, "{}", "2026-07-12T00:00:00Z"),
        )
