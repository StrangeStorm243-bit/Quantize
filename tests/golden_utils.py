"""Canonical golden serialization for engine run records (M4 plan, golden format).

Byte-deterministic: ``json.dumps(..., sort_keys=True, indent=2, ensure_ascii=False)`` plus one
trailing LF; floats embed as JSON numbers via Python's shortest-round-trip ``repr``; dates and
datetimes are ISO-8601 strings. The golden is a run SUMMARY — it complements, never replaces,
focused hand-computed assertions.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from quantize.engine.records import BacktestResult

GOLDEN_FORMAT = 1
_GOLDENS = Path(__file__).parent / "goldens"


def backtest_summary(result: BacktestResult) -> dict[str, Any]:
    """The stable, reviewable summary of one run (trace and explanation rows excluded)."""
    return {
        "golden_format": GOLDEN_FORMAT,
        "ok": result.ok,
        "run_id": result.run_id,
        "exchange": result.exchange,
        "timezone": result.timezone,
        "first_session": result.first_session.isoformat() if result.first_session else None,
        "last_session": result.last_session.isoformat() if result.last_session else None,
        "total_return": result.total_return,
        "max_drawdown": result.max_drawdown,
        "final_state": {
            "cash": result.final_state.cash,
            "positions": [[asset, qty] for asset, qty in result.final_state.positions],
        },
        "valuations": [[day.isoformat(), value] for day, value in result.valuations],
        "evaluations": [
            {
                "session": record.session_date.isoformat(),
                "evaluation_instant": record.evaluation_instant.isoformat(),
                "targets": [[asset, weight] for asset, weight in record.target_weights],
                "portfolio_value": record.reconciliation.portfolio_value,
                "projected_cash": record.reconciliation.projected_cash,
                "orders": [
                    [order.side, order.asset, order.quantity]
                    for order in record.reconciliation.orders
                ],
                "fill_session": record.fill_session.isoformat() if record.fill_session else None,
            }
            for record in result.evaluations
        ],
        "fills": [
            [
                event.session_date.isoformat(),
                event.actual_fill_instant.isoformat(),
                event.fill.side,
                event.fill.asset,
                event.fill.quantity,
                event.fill.price,
                event.fill.cost,
                event.fill.cash_delta,
                event.fill.scaled,
            ]
            for event in result.fills
        ],
        "stale_marks": [
            [mark.session_date.isoformat(), mark.asset, mark.mark_date.isoformat()]
            for mark in result.stale_marks
        ],
        "notes": [
            [note.session_date.isoformat(), note.code, note.message] for note in result.notes
        ],
    }


def golden_bytes(summary: dict[str, Any]) -> bytes:
    # allow_nan=False: a NaN/Infinity anywhere in a run record must fail loud here, never
    # serialize as a non-RFC token.
    dumped = json.dumps(summary, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False)
    return (dumped + "\n").encode("utf-8")


def assert_matches_golden(name: str, result: BacktestResult, update: bool) -> None:
    """Compare (or, with ``--update-goldens``, rewrite) the committed golden byte-for-byte."""
    path = _GOLDENS / f"{name}.json"
    actual = golden_bytes(backtest_summary(result))
    if update:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(actual)
    committed = path.read_bytes()
    assert committed == actual, (
        f"golden {name} differs from the current run; regenerate deliberately with "
        f"`pytest --update-goldens` and review/explain the diff"
    )
