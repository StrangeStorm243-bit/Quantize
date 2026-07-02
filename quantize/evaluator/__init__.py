"""The single-instant graph evaluator (M3).

Evaluates a structurally and semantically valid strategy document at one evaluation instant over
an availability-gated ``DataView``, including compositional component evaluation, producing
``PortfolioTargets``. The session-level engine (M4) wraps this; order reconciliation is engine
territory and does not exist here.
"""
