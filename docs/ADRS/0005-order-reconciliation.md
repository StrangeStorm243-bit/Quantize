# ADR-0005: Order reconciliation (`PortfolioTargets → OrderList`)

- **Status:** **REQUIRED BEFORE M4 — not yet decided.** This is an explicit design gate, not a
  resolved decision. No reconciliation is designed or implemented in M1–M3.
- **Related:** ARCHITECTURE.md §3, STRATEGY_LANGUAGE.md §6, MVP_PLAN.md (M4)

## Context

The engine — not the strategy graph — turns a target allocation into concrete orders:
`current portfolio + PortfolioTargets + execution policy → OrderList`, filled at the next valid
session open (one v0 policy). The details of *how* targets become orders materially affect results
(costs, cash, fills) and must be decided deliberately, with tests, **before** the engine milestone
(M4). Deciding them earlier (e.g. in M1) would be premature and out of scope.

## Decision

**Deferred.** This ADR is a placeholder that **blocks M4** until the founder and architect resolve the
open questions below and replace this section with the chosen design.

## Open questions that MUST be resolved before M4

1. **Fractional vs. whole shares** — are positions sized in fractional shares, or rounded to whole
   shares (and with what rounding rule)?
2. **Sizing price** — which price converts target weights into share quantities (e.g. the
   valuation/close price of the evaluation session, or the expected next-session open)?
3. **Sell-before-buy ordering** — are sells reconciled and (notionally) settled before buys, to free
   cash for purchases within the same rebalance?
4. **Transaction-cost reserves** — is cash reserved to cover estimated transaction costs so the
   portfolio does not go negative on cash after fills?
5. **Insufficient cash** — behavior when targets imply more buying than available cash (scale down
   proportionally? skip? partial fill?).
6. **No-op rebalances** — threshold below which a tiny drift produces **no** order (to avoid churn
   and cost on negligible deltas).
7. **Weight tolerances** — the tolerance band within which current vs. target weights are treated as
   already matched (interacts with the `1e-9` accounting tolerance and the no-op threshold).

## Consequences

- M1–M3 proceed **without** any reconciliation logic; the IR, validation, nodes, and graph evaluator
  do not depend on these answers.
- M4 (the session engine) is **blocked** until this ADR is completed and accepted.
- The chosen rules will be covered by golden/integration tests (Strategy A in M4, Strategy B in M5).
