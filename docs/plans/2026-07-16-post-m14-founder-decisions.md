# Post-M14 Founder Decisions (FD-1…FD-9) — ratified 2026-07-16 (FD-9 added 2026-07-24)

> Decision record, not a plan. The M14 product/architecture review (2026-07-16, in-session)
> converted its findings into seven founder decisions; the founder ratified the recommended
> defaults verbatim ("finish all findings in the suggested order") and delegated execution.
> This document is the durable record so no future session re-litigates them. Review basis:
> `docs/reviews/2026-07-15-m14-closeout.md` + the M14 design record
> (`docs/plans/2026-07-11-m14-behavior-legibility-design.md`) + the post-M14 roadmap
> (`docs/plans/2026-07-11-post-m14-roadmap-m15-m16.md`).

| # | Decision | Ratified outcome | Status |
|---|---|---|---|
| FD-1 | Close M14 | **Merge PR #26** — M14 closed with review verdict PASS | ✅ Merged (`196290c`, 2026-07-16) |
| FD-2 | §13 external validation | **Run it next, before any build milestone**; founder to confirm no off-repo session already happened | ⏳ Founder-led — runbook prepared (`docs/reviews/2026-07-16-s13-validation-runbook.md`) |
| FD-3 | D-27 canonical number display | **Option A** — one shared display formatter (`web/src/format.ts::fmtValue`) consumed by Inspector, TraceView, ResultsView, and the Runs dock; verbatim value preserved in `title`; nonzero never displays as bare `0` | ✅ Landed in the FD-3/FD-6a polish slice (this branch) |
| FD-4 | M14.3 edge-hover dataflow | **Gate stays closed** (D-4 reaffirmed); the discoverability gap ("canvas gives no hint values exist") becomes a **pre-registered §13 probe**, not a build. *Superseded 2026-07-17 by explicit founder execution order, quoted verbatim: "Start building and executing M14.3 with Opus sub agents, store the M14.3 Rev E to the plans." Execution proceeds per `docs/plans/2026-07-17-m14.3-edge-hover-plan.md` (Rev E, four external audit rounds). §13 remains the recommended next step after this slice.* | 🔓 Opened by founder order (2026-07-17) |
| FD-5 | M15 direction | **Conditional: primary A** (statistical vocabulary via ONE founder-approved third reference strategy), **backup C** (data reality/ingestion); the roadmap §5 table is the displacement rule once §13 reports. B (authoring flow) and D (component authoring) explicitly deferred — D remains the M16 shape | ✅ Recorded — no M15 work starts before §13 evidence |
| FD-6a | Refusal copy humanization | **Approved** — the value-tap refusal is prefixed with the node's display label (client-held data; served message stays verbatim) | ✅ Landed in the FD-3/FD-6a polish slice (this branch) |
| FD-6b | Stage-strip zeros on componentized strategies | **Record only, build nothing**: extracting nodes into a component empties their stage-strip counts (v2 shows `Transforms 0 · Signals 0` — internals are excluded by design, M13). A deliberate design answer belongs to whichever milestone next touches the strip | ✅ Recorded here |
| FD-7 | Standing gates | **Reaffirmed, no action**: capture-at-run stays flip-trigger-gated (none fired; worst measured tap 130.6 ms vs ~1 s); value-over-time waits for its trigger; engine-boundary values never via the tap; the M14.2 deferred web cleanups stay in the closeout register | ✅ Reaffirmed |
| FD-8 | Pinned-edge on-canvas anchor (M14.3 product review M-2) | **Deferred, §13-gated**: a pinned flow readout names its source but nothing marks the pinned edge on the graph. Likely fix: a presentation-only pinned-edge CSS mark, NO React Flow selection semantics. Implement only if §13 shows confusion (or a live smoke shows it broken — the 2026-07-19 smoke did not). Related intentional non-decisions: L-2 canvas discoverability hint stays the §13 probe H2; L-3 readout/minimap narrow-width collision is deferred polish (superseded by FD-9) | ⏳ Deferred (§13-gated) |
| FD-9 | M14.4 desktop viewport-fit pass | Build and execute M14.4 as a single bounded pre-§13 desktop viewport-fit exception. Record FD-9 as superseding FD-8's L-3 deferral because the observed layout failure would contaminate §13 validation itself; §13 remains the next step immediately after this slice. Ratify D6 at a ≥260px React Flow minimum only for the journey-visible transient state, conditional on an edge remaining hover/pin-reachable and on dismissing the checklist and collapsing the dock restoring the ≥300px and ≥450px floors respectively.<br><br>I explicitly approve adding exact-pinned `@playwright/test` as the sole new development dependency under Node 24, exclusively for the opt-in viewport harness, with no canonical-gate or CI wiring. | 🔓 Opened by founder order (2026-07-24) |

## Recorded cleanup — 2026-07-19 final M14.3 review (founder: "record 5-6")

The final pre-§13 code review of the merged M14.3 range fixed four defects (PR #31: index-free pin
origins, origin-dead pin GC, dataset-picker mount focus, visible typed-edge selection) and recorded
two cleanups as **record-only, no behavior change** by founder decision:

- **C-1 — single `viewGraph` derivation.** The view's source graph (strategy doc vs. component tip
  definition) is now derived in three places in `Canvas.tsx`: `project()`, the `FlowPresence` memo,
  and the enter-component scope resolver. Nothing ties them together, so a future view mode that
  updates one but not the others would gate readouts against the wrong graph. Cleanup shape: one
  shared `viewGraph` memo consumed by all three. Do it opportunistically in whichever milestone next
  touches the Canvas view model.
- **C-2 — `chromeValue` identity across drag frames.** The chrome context memo is stable across
  hover renders (its goal) but re-mints on every node-drag pointer-move via the dep chain
  `onPortHover ← addressOfEdge ← rfNodes`, re-rendering every node card during drags — even with no
  probe active. Cleanup shape: read `rfNodes` through a ref inside `addressOfEdge` (all its callers
  run in event handlers, not render). Perf-only; no observed jank at demo scale.

## Boundaries this record pins

- **No M14.3, M15, or M16 work** starts before §13 evidence reaches the founder (FD-2/FD-4/FD-5).
- The FD-3/FD-6a slice is **presentation-only** — no contract change, no derivation added to the
  frontend (invariant 5 holds: formatting one already-served number is display, not computation).
- A §13 finding that contradicts M14's premise (design §8) remains a standing stop condition and
  goes to the founder as a question, not a plan.

## The one-sentence sequence

Merge M14 → fix the numbers → **stop building and watch 3–5 real traders use it** — every
remaining roadmap decision is designed to be made from what they say.
