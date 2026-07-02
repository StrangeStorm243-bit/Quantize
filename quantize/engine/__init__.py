"""The session-level execution engine (M4).

Wraps the M3 single-instant evaluator with the market-session lifecycle (ARCHITECTURE.md §3):
schedule firing, ADR-0005 order reconciliation, deterministic v0 fills at the next valid
session's open, per-session valuation, and an immutable run record. Order reconciliation and
``OrderList`` are engine-owned — they never enter the strategy graph.
"""
