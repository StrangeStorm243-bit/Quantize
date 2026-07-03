"""The v0 core node implementations (STRATEGY_LANGUAGE.md §3).

Each module registers its node types as self-contained ``NodeImplementation``s — descriptor
(identity, ports, parameter schema) plus the pure evaluate function and declared warm-up.
``build_core_catalog()`` assembles a fresh catalog per call: there is no module-level mutable
registry, so runs cannot leak state through this package.
"""

from __future__ import annotations

from quantize.nodes import data, logic, output, portfolio, risk, transform, universe
from quantize.runtime.binding import ImplementationCatalog, NodeImplementation


def core_node_implementations() -> tuple[NodeImplementation, ...]:
    """The v0 node implementations (12 core + the graph terminal), in registration order."""
    return (
        universe.FIXED_LIST,
        data.PRICE,
        transform.TRAILING_RETURN,
        transform.MOVING_AVERAGE,
        transform.LATEST,
        transform.RANK,
        logic.GREATER_THAN,
        portfolio.SELECT_TOP_N,
        portfolio.EQUAL_WEIGHT,
        portfolio.FIXED_WEIGHT,
        portfolio.APPLY_MASK,
        risk.MAX_WEIGHT,
        output.TARGET_PORTFOLIO,
    )


def build_core_catalog() -> ImplementationCatalog:
    """A fresh catalog holding the 12 core nodes (plus the graph terminal)."""
    catalog = ImplementationCatalog()
    for implementation in core_node_implementations():
        catalog.register(implementation)
    return catalog
