"""M9 API boundary — a thin, versioned FastAPI JSON layer over the engine/persistence core.

This subpackage owns NOTHING numerical. Every endpoint translates HTTP → a governed DTO (or a
raw IR document) → an existing domain service → a governed result → HTTP. All portfolio, type,
and evaluation logic stays in the domain packages (invariants 5 and 6).
"""
