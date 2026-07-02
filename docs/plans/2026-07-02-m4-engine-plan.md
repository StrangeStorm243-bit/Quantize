# M4 — Session-Level Execution Engine + Strategy A End-to-End + Golden (2026-07-02)

Plan-of-record for M4 (per `PLAN_TEMPLATE.md`; no separate design doc). Implements MVP_PLAN §M4
over the accepted ADR-0005 reconciliation contract and the M3 runtime.

## Purpose & definition of done

M4 makes a strategy *runnable through time*: the session-level engine drives the market-session
lifecycle over the deterministic fixture, calls the M3 evaluator only when the schedule fires,
reconciles targets into orders per ADR-0005, fills them at the next valid session's open under
the ratified v0 fill policy, marks the portfolio at every session close, and returns an immutable
run record with value/returns/drawdown.

**Done means:**
- Pure schedule firing (daily/weekly/monthly "last valid session of period") with boundary tests.
- `ExchangeCalendar.next_session_after` and availability-gated `DataView` open-price access.
- Frozen `PortfolioState`, `Order`/`OrderList`, `Fill`, reconciliation outcome, and backtest
  result value objects.
- Pure `reconcile()` implementing ADR-0005 exactly — every R1–R16 invariant and every worked
  example (A–H) is a passing test.
- Deterministic fill application implementing ADR-0005 D11/R13 (sells-before-buys, bps costs at
  fill, cash floor via deterministic buy scaling, immutable state transition).
- Engine orchestration: full-fixture Strategy A backtest, hand-checkable, deterministic across
  repeated runs; Strategy B end-to-end engine test (golden stays M5).
- Committed Strategy A golden with canonical serialization + focused hand-computed assertions.
- Full gate green; no M1–M3 contract changed; no generated artifacts changed.

## Authoritative inputs

MVP_PLAN §M4 (lifecycle, costs, valuation, golden, run record preserves calendar+timezone);
ARCHITECTURE §3 (6-step lifecycle, adapter seam, 8 timestamps); ADR-0003 (one engine over one
evaluator; warm-up: "the engine emits no signal until warm-up is satisfied"); **ADR-0005
(reconciliation contract — implemented verbatim, not reinterpreted)**; STRATEGY_LANGUAGE §6
(schedule semantics, one execution policy); M3 design record (DataView, evaluator, values).

Note on transaction costs: the sprint's generic exclusion list defers "costs", but MVP_PLAN §M4
*explicitly includes* "transaction costs" and ADR-0005 R13 *requires* "bps costs at fill" — the
repository governs, so the simple bps model (from `execution_policy.transaction_costs`) IS in M4
scope. Slippage/spreads/commissions-beyond-bps remain excluded.

## Scope (M4 owns)

1. `quantize/engine/schedule.py` — pure schedule firing over a calendar.
2. `quantize/market/calendar.py` — additive `next_session_after`.
3. `quantize/market/data.py` — additive availability-gated open access on `DataView`.
4. `quantize/engine/state.py` — frozen `PortfolioState`.
5. `quantize/engine/orders.py` — frozen `Order`, `OrderList` alias, `Fill`.
6. `quantize/engine/reconcile.py` — pure ADR-0005 reconciliation (+ explanation rows).
7. `quantize/engine/fills.py` — deterministic fill application (bps costs, cash floor). This
   module IS the Broker(sim) adapter seam: forward replay (M8) reuses it unchanged; a future live
   broker replaces its role behind the same boundary.
8. `quantize/engine/records.py` — frozen result value objects; `quantize/engine/metrics.py` —
   pure value/returns/drawdown functions. (ARCHITECTURE's module map sketches a top-level
   `results/`; consolidating into `engine/records|metrics` is deliberate until M7 persistence
   gives `results/` a real storage role — the six runtime concerns stay in separate modules.)
9. `quantize/engine/backtest.py` — the historical session driver. The Clock seam is explicit: the
   loop consumes a session sequence produced by a pure window function over the calendar, which
   is exactly what the M8 forward driver will feed one session at a time. MarketData adapter =
   `MarketDataSet.as_of` (already the only read path); Storage = the returned in-memory
   `BacktestResult` (durable storage is M7). This satisfies MVP_PLAN §M4's
   "Clock/MarketData/Broker(sim)/Storage adapters" as named seams without speculative abstract
   base classes; ADR-0003's "modes differ only in adapters" is preserved because M8 swaps the
   driver + data source, not the engine internals.
