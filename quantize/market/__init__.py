"""Market data (M3-PRE): exchange calendar, deterministic dataset, and the as-of ``DataView``.

Runtime infrastructure, not persisted IR. The ``DataView`` is the structural temporal boundary:
an evaluation sees only observations whose availability timestamp is <= the evaluation instant.
"""
