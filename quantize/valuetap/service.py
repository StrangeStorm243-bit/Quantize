"""Node Value Tap recompute service (M14.1a) — read-only, one evaluator, no persistence write.

``resolve_node_value`` answers "what value did this node's output port produce during this run,
at this session?" by RE-EVALUATING the run's pinned strategy at the run's own recorded evaluation
instant, over the run's own dataset (resolved by content fingerprint), through the single existing
``evaluate_strategy``. It then projects ONE entry out of the resulting output store.

Determinism is the safety premise: v0 ships no stateful nodes, every graph node is pure over an
availability-gated ``DataView``, and the run record pins the strategy version, the exact
evaluation instant, and the dataset/calendar content hashes — so re-supplying data with the same
fingerprints reproduces the run (``quantize/persistence/provenance.py``). This service NEVER
recomputes with a second evaluator, prunes the graph, or writes anything; ``captured`` is always
False (the value was recomputed now, not read from a run-time artifact).

Scope (M14.1a): the recompute + address resolution + typed results only. The API route (M14.1c),
the response DTO/codegen (M14.1b), and the fresh-vs-persisted trace cross-check (M14.1a') are
separate slices; ``ResolvedNodeValue.fresh_trace`` is captured here for that later slice but is
not compared against anything yet.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime

from quantize.components.resolve import ComponentCatalog, find_ref_key
from quantize.evaluator.evaluate import evaluate_strategy
from quantize.market.data import MarketDataSet
from quantize.nodes import build_core_catalog
from quantize.persistence.closure import load_component_catalog
from quantize.persistence.database import Database
from quantize.persistence.datasets import DatasetRepository
from quantize.persistence.documents import StrategyRepository
from quantize.persistence.provenance import (
    CALENDAR_MISMATCH,
    DATASET_MISMATCH,
    PROVENANCE_UNKNOWN,
    UNKNOWN_PROVENANCE,
)
from quantize.persistence.records import PersistedRunRecord
from quantize.persistence.runs import RunRepository
from quantize.runtime.diagnostics import RuntimeDiagnostic
from quantize.runtime.values import RuntimeValue
from quantize.schema.components import ComponentRef
from quantize.schema.document import StrategyDocument
from quantize.schema.nodes import ComponentRefNode, NodeInstance
from quantize.tracing.events import TraceEvent

_LOGGER = logging.getLogger("quantize.valuetap")

# Stable value-tap error codes (reused persistence/provenance codes are imported, never restrung).
NO_EVALUATION_AT_SESSION = "no_evaluation_at_session"
VALUE_ADDRESS_NOT_FOUND = "value_address_not_found"
AMBIGUOUS_OUTPUT_PORT = "ambiguous_output_port"
RECOMPUTE_FAILED = "recompute_failed"


class ValueTapError(Exception):
    """A structured, code-bearing value-tap fault (the route maps codes to HTTP in M14.1c).

    Mirrors ``PersistenceError``'s shape: a stable ``code`` + human ``message``, an optional
    ``subject`` (the offending id/port), and ``diagnostics`` (the recompute's runtime diagnostics
    when the fault is a failed recompute). Only ``code`` + ``message`` are intended for the wire.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        subject: str | None = None,
        diagnostics: Iterable[RuntimeDiagnostic] = (),
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.subject = subject
        self.diagnostics = tuple(diagnostics)


@dataclass(frozen=True)
class ResolvedNodeValue:
    """One resolved node-output value plus its provenance. ``captured`` is always False in M14."""

    run_id: str
    node_id: str
    component_path: tuple[str, ...]
    session_date: date
    evaluation_instant: datetime
    output_port: str
    value: RuntimeValue
    dataset_fingerprint: str
    calendar_fingerprint: str
    captured: bool
    # The tapped node's fresh trace events from THIS recompute — kept for the M14.1a' cross-check;
    # deliberately unused (uncompared) in M14.1a.
    fresh_trace: tuple[TraceEvent, ...] = ()