10. `quantize/engine/errors.py` — stable engine diagnostic codes.
10. Strategy A golden (`tests/goldens/strategy_a_backtest.json`) + `--update-goldens` hook.

## Exclusions (deferred, seams preserved)

Live brokerage/routing; pending/open orders (R16); partial-fill lifecycle; slippage/spreads;
commissions beyond the bps model; taxes/tax lots; multi-currency; margin/leverage/shorting;
borrowing; corporate actions; production persistence (M7 — the run record is an in-memory frozen
value object); distributed/async orchestration; frontend; Strategy B golden and cap-redistribution
depth (M5); detailed trace payload construction (M6 — M4 records M3 traces and structured
explanation rows only); forward-replay driver (M8 — the per-session step is written so the M8
driver can reuse it; no abstract adapter classes are introduced prematurely).

## Contracts & invariants

### Schedule firing (pure)
`schedule_fires(schedule, session_date, calendar) -> bool` and
`scheduled_sessions(schedule, calendar) -> tuple[date, ...]`:
- daily → every calendar session; weekly → the last calendar session within each ISO Mon–Sun
  week; monthly → the last calendar session within each calendar month. "Last valid session of
  the period" is defined **relative to the calendar's session set** (STRATEGY_LANGUAGE §6: the
  calendar is the authority on valid sessions; truncated coverage is a fixture-authoring concern).
- Pure function of (schedule, calendar): no wall clock, no state, no duplicate firing, total and
  deterministic. Non-session dates → False.

### `ExchangeCalendar.next_session_after(session_date) -> MarketSession | None`
Strictly after by trading date; skips weekends/holidays by construction (they are simply not
sessions); returns `None` beyond calendar coverage (never silently extends the calendar).

### Open-price access (temporal boundary)
`DataView.open_price(asset, session_date) -> float | None`, populated at `as_of` construction
from observations with `open_available_at <= instant`. A view taken at session F's open exposes
F's opens but not F's closes. No stale/prior-session substitution: the accessor answers only for
the exact (asset, session) requested. Raw `MarketDataSet` access from engine code is forbidden —
everything flows through `as_of` views.

### `PortfolioState` (frozen)
`cash: float` (finite, ≥ 0) + `positions: tuple[(asset, quantity), ...]` (canonical ascending
ticker; quantities finite and > 0 — zero-quantity entries are canonicalized away; bool rejected).
Immutable; transitions produce new instances. Single currency, long-only, unlevered, settled-only
(ADR-0005 D1).

### `Order` / `OrderList` / `Fill` (frozen)
`Order = {side: "buy"|"sell", asset, quantity > 0}` — **no price field** (ADR-0005 R11).
`OrderList = tuple[Order, ...]`, sells (canonical) then buys (canonical); ordering is canonical
presentation (R10) — the fill layer independently applies sells before buys.
`Fill = {side, asset, quantity, price, cost, cash_delta, scaled: bool}` — the executed record;
`scaled=True` marks a cash-floor-scaled buy (with quantity possibly 0 → recorded, position
unchanged). Order identity remains deferred (M7).

### Reconciliation (pure; ADR-0005 verbatim)
`reconcile(state, targets, prices) -> ReconciliationOutcome` implementing D1–D15/R1–R16: pinned
left-to-right canonical PV fold seeded with cash; asset set = held(qty>0) ∪ targeted(w>0) with
zero-weight-unheld dropped at ingestion; session-D close planning prices only; atomic failure on
missing/invalid price (`missing_reconciliation_price`/`invalid_reconciliation_price`/
`invalid_portfolio_state`); dust rule `|Δq|·price > max(PV,1)·1e-9` with full-liquidation
exemption; sells-first canonical output; outcome carries `ok`, orders, diagnostics,
`portfolio_value`, `target_cash`, `projected_cash`, and per-asset explanation rows
`{asset, price, current_quantity, target_weight, target_notional, target_quantity,
delta_quantity, action}`. `ok=False ⇒ orders=()`. Never mutates inputs.

