"""Engine-level trace-event contracts (M6).

The engine is not a node, so its specs live here (the explicit second aggregation source beside
descriptor specs). Engine events reuse the M2 envelope with ``node_id="engine"`` and
``component_path=()``; the ``engine.`` event-type namespace is reserved for the engine
(``quantize.tracing.spec``, enforced by ``validate_trace``). Every payload field is read from a
production object (``ReconciliationOutcome``, ``Fill``, ``PortfolioState``, ``SessionNote``) —
tracing never recomputes a decision.
"""

from __future__ import annotations

from quantize.tracing.spec import NUMBER, STRING, TraceEventSpec, pair_list

_SIDE = {"type": "string", "enum": ["buy", "sell"]}
_ORDER_ROW = {
    "type": "array",
    "prefixItems": [_SIDE, {"type": "string", "minLength": 1}, {"type": "number"}],
    "minItems": 3,
    "maxItems": 3,
    "items": False,
}
_OMITTED_ROW = {
    "type": "array",
    "prefixItems": [
        {"type": "string", "minLength": 1},
        {"type": "string", "enum": ["dust", "hold"]},
        {"type": "number"},
    ],
    "minItems": 3,
    "maxItems": 3,
    "items": False,
}
_FILL_ROW = {
    "type": "array",
    "prefixItems": [
        _SIDE,
        {"type": "string", "minLength": 1},
        {"type": "number"},  # quantity
        {"type": "number"},  # price
        {"type": "number"},  # cost
        {"type": "number"},  # cash_delta
        {"type": "boolean"},  # scaled
    ],
    "minItems": 7,
    "maxItems": 7,
    "items": False,
}

ENGINE_TRACE_EVENTS: tuple[TraceEventSpec, ...] = (
    TraceEventSpec.of(
        "engine.orders_proposed",
        1,
        {
            "session": STRING,
            "portfolio_value": NUMBER,
            "target_cash": NUMBER,
            "projected_cash": NUMBER,
            "orders": {"type": "array", "items": _ORDER_ROW},
            # The reasons an order did not fire at the PLANNING layer: dust/hold plan rows.
            "omitted": {"type": "array", "items": _OMITTED_ROW},
        },
        ("session", "portfolio_value", "target_cash", "projected_cash", "orders", "omitted"),
    ),
    TraceEventSpec.of(
        "engine.orders_filled",
        1,
        # scaled=true rows are the reasons an order did not FULLY fire at the fill layer.
        {"session": STRING, "fills": {"type": "array", "items": _FILL_ROW}},
        ("session", "fills"),
    ),
    TraceEventSpec.of(
        "engine.state_transition",
        1,
        {
            "session": STRING,
            "cash_before": NUMBER,
            "cash_after": NUMBER,
            "positions_before": pair_list(NUMBER),
            "positions_after": pair_list(NUMBER),
        },
        ("session", "cash_before", "cash_after", "positions_before", "positions_after"),
    ),
    TraceEventSpec.of(
        "engine.note",
        1,
        {"session": STRING, "code": STRING, "message": STRING},
        ("session", "code", "message"),
    ),
)
