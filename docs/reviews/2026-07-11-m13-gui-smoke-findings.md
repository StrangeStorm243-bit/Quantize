# M13 GUI Smoke — Findings (2026-07-11)

First **live browser** click-through of the M13 debug loop after M13.7 / M13.7.5 / M13.8 all
landed on `main` (PRs #19 / #20 / #21; `origin/main = 12a66eb`). This was the founder step that all
prior gates deferred ("never claim something works because code was written"). Input for the
**M13.9** closeout (arrival / journey checklist / scripted 30-sec legibility test).

## Setup

- Backend: `uvicorn quantize.api.app:create_app --factory --host 127.0.0.1 --port 8000`,
  `QUANTIZE_DB_PATH=quantize-demo.db`.
- Frontend: Vite dev server at `http://localhost:5173` (Node 24).
- Seeded via `scripts/seed_demo.py`: dataset `84de0d8b…3a69`, strategies *ETF Momentum Rotation*
  (`1111…`) + *Trend-Filtered Portfolio* (`3333…`).
- Strategy exercised: **ETF Momentum Rotation**, backtest window **2025-07-31 → 2025-08-29**
  (1 evaluation, monthly cadence).
- Theme: dark. (Light-theme pass NOT done — see F3.)

## Verdict

**Strong pass.** The M13.7 + M13.7.5 debug loop works end to end in the real browser. Two
actionable findings (both minor) and two coverage gaps recorded below.

## Verified working (positive confirmations for the M13.9 legibility script)

- **Legibility (Phase 1):** category-colored node cards; stage strip
  `Data 2 → Transforms 1 → Signals 0 → Rank & Select 2 → Weighting & Risk 2 → Targets 1 → Engine`;
  typed ports + port-type legend; Data Source card (universe / calendar 374 sessions / fingerprint).
- **Backtest (Phase 2):** `ok Backtest · replay-verifiable`; equity chart; `TOTAL RETURN 0.0250 ·
  MAX DRAWDOWN 0.0000 · FINAL CASH 0.00`.
- **Session cursor default (M13.7.5):** landed on `2025-07-31 · evaluated` (the evaluated session),
  not an empty month-end. The amended D-12 "last evaluated" default is correct in practice.
- **Interactive chart (M13.7):** hover crosshair readout `2025-08-11 · 1007928.59…`.
- **Honest no-eval state (M13.7.5):** stepping to `2025-08-11` shows *"No evaluation this session —
  this strategy evaluates monthly."* — cadence pulled correctly from the run's producing version.
- **Trace → canvas (M13.7):** clicking the `ret` trace row centered + selected the **Trailing
  Return** node on the canvas.
- **Inspector "At session" (M13.7 / Node Value Tap slot):** live with real trace facts —
  `data.observed / per_asset` values at `2025-07-31`.
- **Explanation (M13.5 / D-13):** role-first sentence ("The machine's data entry point — loads each
  universe asset's close-price history…"), formula `r_D = close(D)/close(D−L) − 1`, semantics/warm-up.
- **Invariant #10 visible in the wild:** trace shows `transform.excluded → excluded GLD —
  missing_anchor_close` (no silent forward-fill; exclusion is traced with a cause).

## Findings

### F1 — Cosmetic: equity-chart corner label overlap  · severity: low · **FIXED 2026-07-11**
At the `SvgLineChart` bottom-left corner the y-axis minimum label and the x-axis start date collided
into an unreadable smear (rendered as `1000007-31` — the `1000000`-ish y-min over `2025-07-31`).
Screenshot: `Screenshot (361)`.

**Root cause:** `.chart__axis--y` was absolutely positioned with `bottom: 20px` — anchored to the
`.chart` *container* bottom, sized to clear the x-axis row. M13.7.5 later added `.chart__hint`
("Click a point to inspect that session.") *below* the x-axis, growing the container, so the
container-anchored min label dropped into the x-axis row and collided with the first-date label.
Only interactive charts (the ones with the hint) were affected — exactly where it was observed.

**Fix (`web/src/App.css`):** anchor the y-axis to the plot height (`height: 120px`, the svg height)
instead of the container bottom, so it is robust to anything rendered below the svg.

**Verification:** CSS-only layout fix — NOT unit-testable (jsdom has no layout engine, so overlap is
unobservable in vitest). Verified by (a) no regression — `SvgLineChart.test.tsx` (12) + `tokens.test.ts`
(40) green; (b) **visual re-check DONE 2026-07-11** (live Playwright-MCP): Results chart bottom-left
corner shows `1000000` on its own line above `2025-07-31` — no smear — in **both** dark (`m139-03`) and
light (`m139-12`). See `2026-07-11-m13.9-journey-walkthrough.md` Phase 6.

### F2 — Coverage gap: M13.8 breadcrumb component navigation NOT exercised live · severity: med · **CLOSED 2026-07-11**
The newest merge (PR #21, component breadcrumb navigation) was **not** touched — the Components rail
read *"No saved components,"* so no extraction / Enter-component / breadcrumb / trace-into-component
path was walked in a real browser. Its headless coverage is green (563 web tests), but the live
click-through is still owed. **M13.9 must include Phase 4** (extract a 2–3 node subgraph → verify it
appears in Components + results stay identical → Enter component → breadcrumb walk in/out →
trace-into-component navigation) before M13 closeout.

**Closure (live Playwright-MCP session, 2026-07-11):** all sub-checks pass — extracted `Trailing
Return + Rank` as component "Momentum Rank" (rail shows it), re-ran the rewritten strategy → identical
**Total return 0.0250** (semantics-preserving), Enter component → read-only breadcrumb view, crumb-click
+ Esc exit, canvas double-click re-enter, and a nested trace row navigated the breadcrumb to the
emitting node. Evidence + screenshots: `docs/reviews/2026-07-11-m13.9-journey-walkthrough.md` (Phase 4;
`m139-07..09`, `m139-12`).

### F3 — Coverage gap: light-theme smoke NOT done · severity: low · **CLOSED 2026-07-11**
Only dark theme was walked. M13 shipped design tokens + light/dark theming; the M13.9 legibility
script should include a light-theme pass (formula box wrapping, inline port colors, `.pform__help`
legibility, and the F1 chart corner in light).

**Closure (live Playwright-MCP session, 2026-07-11):** light-theme sweep of Home, canvas
cards/edges/legend, Inspector Explanation formula box (`MA(D) = mean(…)` wraps cleanly onto two lines),
`.pform` help, Trace, Results chart, and the journey checklist — all legible; no illegible surface
found. F1 chart corner also confirmed clean in light. Evidence: `2026-07-11-m13.9-journey-walkthrough.md`
(Phase 5; `m139-10..15`).

## Environment note

Backend (uvicorn) + frontend (Vite) were left **running** in the background after the smoke so the
loop can be re-checked. `quantize-demo.db` now holds the seeded dataset/strategies + one backtest
run (gitignored; regenerable via `seed_demo.py` + a re-run). Stop the two servers before any gate
run that needs the ports.
