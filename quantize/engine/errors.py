"""Stable engine diagnostic codes (M4). Reconciliation codes are ADR-0005 D14's, verbatim."""

from __future__ import annotations

# Reconciliation (ADR-0005 D14)
MISSING_RECONCILIATION_PRICE = "missing_reconciliation_price"
INVALID_RECONCILIATION_PRICE = "invalid_reconciliation_price"
# Reserved D14 codes: in v0 both conditions are unreachable through the public API because
# PortfolioState enforces them at construction (finite, >= 0, long-only). The constants exist so
# the stable names are fixed now for any future ingestion path that accepts raw snapshots.
INVALID_PORTFOLIO_STATE = "invalid_portfolio_state"
UNSUPPORTED_POSITION = "unsupported_position"

# Fill application
MISSING_OPEN_PRICE = "missing_open_price"
INVALID_OPEN_PRICE = "invalid_open_price"
INVALID_ORDER = "invalid_order"
# The IR schema permits any non-negative finite bps; the ENGINE supports bps < 10000 (a cost
# factor >= 1 makes sell proceeds non-positive and would breach the R13 cash floor).
INVALID_TRANSACTION_COSTS = "invalid_transaction_costs"

# Engine orchestration
EVALUATION_FAILED = "evaluation_failed"
RECONCILIATION_FAILED = "reconciliation_failed"
MISSING_VALUATION_PRICE = "missing_valuation_price"

# Structured NOTES (recorded in run artifacts; not failures)
NOTE_NO_NEXT_SESSION = "no_next_session"
NOTE_FILL_OUTSIDE_WINDOW = "fill_outside_window"
NOTE_WARMUP_NOT_SATISFIED = "warmup_not_satisfied"
