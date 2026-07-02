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
from quantize.schema.types import AssetSetType, CrossSectionType, PortfolioTargetsType

_AS = AssetSetType(kind="AssetSet")
_PT = PortfolioTargetsType(kind="PortfolioTargets")
_CS_NUM = CrossSectionType(kind="CrossSection", dtype="Number")
_CS_BOOL = CrossSectionType(kind="CrossSection", dtype="Boolean")

_EMPTY_PARAMS = JsonSchemaSpec({"type": "object", "additionalProperties": False})


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
            invocation.trace("select.excluded", {"asset": asset, "reason": "unscored"})
        else:
            candidates.append((float(score), asset))
    candidates.sort()  # (score asc, ticker asc) — the ratified deterministic order
    selected = [asset for _, asset in candidates[:n]]
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
        invocation.trace("portfolio.empty_selection", {})
        return {"targets": PortfolioTargetsValue.of({})}
    weight = 1.0 / len(assets.assets)
    return {"targets": PortfolioTargetsValue.of({asset: weight for asset in assets.assets})}


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
        invocation.trace("portfolio.empty_universe", {})
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
    return {"targets": PortfolioTargetsValue.of({asset: weight for asset in assets.assets})}


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
    for asset, weight in targets.weights:  # canonical order
        flag = mask_values.get(asset)
        if flag is True:
            weights[asset] = weight
        else:
            reason = "mask_false" if flag is False else "mask_missing"
            invocation.trace(
                "portfolio.masked_out",
                {"asset": asset, "weight_zeroed": weight, "reason": reason},
            )
            weights[asset] = 0.0
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
    ),
    evaluate=_apply_mask_evaluate,
)
