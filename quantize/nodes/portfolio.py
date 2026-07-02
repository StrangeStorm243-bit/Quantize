"""The v0 portfolio-construction nodes: select_top_n, equal_weight, fixed_weight, apply_mask.

Cross-cutting rules (STRATEGY_LANGUAGE.md §3): cash is the explicit remainder ``1 - sum(w)``
owned by nobody else; selection may return fewer than requested (missing-data exclusion upstream);
``fixed_weight`` and ``apply_mask`` never renormalize; every exclusion/zeroing emits a trace
event.
"""

from __future__ import annotations

from collections.abc import Mapping

from quantize.nodes._params import require_int
from quantize.registry.descriptor import (
    InputPortSpec,
    NodeDescriptor,
    NodeMetadata,
    OutputPortSpec,
)
from quantize.registry.schema_spec import JsonSchemaSpec
from quantize.runtime.binding import NodeImplementation, NodeInvocation
from quantize.runtime.values import (
    WEIGHT_TOLERANCE,
    AssetSetValue,
    CrossSectionValue,
    PortfolioTargetsValue,
    RuntimeValue,
)
from quantize.schema.primitives import JsonValue
from quantize.schema.types import AssetSetType, CrossSectionType, PortfolioTargetsType
from quantize.tracing.spec import (
    ASSET_LIST,
    NUMBER,
    STRING,
    TraceEventSpec,
    combined_trace_schema,
    pair_list,
)

_AS = AssetSetType(kind="AssetSet")
_PT = PortfolioTargetsType(kind="PortfolioTargets")
_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")
_CS_BOOL = CrossSectionType(kind="CrossSection", dtype="Boolean")

_EMPTY_PARAMS = JsonSchemaSpec({"type": "object", "additionalProperties": False})

_WEIGHTED_SPEC = TraceEventSpec.of(
    "portfolio.weighted", 1, {"weights": pair_list(NUMBER), "cash": NUMBER}, ("weights", "cash")
)
_SELECT_TRACE_EVENTS = (
    TraceEventSpec.of(
        "select.selected",
        1,
        {
            "n": {"type": "integer", "minimum": 1},
            "selected": ASSET_LIST,
            "unselected": ASSET_LIST,
        },
        ("n", "selected", "unselected"),
    ),
    TraceEventSpec.of(
        "select.excluded", 1, {"asset": STRING, "reason": STRING}, ("asset", "reason")
    ),
)
_EQUAL_WEIGHT_TRACE_EVENTS = (
    _WEIGHTED_SPEC,
    TraceEventSpec.of("portfolio.empty_selection", 1, {}, ()),
)
_FIXED_WEIGHT_TRACE_EVENTS = (
    _WEIGHTED_SPEC,
    TraceEventSpec.of("portfolio.empty_universe", 1, {}, ()),
)
_MASK_TRACE_EVENTS = (
    TraceEventSpec.of(
        "portfolio.mask_applied",
        1,
        {"kept": ASSET_LIST, "zeroed": ASSET_LIST},
        ("kept", "zeroed"),
    ),
    TraceEventSpec.of(
        "portfolio.masked_out",
        1,
        {"asset": STRING, "weight_zeroed": NUMBER, "reason": STRING},
        ("asset", "weight_zeroed", "reason"),
    ),
)


def _trace_weighted(invocation: NodeInvocation, targets: PortfolioTargetsValue) -> None:
    """The outputs-produced weights event shared by the weighting nodes."""
    weights: list[JsonValue] = [[asset, weight] for asset, weight in targets.weights]
    invocation.trace(
        "portfolio.weighted", {"v": 1, "weights": weights, "cash": targets.cash_weight}
    )


# --- portfolio.select_top_n --------------------------------------------------------------------


