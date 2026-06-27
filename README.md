# Quantize

A visual operating system for quantitative trading. A strategy is a versioned, serializable **JSON
IR document** (the source of truth) that one engine evaluates for backtesting and forward/paper
replay using the same node implementations and semantics.

Start with the docs: [`docs/PRODUCT.md`](docs/PRODUCT.md),
[`docs/STRATEGY_LANGUAGE.md`](docs/STRATEGY_LANGUAGE.md),
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/MVP_PLAN.md`](docs/MVP_PLAN.md),
[`docs/ADRS/`](docs/ADRS), and the active plan
[`docs/plans/M1_IMPLEMENTATION_PLAN.md`](docs/plans/M1_IMPLEMENTATION_PLAN.md).

## Status

**M1.0** — repository scaffolding + toolchain. IR models, structural validation, and code generation
follow in M1.1–M1.3.

## Repository commands

See the "Repository commands" section of [`CLAUDE.md`](CLAUDE.md). In brief (run from the repo root,
after `python -m venv .venv` and activating it):

- Install: `python -m pip install -e ".[dev]"`
- Tests: `pytest`
- Lint: `ruff check .`
- Format check: `ruff format --check .`
- Type-check: `mypy`

Node 24 LTS is the project baseline (`.nvmrc`); the Node toolchain is used from M1.3.

`requirements.lock.txt` records the exact package versions used by the canonical development
environment (Python 3.14). CI installs those pinned versions to reduce dependency drift.
Artifact-level and cross-platform reproducibility are not guaranteed yet because hash pinning and
platform-aware locking are deferred.
