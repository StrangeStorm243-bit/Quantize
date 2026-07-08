"""The v0 transformation nodes: trailing return, moving average, latest, rank.

Missing-data behavior (node-specific exclusion, STRATEGY_LANGUAGE.md §2): these nodes exclude an
asset from their output *values* when the required observations are unavailable — the asset stays
in the output *domain*, a trace event explains the exclusion, and nothing is forward-filled or
fabricated. All session arithmetic is calendar-anchored: "the latest session" is the most recent
close-visible session of the run's calendar (``view.session_dates``), never an asset's own stale
last observation — reusing an older price where the current session's close is missing would be a
silent forward-fill.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date

from quantize.nodes._params import get_bool, require_int
from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeDoc,
    NodeMetadata,
    OutputPortSpec,
    ParamDoc,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import CrossSectionValue, RuntimeValue, TimeSeriesValue
from quantize.schema.primitives import JsonValue
from quantize.schema.types import CrossSectionType, TimeSeriesType
from quantize.tracing.spec import (
    ASSET_LIST,
    NUMBER,
    STRING,
    TraceEventSpec,
    combined_trace_schema,
    pair_list,
)

_TS_NUM = TimeSeriesType(kind="TimeSeries", dtype="Number")
_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")

_EMPTY_PARAMS = JsonSchemaSpec({"type": "object", "additionalProperties": False})

_EXCLUDED_SPEC = TraceEventSpec.of(
    "transform.excluded", 1, {"asset": STRING, "reason": STRING}, ("asset", "reason")
)
_COMPUTED_SPEC = TraceEventSpec.of("transform.computed", 1, {"computed": ASSET_LIST}, ("computed",))
# Outputs-produced + node-specific exclusion: one shared pair for the three series transforms.
_TRANSFORM_TRACE_EVENTS = (_COMPUTED_SPEC, _EXCLUDED_SPEC)

_RANK_TRACE_EVENTS = (
    TraceEventSpec.of(
        "rank.assigned",
        1,
        {"descending": {"type": "boolean"}, "ranking": pair_list(NUMBER)},
        ("descending", "ranking"),
    ),
    TraceEventSpec.of(
        "rank.tie_broken", 1, {"assets": ASSET_LIST, "score": NUMBER}, ("assets", "score")
    ),
)


def _series_input(invocation: NodeInvocation) -> TimeSeriesValue:
    series = invocation.inputs["series"]
    assert isinstance(series, TimeSeriesValue)
    return series


# --- transform.trailing_return -----------------------------------------------------------------


def _trailing_return_evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    """``close(D) / close(D - L) - 1`` where D is the latest visible session and D-L is exactly
    L calendar sessions earlier. An asset missing either observation is excluded (traced)."""
    lookback = require_int(invocation.params, "lookback_sessions")
    series = _series_input(invocation)
    sessions = invocation.view.session_dates
    values: dict[str, float] = {}

    def exclude(asset: str, reason: str) -> None:
        invocation.trace("transform.excluded", {"v": 1, "asset": asset, "reason": reason})

    if len(sessions) <= lookback:
        for asset in series.assets:
            exclude(asset, "insufficient_sessions")
    else:
        current, anchor = sessions[-1], sessions[-1 - lookback]
        for asset in series.assets:
            history = dict(series.history(asset))
            current_close = history.get(current)
            anchor_close = history.get(anchor)
            if current_close is None:
                exclude(asset, "missing_current_close")
            elif anchor_close is None:
                exclude(asset, "missing_anchor_close")
            elif anchor_close == 0.0:
                exclude(asset, "zero_denominator")
            else:
                values[asset] = current_close / anchor_close - 1.0
    computed: list[JsonValue] = [asset for asset in sorted(values)]
    invocation.trace("transform.computed", {"v": 1, "computed": computed})
    return {"values": CrossSectionValue.numbers(series.assets, values)}


TRAILING_RETURN = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="transform.trailing_return",
        type_version="1.0.0",
        inputs=(InputPortSpec(name="series", port_type=_TS_NUM),),
        outputs=(OutputPortSpec(name="values", port_type=_CS_NUM),),
        metadata=NodeMetadata(
            display_name="Trailing Return",
            description=(
                "Return over the trailing lookback_sessions calendar sessions: "
                "close(D)/close(D-L) - 1. Assets missing either close are excluded."
            ),
            category="transform",
            doc=NodeDoc(
                summary=(
                    "Measures each asset's momentum as its return over the trailing lookback "
                    "window — the raw signal this strategy ranks on."
                ),
                formula="r_D = close(D) / close(D - L) - 1   (L = lookback_sessions)",
                semantics=(
                    "D is the latest visible session; D-L is exactly lookback_sessions calendar "
                    "sessions earlier. An asset missing either close, or with a zero anchor close, "
                    "is excluded (traced) — never forward-filled. Warm-up: lookback_sessions "
                    "prior sessions."
                ),
                parameters={
                    "lookback_sessions": ParamDoc(
                        label="Lookback sessions",
                        help="Calendar sessions back to the anchor close (the momentum window).",
                    ),
                },
            ),
        ),
        parameter_schema=JsonSchemaSpec(
            {
                "type": "object",
                "properties": {"lookback_sessions": {"type": "integer", "minimum": 1}},
                "required": ["lookback_sessions"],
                "additionalProperties": False,
            }
        ),
        trace_schema=combined_trace_schema(_TRANSFORM_TRACE_EVENTS),
        trace_events=_TRANSFORM_TRACE_EVENTS,
    ),
    evaluate=_trailing_return_evaluate,
    warmup=lambda params: require_int(params, "lookback_sessions"),
)


# --- transform.moving_average ------------------------------------------------------------------


def _moving_average_evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    """Simple moving average over the trailing ``window`` calendar sessions ending at each
    session. A session lacking any of its window observations gets no MA point (no fill).

    Memo reuse (speed-only, bit-exact): a point computed at an earlier evaluation instant of
    the same run is immutable — visibility is monotone in the cutoff and the dataset frozen,
    so its window sum would fold the identical closes — and is replayed from the run's
    ``EvaluationMemo`` instead of recomputed. An ABSENT point is re-attempted every evaluation
    (a vendor-lagged close can make it computable later). Behavior with ``memo=None`` is
    identical by construction and pinned by tests/test_evaluation_memo.py.
    """
    window = require_int(invocation.params, "window")
    series = _series_input(invocation)
    sessions = invocation.view.session_dates
    memo = invocation.memo
    output: dict[str, list[tuple[date, float]]] = {}
    for asset in series.assets:
        cached = (
            memo.slot(
                "transform.moving_average", (*invocation.component_path, invocation.node_id), asset
            )
            if memo is not None
            else None
        )
        history = dict(series.history(asset))
        points: list[tuple[date, float]] = []
        for index in range(window - 1, len(sessions)):
            day = sessions[index]
            if cached is not None:
                hit = cached.get(day)
                if hit is not None:
                    points.append((day, hit))
                    continue
            window_dates = sessions[index - window + 1 : index + 1]
            closes = [history.get(d) for d in window_dates]
            if all(close is not None for close in closes):
                total = sum(close for close in closes if close is not None)
                value = total / window
                points.append((day, value))
                if cached is not None:
                    cached[day] = value
        if not points:
            invocation.trace(
                "transform.excluded", {"v": 1, "asset": asset, "reason": "warmup_unmet"}
            )
        output[asset] = points
    computed: list[JsonValue] = [
        asset for asset in sorted(a for a, points in output.items() if points)
    ]
    invocation.trace("transform.computed", {"v": 1, "computed": computed})
    return {"series": TimeSeriesValue.of(output)}


MOVING_AVERAGE = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="transform.moving_average",
        type_version="1.0.0",
        inputs=(InputPortSpec(name="series", port_type=_TS_NUM),),
        outputs=(OutputPortSpec(name="series", port_type=_TS_NUM),),
        metadata=NodeMetadata(
            display_name="Moving Average",
            description=(
                "Simple moving average over the trailing window sessions; sessions missing any "
                "window observation get no point (never forward-filled)."
            ),
            category="transform",
            doc=NodeDoc(
                summary=(
                    "Smooths each asset's price into a trailing moving average — the trend line a "
                    "strategy compares the current price against."
                ),
                formula="MA(D) = mean(close(D - W + 1), …, close(D))   (W = window)",
                semantics=(
                    "Simple average over the trailing window sessions ending at each session. A "
                    "session missing any observation in its window produces no point (never "
                    "forward-filled). Warm-up: window - 1 prior sessions."
                ),
                parameters={
                    "window": ParamDoc(
                        label="Window",
                        help="Trailing sessions averaged into each moving-average point.",
                    ),
                },
            ),
        ),
        parameter_schema=JsonSchemaSpec(
            {
                "type": "object",
                "properties": {"window": {"type": "integer", "minimum": 1}},
                "required": ["window"],
                "additionalProperties": False,
            }
        ),
        trace_schema=combined_trace_schema(_TRANSFORM_TRACE_EVENTS),
        trace_events=_TRANSFORM_TRACE_EVENTS,
    ),
    evaluate=_moving_average_evaluate,
    # Warm-up = sessions required STRICTLY BEFORE the evaluation session (STRATEGY_LANGUAGE §2):
    # an MA of window W has its first full window AT the W-th visible session, so W-1 prior.
    warmup=lambda params: require_int(params, "window") - 1,
)


# --- transform.latest --------------------------------------------------------------------------


def _latest_evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    """The explicit history -> current collapse: each asset's value AT the latest visible
    session. An asset without an observation at that exact session is excluded (no stale
    substitution)."""
    series = _series_input(invocation)
    current = invocation.view.latest_session_date
    values: dict[str, float] = {}
    for asset in series.assets:
        history = series.history(asset)
        if history and current is not None and history[-1][0] == current:
            values[asset] = history[-1][1]
        else:
            invocation.trace(
                "transform.excluded",
                {"v": 1, "asset": asset, "reason": "missing_current_observation"},
            )
    computed: list[JsonValue] = [asset for asset in sorted(values)]
    invocation.trace("transform.computed", {"v": 1, "computed": computed})
    return {"values": CrossSectionValue.numbers(series.assets, values)}


LATEST = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="transform.latest",
        type_version="1.0.0",
        inputs=(InputPortSpec(name="series", port_type=_TS_NUM),),
        outputs=(OutputPortSpec(name="values", port_type=_CS_NUM),),
        metadata=NodeMetadata(
            display_name="Latest Value",
            description=(
                "The value at the latest visible session, per asset; assets without an "
                "observation at that session are excluded."
            ),
            category="transform",
            doc=NodeDoc(
                summary=(
                    "Collapses a per-asset history into a single current value per asset — the "
                    "explicit 'take the latest point' step (e.g. latest price or latest moving "
                    "average) that feeds cross-sectional logic."
                ),
                formula="value(asset) = series(asset) at the latest visible session",
                semantics=(
                    "Takes each asset's value AT the latest visible session only; an asset "
                    "without an observation at that exact session is excluded (no stale "
                    "substitution). Warm-up: 0 — needs only the current session."
                ),
            ),
        ),
        parameter_schema=_EMPTY_PARAMS,
        trace_schema=combined_trace_schema(_TRANSFORM_TRACE_EVENTS),
        trace_events=_TRANSFORM_TRACE_EVENTS,
    ),
    evaluate=_latest_evaluate,
    # Needs only the current visible session: zero PRIOR sessions (STRATEGY_LANGUAGE §2).
    warmup=lambda params: 0,
)


# --- transform.rank ----------------------------------------------------------------------------


def _rank_evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    """Ordinal ranks 1..k over the present values (1 = best). Ratified tie-break: equal scores
    are ordered by ascending canonical ticker; upstream-excluded assets are not ranked."""
    descending = get_bool(invocation.params, "descending", True)
    scores = invocation.inputs["values"]
    assert isinstance(scores, CrossSectionValue)

    items = sorted(scores.values)  # ticker-ascending base order
    ordered = sorted(items, key=lambda item: item[1], reverse=descending)  # stable: ties stay
    values: dict[str, float] = {
        asset: float(position + 1) for position, (asset, _) in enumerate(ordered)
    }

    by_score: dict[float | bool, list[str]] = {}
    for asset, score in ordered:
        by_score.setdefault(score, []).append(asset)
    for score in sorted(by_score, key=lambda s: float(s)):
        group = by_score[score]
        if len(group) > 1:
            payload: dict[str, JsonValue] = {
                "v": 1,
                "assets": list(group),
                "score": float(score),
            }
            invocation.trace("rank.tie_broken", payload)

    ranking: list[JsonValue] = [[asset, rank] for asset, rank in sorted(values.items())]
    invocation.trace("rank.assigned", {"v": 1, "descending": descending, "ranking": ranking})
    return {"values": CrossSectionValue.numbers(scores.domain, values)}


RANK = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="transform.rank",
        type_version="1.0.0",
        inputs=(InputPortSpec(name="values", port_type=_CS_NUM),),
        outputs=(OutputPortSpec(name="values", port_type=_CS_NUM),),
        metadata=NodeMetadata(
            display_name="Rank",
            description=(
                "Ordinal ranks over the present values (1 = best; descending by default); "
                "ties broken by ascending canonical ticker."
            ),
            category="selection",
            doc=NodeDoc(
                summary=(
                    "Orders the universe by a score — assigns ordinal ranks (1 = best) so a "
                    "downstream selection stage can pick the top names. The machine's ranking step."
                ),
                formula="rank(asset) ∈ {1..k}, 1 = best (descending score by default)",
                semantics=(
                    "Ranks only the assets with a present score (excluded assets are not ranked); "
                    "ties are broken by ascending canonical ticker, deterministically."
                ),
                parameters={
                    "descending": ParamDoc(
                        label="Descending",
                        help="When true (default), the highest score gets rank 1.",
                    ),
                },
            ),
        ),
        parameter_schema=JsonSchemaSpec(
            {
                "type": "object",
                "properties": {"descending": {"type": "boolean", "default": True}},
                "additionalProperties": False,
            }
        ),
        trace_schema=combined_trace_schema(_RANK_TRACE_EVENTS),
        trace_events=_RANK_TRACE_EVENTS,
    ),
    evaluate=_rank_evaluate,
)