def resolve_node_value(
    db: Database,
    *,
    run_id: str,
    node_id: str,
    session_date: date,
    component_path: tuple[str, ...] = (),
    output_port: str | None = None,
) -> ResolvedNodeValue:
    """Resolve the value ``(component_path, node_id).output_port`` produced in ``run_id`` at
    ``session_date``, by deterministic recomputation. Raises ``ValueTapError`` (structured) on any
    honest-refusal condition, and propagates ``PersistenceError`` unwrapped for an unknown run.

    ``component_path`` is the ENCLOSING component-instance ids, outermost first (the evaluator's
    ``ValueStore`` and the trace-envelope convention). ``output_port`` may be omitted only for a
    node with exactly one produced output port.
    """
    # ``datetime`` subclasses ``date`` but ``datetime(...) == date(...)`` is always False, so a
    # datetime session would spuriously miss the recorded-evaluation scan — normalize to its date.
    if isinstance(session_date, datetime):
        session_date = session_date.date()
    started = time.perf_counter()
    runs = RunRepository(db)

    # 1. The run's stored facts. An unknown run surfaces PersistenceError(artifact_not_found)
    #    unwrapped, exactly as the trace endpoints rely on.
    record = runs.load_run(run_id)

    # 2. Unknown provenance (legacy format-1 rows migrate to an explicit unknown): the run's inputs
    #    were never fingerprinted, so a recompute cannot be VERIFIED — refuse, never best-effort.
    if record.input_provenance.status == PROVENANCE_UNKNOWN:
        raise ValueTapError(
            UNKNOWN_PROVENANCE,
            "replay cannot be verified — re-run to enable the value tap",
        )
    dataset_hash = record.input_provenance.dataset_hash
    calendar_hash = record.input_provenance.calendar_hash
    assert dataset_hash is not None and calendar_hash is not None  # recorded provenance invariant

    # 3. session_date -> the run's OWN recorded evaluation instant (never a reconstructed one).
    instant = _evaluation_instant(record, session_date)

    # 4. The pinned strategy document + its component closure (loaded from the store, API-free).
    document = StrategyRepository(db).load(record.strategy_id, record.strategy_version)
    components = load_component_catalog(db, document)

    # 5. Structural address check BEFORE recomputing: a definitively-absent node/path id is a
    #    request fault (a fast, recompute-free refusal). A path through a component whose
    #    definition is not stored is left to the recompute (it will fail loud).
    _verify_address(document, components, component_path, node_id)

    # 6. Resolve the run's dataset by content fingerprint (a run stores NO dataset id).
    market_data = _resolve_dataset(db, dataset_hash, calendar_hash)

    # 7. THE recompute: the single existing evaluator, over the FULL document, at the pinned
    #    instant. No pruning, no second path, no memo (one instant), no cache.
    outcome = evaluate_strategy(
        document,
        catalog=build_core_catalog(),
        market_data=market_data,
        run_id=run_id,
        evaluation_instant=instant,
        components=components,
        collect_trace=True,
        memo=None,
    )

    # 8. Project the requested (node_path, port) out of the output store.
    node_path = (*component_path, node_id)
    produced = frozenset(port for (path, port) in outcome.outputs if path == node_path)
    if not produced:
        if not outcome.ok:
            raise ValueTapError(
                RECOMPUTE_FAILED,
                f"recompute did not produce node {_addr(component_path, node_id)}: the strategy "
                "did not evaluate cleanly at this session",
                subject=node_id,
                diagnostics=outcome.diagnostics,
            )
        raise ValueTapError(
            VALUE_ADDRESS_NOT_FOUND,
            f"node {_addr(component_path, node_id)} produces no output values",
            subject=node_id,
        )
    port = _select_output_port(produced, output_port, component_path, node_id)
    value = outcome.outputs[(node_path, port)]

    resolved = ResolvedNodeValue(
        run_id=run_id,
        node_id=node_id,
        component_path=component_path,
        session_date=session_date,
        evaluation_instant=instant,
        output_port=port,
        value=value,
        dataset_fingerprint=dataset_hash,
        calendar_fingerprint=calendar_hash,
        captured=False,
        fresh_trace=tuple(
            event
            for event in outcome.trace
            if event.node_id == node_id and tuple(event.component_path) == component_path
        ),
    )
    _LOGGER.info(
        "value tap run=%s addr=%s port=%s session=%s elapsed_ms=%.1f",
        run_id,
        _addr(component_path, node_id),
        port,
        session_date.isoformat(),
        (time.perf_counter() - started) * 1000.0,
    )
    return resolved


# --- helpers ----------------------------------------------------------------------------------


def _addr(component_path: tuple[str, ...], node_id: str) -> str:
    """A readable address for messages, e.g. ``mom/ret`` or ``ret`` at top level."""
    return "/".join((*component_path, node_id))


def _evaluation_instant(record: PersistedRunRecord, session_date: date) -> datetime:
    """The run's recorded ``evaluation_instant`` for ``session_date`` (at most one per session).

    No evaluation for the date is an honest refusal that quotes the run's recorded note verbatim
    when one exists (warm-up / no-eval), mirroring the trace/inspector honest-empty-state pattern.
    """
    for evaluation in record.evaluations:
        if evaluation.session_date == session_date:
            return evaluation.evaluation_instant
    for note in record.notes:
        if note.session_date == session_date:
            raise ValueTapError(
                NO_EVALUATION_AT_SESSION,
                f"no evaluation at {session_date.isoformat()}: {note.message}",
            )
    raise ValueTapError(
        NO_EVALUATION_AT_SESSION,
        f"the run has no evaluation at session {session_date.isoformat()}",
    )