### Fill application (deterministic; ADR-0005 D11/R13)
`apply_orders(state, orders, view_at_open, fill_session, cost_bps) -> (new_state, fills, notes)`:
- Fill price = the fill session's open, read via the availability-gated view taken at that open.
- Sells first (canonical), then buys (canonical). Sell: `cash += qty·price·(1 − bps/1e4)`;
  buy: `cash −= qty·price·(1 + bps/1e4)`.
- Cash floor: a buy exceeding remaining cash is scaled to
  `qty' = cash / (price·(1 + bps/1e4))` (later buys bear the shortfall; `scaled=True`, reason
  recorded; a buy scaled all the way to zero is STILL recorded as a `Fill` with quantity 0 and
  the position unchanged). Float guard: after each cash movement, a residue in
  `[−1e-9·max(cash_after_sells, 1), 0)` is clamped to exactly `0.0` (pure rounding artifact of
  the scaling division — the basis is the cash the buys actually see, which is ≤ PV, i.e. a
  STRICTLY TIGHTER band than the ADR-level `max(PV,1)·1e-9` guard); anything more negative
  raises — settled cash never goes negative (R13) and a rounding ulp never becomes a run-fatal
  `PortfolioState` construction error.
- **Fixture fact the hand calculations must use:** the synthetic fixture defines
  `open_i = close_{i−1}` exactly, so the D+1 fill price EQUALS the D planning price — the only
  planning-vs-fill deviation in the goldens is the 5-bps cost drag. Consequently every
  fully-invested rebalance (Strategy A: Σw ≈ 1) costs `≈ PV·1.0005 > cash`, so the LAST canonical
  buy is slightly scaled on every rebalance — expected D11.3 behavior, visible in the golden.
  The "planning-vs-fill drift" fill test is vacuous on this fixture and must use a small
  synthetic dataset where the open genuinely differs from the prior close.
- Oversell (sell qty > held beyond 1e-9) → structured failure (`invalid_order`) — reconciliation
  guarantees it cannot happen; this is a defensive contract check.
- Missing/invalid open for any ordered asset → **atomic run failure**
  (`missing_open_price`/`invalid_open_price`) — mirrors ADR-0005 D8's fail-loud stance at the
  fill boundary; no partial fill event.
- All-or-nothing per fill event only in the failure sense; successful events apply sequentially
  (sells then buys) to one new immutable state. Planning prices (D close) and fill prices (next
  open) are *different by design* — drift is visible and corrected at the next rebalance.

### Engine orchestration (`run_backtest`)
`run_backtest(document, *, catalog, market_data, run_id, initial_state, components=None,
first_session=None, last_session=None) -> BacktestResult`. `initial_state` is a caller-supplied
`PortfolioState` (no default — capital is an explicit input); the committed goldens use
`cash = 1_000_000.0`, no positions. Per calendar session in the window:
1. **Open:** if orders are queued for this session, take the as-of view at `open_at` and apply
   fills → new state. (Queue is always empty at evaluation instants — R16 holds structurally.)
2. **Close (valuation instant):** mark holdings to the most recent visible close ≤ the close
   instant (documented carry rule — see below); record `(session, portfolio_value)`.
3. **Close (evaluation instant):** if the schedule fires AND the warm-up gate passes AND the
   scheduled fill session exists AND lies inside the run window: run the M3 evaluator at
   `close_at` (defensive pre-flight included), reconcile per ADR-0005 with the same view's
   session-D closes, queue the orders for the next session. If no next session exists in the
   calendar → structured `no_next_session` note, no evaluation/trade. If the next session exists
   but falls OUTSIDE `[first_session, last_session]` → structured `fill_outside_window` note, no
   evaluation/trade (a trailing evaluation must never queue orders the window will silently drop).
   If the M3 evaluation or the reconciliation fails → the run fails loud (structured diagnostics,
   partial artifacts preserved, `ok=False`).
- **Warm-up gate (ADR-0003):** evaluations are skipped (with a note) until the number of visible
  sessions strictly exceeds the strategy's declared warm-up (`resolve_warmup(...).total`) — the
  gate is deliberately **strategy-wide max**, not per-node; node missing-data exclusion remains
  the correctness mechanism — the gate only suppresses meaningless early evaluations.
  Deterministic.
