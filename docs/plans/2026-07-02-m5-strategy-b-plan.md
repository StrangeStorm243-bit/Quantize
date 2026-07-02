# M5 — Strategy B Golden + Cap-Redistribution Coverage (2026-07-02)

Plan-of-record per `PLAN_TEMPLATE.md`. Deliberately small: M5 validates the fixed-sleeve /
no-renormalization / cash-as-remainder semantics and the `risk.max_weight` overflow behavior that
Strategy A never exercises (MVP_PLAN §M5). No production code changes are expected.

## Purpose & definition of done
- Strategy B full-fixture engine golden committed (`tests/goldens/strategy_b_backtest.json`),
  byte-stable and libm-free, with focused hand-computed first-rebalance assertions (survivors
  keep exact 0.25 sleeves; VNQ 0; cash = 1 − Σ(surviving sleeves) minus only the bps drag; no
  renormalization at any evaluation).
- An engine-integrated `risk.max_weight` overflow scenario over the fixture: equal weights above
  the cap ⇒ every asset capped, unresolved excess stays in cash, `risk.cap_applied` trace event
  visible in the run record; targets/orders/fills/ending state hand-checked.
- One added unit case: excess splits EQUALLY across two equally-weighted eligible receivers
  (canonical determinism of the proportional waterfall with ties).
- Build-integrity fix: `tests/goldens/*.json` pinned `text eol=lf` in `.gitattributes` (a fresh
  Windows checkout CRLF-normalized the golden and broke the byte comparison locally — the exact
  failure mode the codegen artifacts are already pinned against).
- Full gate green; no M1–M4 contract or production module changed.

## Authoritative inputs
MVP_PLAN §M5; STRATEGY_LANGUAGE §3 (fixed sleeves, cash remainder, ratified waterfall);
ADR-0005 (already implemented — not reopened); M4 engine + golden infrastructure.

## Scope / exclusions
Tests, goldens, one `.gitattributes` line, this plan, learning-log entry. NOT in scope: M6 trace
construction, new nodes, engine changes, renormalizing variants (explicitly not Strategy B),
reopening the waterfall spec. Note: with the v0 node set, a strategy graph can only feed the cap
EQUAL weights (equal_weight / fixed_weight), so the in-graph overflow form is
all-capped-simultaneously ⇒ remainder to cash; the unequal-weight proportional waterfall remains
unit-level coverage (M3 + the new tie case) until a node that produces unequal weights exists.

## Slices
- **M5.1** `.gitattributes` goldens pin (restores the 571 baseline on Windows checkouts).
- **M5.2** Strategy B golden + hand assertions (first firing session derived from the 200-session
  warm-up gate; buys = 250,000/close each for AGG/EFA/SPY at that Friday's closes; fills at the
  Monday open ≡ Friday close; no scaling — 750,375 < 1,000,000; post-fill cash exactly
  1,000,000 − 750,000×1.0005 = 249,625).
- **M5.3** Engine cap-overflow scenario: `u → px → ret(126) → rk → sel(n=2) → ew → cap(0.4) → tp`
  monthly over a narrowed window starting 2025-07-31 (warm-up already satisfied calendar-wide):
  ew ⇒ {QQQ: 0.5, SPY: 0.5} ⇒ cap ⇒ {QQQ: 0.4, SPY: 0.4} + 0.2 cash; assert the cap trace event,
  reconciliation numbers, fills, ending state; repeated-run determinism.
- **M5.4** Unit tie case for the waterfall; reviews (accounting + golden portability/test
  quality); gate; learning log; report.

## Stop conditions
Only the standing ones (spec contradiction, contract change needed). None anticipated.

## Verification
`./scripts/gate.ps1`; golden byte-stability across repeated generation; independent accounting
review of every hand number; git diff inspection. Stop before commit.
