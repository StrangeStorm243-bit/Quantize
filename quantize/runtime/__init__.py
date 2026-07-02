"""Runtime execution contracts (M3): typed runtime values and executable node bindings.

Static node *descriptors* (M2, ``quantize.registry``) describe a node type to validators and the
future editor; the executable *binding* here is the runtime counterpart that the evaluator invokes.
Keeping them separate preserves future implementation forms (formulas, sandboxed code, models,
external services) behind the same binding seam.
"""
