# §13 External Validation — Session Runbook (prepared 2026-07-16)

> **Founder-led.** This runbook packages everything already built for §13 (the validation plan:
> 3–5 quant-literate testers walk the journey unassisted) so a session can start with zero prep.
> Prepared under FD-2 (`docs/plans/2026-07-16-post-m14-founder-decisions.md`); nothing here is
> new product scope. Status at preparation: **no §13 session has repository evidence; the founder
> was asked to confirm whether any happened off-repo** (PR #26 body, M14 closeout §8).

## Who and what

- **Testers:** 3–5 quant-literate, self-directed systematic traders (the `docs/PRODUCT.md`
  initial user — people with explicit rules currently living in spreadsheets/Pine/notebooks).
  Not beginners, not institutional desks.
- **Product state:** M14 merged — the full loop exists: select run → session cursor → click any
  node (incl. component internals) → see its value + decisions → targets/orders/fills.
- **Setup:** fresh profile, demo DB seeded (`python scripts/seed_demo.py`), both servers up
  (README Quickstart), README closed. The tester drives; the founder observes and records.

## Instruments (all committed, M13.9)

1. **Instrument #1 — unassisted journey walkthrough**: the tester walks the five-step "Walk the
   journey" checklist guided only by the Home screen and on-screen states.
   (`docs/reviews/2026-07-11-m13.9-journey-walkthrough.md`, "Instrument #1".)
2. **Instrument #2 — scripted 30-second legibility test**: the verbatim script (same doc,
   "Instrument #2"): within ~30 seconds of the demo strategy + a run, can the tester say where
   data enters, what each stage does, how targets are made, what the engine did, and where to
   look next?
3. **New since M13.9 — value inspection**: ask the tester to answer one concrete question using
   the Node Value Tap (e.g. "what trailing return did QQQ have at the July evaluation, and why
   was GLD excluded?"). No script exists for this yet — record verbatim what they click and say.

## Pre-registered hypotheses (write the verdicts down per tester)

Recorded BEFORE any session so the results can't be curve-fit afterwards:

- **H1 (M14 closeout, gate memo):** "The Inspector surface is enough — reading a node's value by
  clicking it satisfies 'what flows where'; edge-hover dataflow (M14.3) is not needed."
  *Evidence to watch:* does the tester ever hover an edge expecting a value, or ask "what's
  flowing here?" while pointing at a wire?
- **H2 (FD-4 probe):** "Nothing on the canvas hints that nodes are value-tappable — testers will
  discover values via the Inspector anyway." *Evidence:* time-to-first-tap; whether discovery
  needed a prompt.
- **H3 (M14 review, Track 5):** "The product reads as a simulated bot builder, not a dashboard —
  testers understand it evaluates on a schedule, computes signals → targets, and that the engine
  fills orders next session; Live is understood as deferred."
- **H4 (D-27 residual):** "Numbers now render consistently and no signal reads as zero." *Watch
  for any number-formatting double-take.*

## What to record per session

Verbatim quotes at each journey step; every place the tester stalls >15s or asks a question;
the 30-second-script answers (pass/fail per line); H1–H4 verdicts; and **the tester's own
strategy in their words** (one paragraph — this is the M15-direction input).

## Decision routing (roadmap §5, applied when results are in)

| Signal from testers | Consequence (pre-agreed) |
|---|---|
| "It can't express *my* strategy" | M15 = **A** (third reference strategy from their rules) — FD-5 primary |
| "I can't get my data in / don't trust fixture results" | M15 = **C** (data reality) displaces A — FD-5 backup |
| "Evolving/reusing components is the wall" | Swap M15 ↔ M16 (component authoring) |
| "Show me the signal over time" | Capture-at-run flip-trigger 2 fires → its own designed milestone |
| Legibility complaints persist / H1 fails | **M14.3 gate opens** (D-4's confirmed signal) |
| Thesis-level contradiction | Stop; founder-level product decision |

One rule binds all rows: the founder decides; sessions produce evidence, not milestones.
