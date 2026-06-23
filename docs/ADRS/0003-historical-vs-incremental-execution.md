# ADR-0003: Historical vs. incremental execution

- **Status:** Accepted (2026-06-23; revised after M0 adversarial audit)
- **Related:** ARCHITECTURE.md §3, STRATEGY_LANGUAGE.md §6

## Context

Historical backtesting and forward/paper simulation should behave the same from the same strategy
definition. The classic alternatives are a fast **vectorized** backtest and an **incremental** loop.
Separate code paths drift at the seams (rebalance timing, fills, rounding) and make look-ahead easy
to introduce. A naive single loop that ticks only on rebalance dates is also wrong: portfolio
valuation, fills, and stateful updates happen on **session** cadence, not only when the strategy
re-evaluates.

## Decision

**One session-level engine over one single-instant graph evaluator; backtest and forward differ only
in adapters.**

- The engine runs a **session-level event lifecycle** (advance session → process due orders at open →
  apply costs/update holdings → mark-to-close at the valuation instant → evaluate the graph *if
  scheduled* using only data available as of the evaluation instant → persist events/state/traces).
  See `ARCHITECTURE.md §3`.
- The **evaluator** computes a single evaluation instant, including compositional component
  evaluation, producing `PortfolioTargets`. The **engine** — not the graph — reconciles
  `current portfolio + PortfolioTargets + policy → OrderList`.
- v0 supports exactly **one execution policy** (`close_signal_next_session_open`): evaluate after
  session D closes; orders fill at the **next valid exchange session's open** ("D+1" = next session,
  not next calendar day), with transaction costs. The policy is represented explicitly so more can be
  added later; no alternatives are implemented.
- For the MVP, **forward/paper is deterministic incremental replay** over local fixture/uploaded data,
  one session at a time — **no** real-time/EOD provider, network scheduling, or brokerage. The same
  forward-driver contract later admits a live data adapter.
- Results and traces record the separately-modeled timestamps (observation, data-availability,
  evaluation, signal, order-creation, scheduled-fill, actual-fill, valuation).
- **Warm-up** is declared per node; the engine emits no signal until warm-up is satisfied.
- **v0 ships no stateful nodes.** The future stateful-node contract requires topologically-ordered,
  **checkpointable** updates so forward replay resumes deterministically, with each stateful node
  **declaring its own update cadence** (e.g. `every_session` or `evaluation_only`) — there is no
  single universal cadence. The M8 state-consistency test uses a **test-only** accumulator node.

### Calibrated claims (no overconfidence)
- **Look-ahead:** temporal access is **structurally constrained and tested** — each evaluation sees
  only data with availability ≤ the evaluation instant. This eliminates a *class* of errors; it does
  **not** make look-ahead categorically impossible (wrong availability timestamps, fixture mistakes,
  or node bugs can still cause it — hence the look-ahead tests).
- **Backtest vs. forward:** the two **share strategy semantics and node implementations**, removing
  *implementation* drift. Outcomes are **not** guaranteed identical: data and execution-environment
  differences remain explicit and are exercised by the M8 consistency test.

### Vectorization is a fenced future optimization
A batch path may later evaluate *pure* nodes over whole-history arrays, admissible **only** with a
test proving identical outputs and timing to the incremental path. It must never become a second
strategy implementation. Until then, incremental is the only path.

## Alternatives considered

- **Vectorized backtest + separate incremental forward loop:** fastest backtests, but two code paths
  to keep equivalent forever — the drift/look-ahead risk we are eliminating. At daily frequency and
  modest universes the speed gain is immaterial. **Rejected** for the MVP; allowed back only as the
  fenced, test-gated optimization above.
- **Single loop ticking only on rebalance dates:** conflates evaluation schedule with session
  progression; valuation/fills/stateful updates between rebalances would be wrong. **Rejected** in
  favor of the session-level lifecycle.
- **Vectorized only:** cannot serve forward/paper honestly. **Rejected.**

## Consequences

- **Positive:** temporal access is structurally constrained and tested; backtest/forward share one
  implementation; the temporal model is explicit and auditable; the engine is fully testable headless.
- **Negative / accepted:** slower than a pure vectorized backtest on long histories — immaterial at
  MVP scale. Performance is recovered later via the fenced optimization, never by forking the
  implementation.
- **Test obligation:** M8 ships the backtest↔forward consistency test.