- **Valuation carry rule (documented, not silent):** valuation marks a held asset at its most
  recent *visible* close ≤ the valuation instant. If that close is not the current session's, the
  session record carries a per-asset `stale_marks` entry (asset → mark date). A held asset with
  NO visible close at all fails the run (`missing_valuation_price`). Rationale: valuation is
  reporting, not trading — trading (reconciliation) keeps ADR-0005's strict same-session-close
  atomic rule; the fixture's IWM-missing-session day (2026-05-15, held by Strategy A, not a
  Strategy A firing day) exercises exactly this. The rule is documented AT the valuation function
  (mirroring the node-level convention of CLAUDE.md invariant 10) and the test pair asserts BOTH
  the carried mark AND that a same-session reconciliation on a missing D-close still fails
  atomically (no leak into trading). Fixture invariant the goldens rely on: no held Strategy A/B
  asset misses its session close on any of that strategy's firing days.
- Metrics: per-session value series; simple returns `v_t/v_{t-1} − 1`; total return; max drawdown
  `min_t(v_t / max_{s≤t} v_s − 1)`. All plain float64, deterministic iteration order.

### `BacktestResult` (frozen)
`{ok, run_id, exchange, timezone, first_session, last_session, valuations: tuple[(date, value)],
stale_marks (per session, if any), evaluations: tuple[EvaluationRecord], fills: tuple[(session,
Fill), ...], returns: tuple[float, ...], total_return, max_drawdown, final_state, diagnostics,
trace: tuple[TraceEvent, ...]}` where `EvaluationRecord = {session_date, evaluation_instant,
targets (weights), reconciliation outcome (incl. explanation rows), fill_session_date,
scheduled_fill_instant, notes}`. Timestamps recorded: evaluation/signal instant, order-creation
(= evaluation) instant, scheduled-fill instant, actual-fill instant (= open, v0), valuation
instant. No wall-clock, no machine paths, no raw exception reprs (message text follows the M3
diagnostic convention). `ok=False` results carry diagnostics + partial series and `final_state`
as of the last consistent transition — never a contradictory "success".

### Golden format
`tests/goldens/strategy_a_backtest.json`: canonical JSON — `json.dumps(..., sort_keys=True,
indent=2, ensure_ascii=False)` + one trailing LF, LF line endings (`.gitattributes`), floats via
Python `repr` shortest-round-trip (embedded as JSON numbers), dates ISO-8601 strings, a
`"golden_format": 1` marker; contents = run summary (final state, total return, max drawdown,
per-evaluation targets/orders/fills, full valuation series — acceptable size since every entry is
closed-form). Regenerated only via `pytest --update-goldens` (conftest option); a golden diff
must be explained in the PR. The golden complements — never replaces — hand-computed focused
assertions pinning SPECIFIC named sessions/values (the self-generated series body is not an
independent oracle).

### Diagnostics (engine codes, `quantize/engine/errors.py`)
`no_next_session` (note, not failure), `warmup_not_satisfied` (note), `missing_open_price`,
`invalid_open_price`, `missing_valuation_price`, `invalid_order`, `evaluation_failed` (wraps M3
codes), plus ADR-0005's reconciliation codes re-used as-is. Expected data/user faults are
structured `RuntimeDiagnostic`s; programmer errors raise.

## Unresolved decisions
None — every choice above traces to MVP_PLAN §M4, ARCHITECTURE §3, ADR-0003, ADR-0005, or
STRATEGY_LANGUAGE §6. The two judgment calls made explicit here for review: (a) the valuation
carry rule (documented stale-mark, run-fatal only on never-priced holdings); (b) the calendar-set
definition of "last session of period" for schedule firing. Both are flagged to the plan
reviewers; neither contradicts an accepted contract.

## Implementation slices

- **M4.1 (done in Phase 1):** scripts (`node24.ps1`, `gate.ps1`), CLAUDE.md, PLAN_TEMPLATE,
  STRATEGY_LANGUAGE drift fix.
- **M4.2 Calendar & schedule:** `next_session_after`; `schedule_fires`/`scheduled_sessions` with
  month/year/week/holiday boundary tests against the fixture calendar.
- **M4.3 Open access:** `DataView` opens (gated), boundary tests (before/at/after
  `open_available_at`, delayed availability, missing open, future session invisible).
