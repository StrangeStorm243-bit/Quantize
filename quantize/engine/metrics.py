"""Pure result metrics: per-session returns, total return, max drawdown (MVP_PLAN §M4).

Degenerate-portfolio rule (documented, deterministic): a return over a ZERO base value is 0.0 —
a worthless portfolio has no meaningful growth rate, and a silent NaN would poison downstream
consumers. A real valuation cannot reach exactly 0.0 (positive prices, non-negative cash), so
this is defensive hardening, not a live path.
"""

from __future__ import annotations

from collections.abc import Sequence


def simple_returns(values: Sequence[float]) -> tuple[float, ...]:
    """``v_t / v_{t-1} - 1`` per consecutive pair (empty for fewer than two values)."""
    return tuple(
        (later / earlier - 1.0) if earlier != 0.0 else 0.0
        for earlier, later in zip(values, values[1:], strict=False)
    )


def total_return(values: Sequence[float]) -> float:
    """``v_last / v_first - 1``; 0.0 for fewer than two values or a zero base."""
    if len(values) < 2 or values[0] == 0.0:
        return 0.0
    return values[-1] / values[0] - 1.0


def max_drawdown(values: Sequence[float]) -> float:
    """``min_t (v_t / max_{s<=t} v_s - 1)`` — 0.0 for a non-decreasing (or empty) series."""
    worst = 0.0
    peak = float("-inf")
    for value in values:
        peak = max(peak, value)
        if peak != 0.0:
            worst = min(worst, value / peak - 1.0)
    return worst