def _resolve_dataset(db: Database, dataset_hash: str, calendar_hash: str) -> MarketDataSet:
    """Load the run's input dataset by matching its recorded fingerprints against the store.

    A run stores content fingerprints, not a dataset id. Matching is a pure column read
    (``list_datasets`` decodes no payloads); the winning row's payload is loaded only once found.
    Zero dataset-fingerprint matches -> ``DATASET_MISMATCH``; a dataset match with no calendar
    match -> ``CALENDAR_MISMATCH``. Multiple full matches pick ``min(dataset_id)`` deterministically
    — a defensive branch only: identical fingerprint pairs imply an identical full payload, which
    the content-addressed store dedupes by construction, so this is reachable only via out-of-band
    rows.
    """
    repository = DatasetRepository(db)
    summaries = repository.list_datasets()
    by_dataset = [s for s in summaries if s.dataset_fingerprint == dataset_hash]
    if not by_dataset:
        raise ValueTapError(
            DATASET_MISMATCH,
            "the run's input dataset is no longer stored — deterministic recomputation cannot be "
            "guaranteed",
        )
    full = [s for s in by_dataset if s.calendar_fingerprint == calendar_hash]
    if not full:
        raise ValueTapError(
            CALENDAR_MISMATCH,
            "the run's input calendar is no longer stored — deterministic recomputation cannot be "
            "guaranteed",
        )
    chosen = min(full, key=lambda s: s.dataset_id)
    return repository.load(chosen.dataset_id)


def _verify_address(
    document: StrategyDocument,
    components: ComponentCatalog,
    component_path: tuple[str, ...],
    node_id: str,
) -> None:
    """Raise ``VALUE_ADDRESS_NOT_FOUND`` if an id in the address is DEFINITIVELY absent.

    Pure structural walk over the pinned document + loaded definitions (a data lookup, not a
    descriptor re-implementation). Descending requires the enclosing segment to name a component
    instance whose definition is loaded; if a pinned definition is NOT loaded the address is left
    unverifiable (no raise) — the recompute fails loud and the caller returns RECOMPUTE_FAILED.
    """
    nodes: list[NodeInstance] = list(document.nodes)
    refs: list[ComponentRef] = list(document.component_refs)
    for segment in component_path:
        node = _find_node(nodes, segment)
        if node is None or not isinstance(node, ComponentRefNode):
            raise ValueTapError(
                VALUE_ADDRESS_NOT_FOUND,
                f"component path segment {segment!r} is not a component instance in this run",
                subject=segment,
            )
        key = find_ref_key(node, refs)
        definition = components.get(key) if key is not None else None
        if definition is None:
            return  # pinned component absent/undeclared -> let the recompute fail loud
        nodes = list(definition.implementation.graph.nodes)
        refs = list(definition.component_refs)
    if _find_node(nodes, node_id) is None:
        raise ValueTapError(
            VALUE_ADDRESS_NOT_FOUND,
            f"node {_addr(component_path, node_id)} does not exist in this run's strategy",
            subject=node_id,
        )


def _find_node(nodes: Iterable[NodeInstance], node_id: str) -> NodeInstance | None:
    for node in nodes:
        if node.id == node_id:
            return node
    return None


def _select_output_port(
    produced: frozenset[str],
    requested: str | None,
    component_path: tuple[str, ...],
    node_id: str,
) -> str:
    """Choose the output port to serve. ``produced`` is guaranteed non-empty by the caller.

    Explicit port: served if produced, else ``VALUE_ADDRESS_NOT_FOUND``. Omitted port: the sole
    produced port, or ``AMBIGUOUS_OUTPUT_PORT`` when the node has more than one.
    """
    if requested is not None:
        if requested in produced:
            return requested
        raise ValueTapError(
            VALUE_ADDRESS_NOT_FOUND,
            f"node {_addr(component_path, node_id)} has no output port {requested!r}; "
            f"produced {sorted(produced)!r}",
            subject=requested,
        )
    if len(produced) == 1:
        return next(iter(produced))
    raise ValueTapError(
        AMBIGUOUS_OUTPUT_PORT,
        f"node {_addr(component_path, node_id)} produces multiple output ports "
        f"{sorted(produced)!r}; specify output_port",
        subject=node_id,
    )