def _select_top_n_evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    """Select the ``n`` best-scored universe assets. Scores are treated as ranks — SMALLEST is
    best (designed to consume ``transform.rank`` output, where 1 = best); score ties resolve by
    ascending canonical ticker. Universe assets without a score are excluded (traced); if fewer
    than ``n`` qualify, all qualifying assets are selected."""
    n = require_int(invocation.params, "n")
    scores = invocation.inputs["scores"]
    universe = invocation.inputs["universe"]
    assert isinstance(scores, CrossSectionValue) and isinstance(universe, AssetSetValue)

    score_values = scores.as_dict()
    candidates: list[tuple[float, str]] = []
    for asset in universe.assets:  # canonical order
        score = score_values.get(asset)
        if score is None:
            invocation.trace("select.excluded", {"v": 1, "asset": asset, "reason": "unscored"})
        else:
            candidates.append((float(score), asset))
    candidates.sort()  # (score asc, ticker asc) — the ratified deterministic order
    selected = [asset for _, asset in candidates[:n]]
    # Ranked-but-below-cutoff is a DIFFERENT fact from unranked (select.excluded above).
    unselected = [asset for _, asset in candidates[n:]]
    selected_out: list[JsonValue] = [asset for asset in sorted(selected)]
    unselected_out: list[JsonValue] = [asset for asset in sorted(unselected)]
    invocation.trace(
        "select.selected",
        {"v": 1, "n": n, "selected": selected_out, "unselected": unselected_out},
    )
    return {"assets": AssetSetValue.of(selected)}


SELECT_TOP_N = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="portfolio.select_top_n",
        type_version="1.0.0",
        inputs=(
            InputPortSpec(name="scores", port_type=_CS_NUM),
            InputPortSpec(name="universe", port_type=_AS),
        ),
        outputs=(OutputPortSpec(name="assets", port_type=_AS),),
        metadata=NodeMetadata(
            display_name="Select Top N",
            description=(
                "The n best-ranked universe assets (smallest score wins; ties by canonical "
                "ticker); unscored assets are excluded, and fewer than n may qualify."
            ),
        ),
        parameter_schema=JsonSchemaSpec(
            {
                "type": "object",
                "properties": {"n": {"type": "integer", "minimum": 1}},
                "required": ["n"],
                "additionalProperties": False,
            }
        ),
        trace_schema=combined_trace_schema(_SELECT_TRACE_EVENTS),
        trace_events=_SELECT_TRACE_EVENTS,
    ),
    evaluate=_select_top_n_evaluate,
)


# --- portfolio.equal_weight --------------------------------------------------------------------


def _equal_weight_evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    """``1 / |selected|`` each — renormalizes across the selected set (Strategy A's weighting).
    An empty selection yields empty targets (all cash), traced."""
    assets = invocation.inputs["assets"]
    assert isinstance(assets, AssetSetValue)
    if not assets.assets:
        invocation.trace("portfolio.empty_selection", {"v": 1})
        invocation.trace("portfolio.weighted", {"v": 1, "weights": [], "cash": 1.0})
        return {"targets": PortfolioTargetsValue.of({})}
    weight = 1.0 / len(assets.assets)
    targets = PortfolioTargetsValue.of({asset: weight for asset in assets.assets})
    _trace_weighted(invocation, targets)
    return {"targets": targets}


EQUAL_WEIGHT = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="portfolio.equal_weight",
        type_version="1.0.0",
        inputs=(InputPortSpec(name="assets", port_type=_AS),),
        outputs=(OutputPortSpec(name="targets", port_type=_PT),),
        metadata=NodeMetadata(
            display_name="Equal Weight",
            description=(
                "1/|selected| per selected asset (renormalized across the selection); an empty "
                "selection is all cash."
            ),
        ),
        parameter_schema=_EMPTY_PARAMS,
        trace_schema=combined_trace_schema(_EQUAL_WEIGHT_TRACE_EVENTS),
        trace_events=_EQUAL_WEIGHT_TRACE_EVENTS,
    ),
    evaluate=_equal_weight_evaluate,
)


# --- portfolio.fixed_weight --------------------------------------------------------------------