- **M4.4 Value contracts:** `PortfolioState`, `Order`/`Fill`; validation/canonicalization tests.
- **M4.5 Reconciliation:** pure `reconcile()`; ADR-0005 examples A–H + R1–R16 mapped tests.
- **M4.6 Fills:** `apply_orders`; accounting, scaling, oversell, missing-open tests.
- **M4.7 Engine:** `run_backtest`; orchestration failure-path + warm-up + no-next-session tests.
- **M4.8 Reference runs:** Strategy A full-fixture backtest with hand calculations + golden;
  Strategy B end-to-end sleeve/cash assertions; determinism/state-isolation evidence.
- **M4.9 Closeout:** self-review passes, gate, learning-log entry, final report.

Each slice lands test-first and must be green before the next begins.

## Test blueprint (invariant → tests)

- **Schedule/calendar:** monthly fires on fixture month-ends (incl. 2026-06-30 last coverage
  session); weekly fires on Fridays (or last session of holiday-shortened weeks — Good Friday
  2026-04-03 week fires Thursday 2026-04-02); daily fires every session; non-session dates false;
  year boundary (Dec 2025 → Jan 2026); first/last calendar sessions; `next_session_after` strict
  after / weekend skip (Fri→Mon) / holiday skip (2026-04-02→2026-04-06) / None at coverage end;
  repeated calls identical.
- **Open boundary:** one second before open_available_at → hidden; exactly at → visible; delayed
  open availability; missing observation → None; view at F's open hides F's close; canonical
  asset ordering preserved.
- **PortfolioState:** valid empty/mixed; negative cash/qty, non-finite, bool rejected; zero-qty
  canonicalized away; frozen (mutation attempts fail); no mutation across a run (deep-equal
  before/after).
- **Reconciliation:** ADR-0005 worked examples A–H verbatim; every R1–R16 has at least one named
  test (R2 via the existing lattice tests; R16 via the engine-loop invariant test); held- and
  targeted-asset missing-price atomicity; dust boundary both sides + liquidation exemption;
  aggregate dust bound on projected cash; same-input bit determinism; input mutation checks.
- **Fills:** hand-computed sell/buy cash movements with bps costs; sells-before-buys proceeds
  funding; scaling on insufficient cash (later buys bear shortfall; cash ≥ 0); oversell rejected;
  zero-qty orders never emitted/applied; missing open → atomic failure; immutability of inputs;
  deterministic fill record order; planning-vs-fill price drift visible.
- **Engine:** schedule not firing → no evaluation; warm-up gate skips early evaluations (note
  recorded); fires+evaluates → orders queued → filled next open; M3 evaluation failure → run
  fails structured; reconciliation failure → run fails; missing next-open → run fails;
  no-next-session at coverage end → note, no trade; stale-mark valuation on the IWM-missing
  session; complete Strategy A run hand-checked; Strategy B run (sleeves kept, VNQ→0, cash
  0.25-ish, no renormalization); repeated-run equality (result equality incl. golden bytes);
  state isolation (shared catalog/market data across runs); no mutation of document, catalog,
  market data, or starting state.
- **Golden:** byte-stable across repeated generation; focused assertions alongside; update path
  via `--update-goldens` only.
- **Review-added cases:** weekly fires on the truncated final ISO week (Tuesday 2026-06-30 —
  by-design, pinned explicitly); warm-up gate exact boundary (last skipped vs first fired
  session); `fill_outside_window` when `last_session` precedes the scheduled fill;
  scaled-to-zero fill recorded (position unchanged); `ok=False` partial artifacts internally
  consistent (valuations/final_state as of last consistent transition); failure diagnostics
  contain no `Traceback`, absolute paths, or object reprs; cash-floor clamp boundary (residue in
  `[−ε, 0)` clamps to 0, more negative raises); planning-vs-fill drift on a synthetic
  open≠prior-close dataset.

## Stop conditions
Per the sprint mandate (contradiction with ADR-0005, IR change, OrderList in the lattice,
M2/M3 contract break, materially unspecified fill semantics). None currently triggered.

## Verification
`./scripts/gate.ps1` + focused runs listed in the blueprint + repeated-run/golden byte equality +
`git status`/`git diff` inspection. No generated artifacts may change.

## Self-review areas
Architecture/ownership, temporal, financial/accounting recomputation, determinism/state,
test-quality — fresh read-only reviewers over the finished diff.

## Closeout
Learning-log entry (real counts), final report per sprint checklist, stop before commit.
