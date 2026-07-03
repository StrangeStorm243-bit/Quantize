"""Run-record and trace-stream repository (M7.5).

``save_run`` persists the run's historical facts AND its full trace stream in ONE transaction
(a crash yields nothing or everything — never a run without its trace tail), auto-saving the
strategy document idempotently first so provenance always resolves (ADR-0004). Loads gate the
stored ``record_format``/``trace_format`` through the migration registry, re-hash record bytes,
assert trace ``seq`` contiguity (a gapped stream is CORRUPT, not silently shorter), and return
freshly validated frozen objects. Nothing here recomputes an engine fact.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, date, datetime

from pydantic import ValidationError

from quantize.engine.records import BacktestResult
from quantize.persistence.database import Database
from quantize.persistence.documents import StrategyRepository
from quantize.persistence.errors import (
    ARTIFACT_CONFLICT,
    ARTIFACT_NOT_FOUND,
    CORRUPT_ARTIFACT,
    INVALID_ARTIFACT,
    IntegrityViolationError,
    PersistenceError,
)
from quantize.persistence.migrations import ARTIFACT_MIGRATIONS, ArtifactMigrationRegistry
from quantize.persistence.provenance import PROVENANCE_RECORDED, RunInputProvenance
from quantize.persistence.records import (
    RECORD_FORMAT,
    RUN_MODE_BACKTEST,
    TRACE_FORMAT,
    PersistedRunRecord,
    record_from_result,
)
from quantize.persistence.serialize import (
    artifact_bytes,
    content_hash,
    strict_json_loads,
)
from quantize.schema.document import StrategyDocument
from quantize.tracing.events import TraceEvent


def _trace_identity(event_rows: list[bytes]) -> tuple[str, int]:
    """Trace-stream identity: SHA-256 over the seq-ordered stored event bytes + the count.

    Part of run identity — a duplicate run_id save is idempotent only if the RECORD and the
    TRACE both match byte-for-byte (a divergent trace is a conflict, never silently ignored).
    """
    digest = hashlib.sha256()
    for stored in event_rows:
        digest.update(stored)
        digest.update(b"\x00")
    return digest.hexdigest(), len(event_rows)


RECORD_KIND = "run_record"
TRACE_KIND = "trace_event"


@dataclass(frozen=True)
class RunSummary:
    run_id: str
    strategy_id: str
    strategy_version: int
    mode: str
    ok: bool
    first_session: str | None
    last_session: str | None
    total_return: float
    saved_at: str


class RunRepository:
    def __init__(
        self,
        database: Database,
        migrations: ArtifactMigrationRegistry = ARTIFACT_MIGRATIONS,
    ) -> None:
        self._db = database
        self._migrations = migrations
        self._strategies = StrategyRepository(database)

    # --- save -------------------------------------------------------------------------------

    def save_run(
        self,
        document: StrategyDocument,
        result: BacktestResult,
        *,
        input_provenance: RunInputProvenance,
        mode: str = RUN_MODE_BACKTEST,
    ) -> str:
        """Persist strategy (idempotent) + run facts + trace stream. One atomic unit.

        Never mutates *document*, *result*, or any trace event. Duplicate run_id with identical
        record bytes is an idempotent no-op; divergent bytes are a structured conflict.
        *input_provenance* is REQUIRED (compute it with ``recorded_input_provenance`` at this
        save boundary): a new run never persists without honest input identity. UNKNOWN
        provenance is rejected here — it is reserved for the 1->2 LOAD migration of legacy
        rows (Codex pre-M9 review); accepting it on a new save would make a fresh run
        indistinguishable from a migrated pre-provenance one.
        """
        if input_provenance.status != PROVENANCE_RECORDED:
            raise PersistenceError(
                INVALID_ARTIFACT,
                f"run {result.run_id} cannot be saved with {input_provenance.status!r} input "
                "provenance: unknown is reserved for migrated legacy (format-1) rows — a new "
                "save must record real dataset/calendar identity",
                {"run_id": result.run_id, "status": input_provenance.status},
            )
        record = record_from_result(
            result,
            strategy_id=document.strategy.id,
            strategy_version=document.strategy.version,
            input_provenance=input_provenance,
            mode=mode,
        )
        # Fail CLOSED on partial results (Codex M8): a mid-replay ForwardReplay.result() peek
        # claims ok=True with the full window bounds while holding only a prefix of the facts.
        # A successful COMPLETED run always values its declared last session; anything else is
        # not a completed run and must never persist as one. (Pure fact comparison — no
        # calendar logic re-derived here. Failed runs are honest partials: ok=False persists.)
        if record.ok and record.last_session is not None:
            valued_through = record.valuations[-1][0] if record.valuations else None
            if valued_through != record.last_session:
                raise PersistenceError(
                    INVALID_ARTIFACT,
                    f"run {record.run_id} claims ok through "
                    f"{record.last_session.isoformat()} but its facts stop at "
                    f"{valued_through.isoformat() if valued_through else 'nowhere'}; "
                    "a non-exhausted replay peek is not a completed run",
                    {"run_id": record.run_id, "mode": mode},
                )
        stored = artifact_bytes(record, kind="run_record", key=record.run_id)
        digest = content_hash(stored)
        event_rows = [
            artifact_bytes(event, kind="trace_event", key=(record.run_id, seq))
            for seq, event in enumerate(result.trace)
        ]
        trace_hash, trace_count = _trace_identity(event_rows)
        existing = self._db.query(
            "SELECT content_hash, trace_content_hash, trace_count FROM runs WHERE run_id = ?",
            (record.run_id,),
        )
        if existing:
            # Idempotent ONLY if record AND trace are both byte-identical: a divergent trace
            # stream under the same run_id is a conflict, never silently dropped.
            if existing[0] == (digest, trace_hash, trace_count):
                return record.run_id
            raise PersistenceError(
                ARTIFACT_CONFLICT,
                f"run {record.run_id} already exists with different record or trace content; "
                "persisted artifacts are immutable",
                {"run_id": record.run_id},
            )
        # The plan's in-transaction auto-save: the strategy row (if new) joins the SAME
        # transaction as the run + trace — a failed save leaves no strategy, run, or trace rows.
        _, pending_strategy = self._strategies.prepare_save(document)
        saved_at = datetime.now(UTC).isoformat()  # row metadata only, never hashed
        try:
            with self._db.transaction() as connection:
                if pending_strategy is not None:
                    connection.execute(*pending_strategy)
                connection.execute(
                    "INSERT INTO runs (run_id, strategy_id, strategy_version, mode,"
                    " record_format, ok, first_session, last_session, total_return,"
                    " content_hash, trace_content_hash, trace_count, record, saved_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        record.run_id,
                        record.strategy_id,
                        record.strategy_version,
                        record.mode,
                        RECORD_FORMAT,
                        int(record.ok),
                        record.first_session.isoformat() if record.first_session else None,
                        record.last_session.isoformat() if record.last_session else None,
                        record.total_return,
                        digest,
                        trace_hash,
                        trace_count,
                        stored.decode("utf-8"),
                        saved_at,
                    ),
                )
                for seq, event_bytes in enumerate(event_rows):
                    connection.execute(
                        "INSERT INTO trace_events (run_id, seq, trace_format, timestamp,"
                        " event) VALUES (?, ?, ?, ?, ?)",
                        (
                            record.run_id,
                            seq,
                            TRACE_FORMAT,
                            result.trace[seq].timestamp.isoformat(),
                            event_bytes.decode("utf-8"),
                        ),
                    )
        except IntegrityViolationError as error:
            raise PersistenceError(
                ARTIFACT_CONFLICT,
                f"run {record.run_id} was concurrently saved with different content",
                {"run_id": record.run_id},
            ) from error
        return record.run_id

    # --- load -------------------------------------------------------------------------------

    def load_run(self, run_id: str) -> PersistedRunRecord:
        rows = self._db.query(
            "SELECT record, content_hash, record_format FROM runs WHERE run_id = ?", (run_id,)
        )
        if not rows:
            raise PersistenceError(
                ARTIFACT_NOT_FOUND, f"run {run_id} is not stored", {"run_id": run_id}
            )
        raw, recorded_hash, stored_format = rows[0]
        if not isinstance(raw, str):
            raise PersistenceError(
                CORRUPT_ARTIFACT, "stored run record is not text", {"run_id": run_id}
            )
        if content_hash(raw.encode("utf-8")) != recorded_hash:
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                "stored run record bytes do not match their recorded content hash",
                {"run_id": run_id},
            )
        try:
            payload = strict_json_loads(raw)
        except (json.JSONDecodeError, ValueError) as error:
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"stored run record is not portable JSON: {error}",
                {"run_id": run_id},
            ) from error
        if not isinstance(payload, dict):
            raise PersistenceError(
                CORRUPT_ARTIFACT, "stored run record is not a JSON object", {"run_id": run_id}
            )
        if not isinstance(stored_format, int) or isinstance(stored_format, bool):
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"stored run record_format column is not an integer: {stored_format!r}",
                {"run_id": run_id},
            )
        # The payload is the artifact; the row column is dispatch metadata — they must agree.
        if payload.get("record_format") != stored_format:
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"run record row format {stored_format} does not match the payload's "
                f"{payload.get('record_format')!r}",
                {"run_id": run_id},
            )
        migrated = self._migrations.migrate_to_current(
            RECORD_KIND, payload, stored_format, RECORD_FORMAT
        )
        if migrated.get("record_format") != RECORD_FORMAT:
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"migrated run record claims format {migrated.get('record_format')!r}, "
                f"expected {RECORD_FORMAT}",
                {"run_id": run_id},
            )
        try:
            return PersistedRunRecord.model_validate(migrated)
        except ValidationError as error:
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"stored run record failed domain validation: {error.error_count()} error(s)",
                {"run_id": run_id},
            ) from error

    def load_trace(self, run_id: str, session_date: date | None = None) -> tuple[TraceEvent, ...]:
        """The run's trace events in emission order; optionally only *session_date*'s instants.

        (Every instant's ISO date IS its session date — close events stamp day D, open events
        stamp the fill day — so date filtering needs no calendar logic.)
        """
        run_rows = self._db.query(
            "SELECT trace_content_hash, trace_count FROM runs WHERE run_id = ?", (run_id,)
        )
        if not run_rows:
            raise PersistenceError(
                ARTIFACT_NOT_FOUND, f"run {run_id} is not stored", {"run_id": run_id}
            )
        recorded_trace_hash, recorded_count = run_rows[0]
        rows = self._db.query(
            "SELECT seq, trace_format, event FROM trace_events WHERE run_id = ? ORDER BY seq",
            (run_id,),
        )
        # Stream identity FIRST: seq contiguity alone cannot see a deleted TAIL or a
        # byte-tampered (but valid-JSON) event; the recorded hash + count bind the whole stream.
        if len(rows) != recorded_count:
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"trace stream for run {run_id} has {len(rows)} events; "
                f"{recorded_count!r} were recorded",
                {"run_id": run_id, "stored": len(rows), "recorded": recorded_count},
            )
        stream_hash, _ = _trace_identity(
            [str(row[2]).encode("utf-8") for row in rows if isinstance(row[2], str)]
        )
        if stream_hash != recorded_trace_hash:
            raise PersistenceError(
                CORRUPT_ARTIFACT,
                f"trace stream for run {run_id} does not match its recorded content hash",
                {"run_id": run_id},
            )
        events: list[TraceEvent] = []
        for position, (seq, stored_format, raw) in enumerate(rows):
            if seq != position:
                # A gapped stream is CORRUPT — never a silently shorter trace.
                raise PersistenceError(
                    CORRUPT_ARTIFACT,
                    f"trace stream for run {run_id} has a gap at seq {position}",
                    {"run_id": run_id, "expected_seq": position, "found_seq": seq},
                )
            if not isinstance(stored_format, int) or isinstance(stored_format, bool):
                raise PersistenceError(
                    CORRUPT_ARTIFACT,
                    f"stored trace_format column is not an integer: {stored_format!r}",
                    {"run_id": run_id, "seq": seq},
                )
            if not isinstance(raw, str):
                raise PersistenceError(
                    CORRUPT_ARTIFACT, "stored trace event is not text", {"run_id": run_id}
                )
            try:
                payload = strict_json_loads(raw)
            except (json.JSONDecodeError, ValueError) as error:
                raise PersistenceError(
                    CORRUPT_ARTIFACT,
                    f"stored trace event is not portable JSON: {error}",
                    {"run_id": run_id, "seq": seq},
                ) from error
            if not isinstance(payload, dict):
                raise PersistenceError(
                    CORRUPT_ARTIFACT,
                    "stored trace event is not a JSON object",
                    {"run_id": run_id, "seq": seq},
                )
            migrated = self._migrations.migrate_to_current(
                TRACE_KIND, payload, stored_format, TRACE_FORMAT
            )
            try:
                events.append(TraceEvent.model_validate(migrated))
            except ValidationError as error:
                raise PersistenceError(
                    CORRUPT_ARTIFACT,
                    f"stored trace event failed validation: {error.error_count()} error(s)",
                    {"run_id": run_id, "seq": seq},
                ) from error
        if session_date is None:
            return tuple(events)
        return tuple(e for e in events if e.timestamp.date() == session_date)

    def list_runs(self, strategy_id: str | None = None) -> tuple[RunSummary, ...]:
        sql = (
            "SELECT run_id, strategy_id, strategy_version, mode, ok, first_session,"
            " last_session, total_return, saved_at FROM runs"
        )
        parameters: tuple[object, ...] = ()
        if strategy_id is not None:
            sql += " WHERE strategy_id = ?"
            parameters = (strategy_id,)
        sql += " ORDER BY saved_at, run_id"
        rows = self._db.query(sql, parameters)
        return tuple(
            RunSummary(
                run_id=str(r[0]),
                strategy_id=str(r[1]),
                strategy_version=int(r[2]),  # type: ignore[call-overload]
                mode=str(r[3]),
                ok=bool(r[4]),
                first_session=str(r[5]) if r[5] is not None else None,
                last_session=str(r[6]) if r[6] is not None else None,
                total_return=float(r[7]),  # type: ignore[arg-type]
                saved_at=str(r[8]),
            )
            for r in rows
        )