def _fixed_weight_evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    """Each universe asset gets its fixed sleeve (``weight_per_asset``, or ``1/|universe|`` for
    "equal"). Never renormalizes. A numeric weight whose total exceeds 1 fails loudly."""
    assets = invocation.inputs["assets"]
    assert isinstance(assets, AssetSetValue)
    raw = invocation.params["weight_per_asset"]
    if not assets.assets:
        invocation.trace("portfolio.empty_universe", {"v": 1})
        invocation.trace("portfolio.weighted", {"v": 1, "weights": [], "cash": 1.0})
        return {"targets": PortfolioTargetsValue.of({})}
    if raw == "equal":
        weight = 1.0 / len(assets.assets)
    else:
        assert isinstance(raw, (int, float)) and not isinstance(raw, bool)
        weight = float(raw)
        if weight * len(assets.assets) > 1.0 + WEIGHT_TOLERANCE:
            raise ValueError(
                f"weight_per_asset={weight} over-allocates across {len(assets.assets)} assets "
                f"(total {weight * len(assets.assets)!r} > 1)"
            )
    targets = PortfolioTargetsValue.of({asset: weight for asset in assets.assets})
    _trace_weighted(invocation, targets)
    return {"targets": targets}


FIXED_WEIGHT = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="portfolio.fixed_weight",
        type_version="1.0.0",
        inputs=(InputPortSpec(name="assets", port_type=_AS),),
        outputs=(OutputPortSpec(name="targets", port_type=_PT),),
        metadata=NodeMetadata(
            display_name="Fixed Weight",
            description=(
                "A fixed sleeve per universe asset (a number, or 'equal' for 1/|universe|); "
                "no renormalization — unallocated weight is cash."
            ),
        ),
        parameter_schema=JsonSchemaSpec(
            {
                "type": "object",
                "properties": {
                    "weight_per_asset": {
                        "oneOf": [
                            {"const": "equal"},
                            {"type": "number", "exclusiveMinimum": 0, "maximum": 1},
                        ]
                    }
                },
                "required": ["weight_per_asset"],
                "additionalProperties": False,
            }
        ),
        trace_schema=combined_trace_schema(_FIXED_WEIGHT_TRACE_EVENTS),
        trace_events=_FIXED_WEIGHT_TRACE_EVENTS,
    ),
    evaluate=_fixed_weight_evaluate,
)


# --- portfolio.apply_mask ----------------------------------------------------------------------


def _apply_mask_evaluate(invocation: NodeInvocation) -> Mapping[str, RuntimeValue]:
    """Zero the weight of any asset whose mask is false OR missing (traced); keep true assets.
    Survivors are NOT renormalized — zeroed weight becomes part of the cash remainder."""
    targets = invocation.inputs["targets"]
    mask = invocation.inputs["mask"]
    assert isinstance(targets, PortfolioTargetsValue) and isinstance(mask, CrossSectionValue)

    mask_values = mask.as_dict()
    weights: dict[str, float] = {}
    kept: list[JsonValue] = []
    zeroed: list[JsonValue] = []
    for asset, weight in targets.weights:  # canonical order
        flag = mask_values.get(asset)
        if flag is True:
            weights[asset] = weight
            kept.append(asset)
        else:
            reason = "mask_false" if flag is False else "mask_missing"
            invocation.trace(
                "portfolio.masked_out",
                {"v": 1, "asset": asset, "weight_zeroed": weight, "reason": reason},
            )
            weights[asset] = 0.0
            zeroed.append(asset)
    invocation.trace("portfolio.mask_applied", {"v": 1, "kept": kept, "zeroed": zeroed})
    return {"targets": PortfolioTargetsValue.of(weights)}


APPLY_MASK = NodeImplementation(
    descriptor=NodeDescriptor(
        type_id="portfolio.apply_mask",
        type_version="1.0.0",
        inputs=(
            InputPortSpec(name="targets", port_type=_PT),
            InputPortSpec(name="mask", port_type=_CS_BOOL),
        ),
        outputs=(OutputPortSpec(name="targets", port_type=_PT),),
        metadata=NodeMetadata(
            display_name="Apply Mask",
            description=(
                "Zeroes weights where the mask is false or missing (traced); survivors keep "
                "their sleeves — no renormalization, zeroed weight becomes cash."
            ),
        ),
        parameter_schema=_EMPTY_PARAMS,
        trace_schema=combined_trace_schema(_MASK_TRACE_EVENTS),
        trace_events=_MASK_TRACE_EVENTS,
    ),
    evaluate=_apply_mask_evaluate,
)
