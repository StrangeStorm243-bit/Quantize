# <Milestone/Slice> — Implementation Plan (<date>)

> One coherent plan-of-record per milestone or slice. This template merges the previously separate
> design + plan documents — write both concerns here unless a slice genuinely needs a standalone
> design ADR. Keep every section short; delete sections that do not apply. Do not restate
> CLAUDE.md.

## Purpose & definition of done
What this milestone makes possible, in one paragraph, plus an explicit "done means" list a
reviewer can check off.

## Authoritative inputs
The documents/contracts this plan implements (roadmap section, ADRs, specs, prior milestone
records). The plan must not contradict them; contradictions are stop conditions, not judgment
calls.

## Scope
The subsystems this milestone owns, one line each.

## Exclusions
What is explicitly NOT built, with the milestone it defers to. Preserved seams named where
relevant.

## Contracts & invariants
New/changed public types, functions, and value objects, with their invariants (immutability,
determinism, ordering, tolerances, temporal rules). Anything a later milestone will depend on
belongs here, precisely.

## Unresolved decisions
Decisions this plan could NOT make from authoritative inputs — each is either resolved with the
founder before implementation or listed as a mandatory stop condition.

## Implementation slices
Ordered coherent slices (`Mx.1`, `Mx.2`, …), each with: files expected to change, acceptance
tests (test-first), and what "green" means for that slice. Later slices must not begin before
earlier foundations pass.

## Test blueprint
Map every invariant above to at least one named test category: correctness (hand-computed
expected values, independent of the implementation), boundaries, missing/invalid data, temporal
safety, determinism/repeated-run, no-mutation/state isolation, failure paths with exact
diagnostic codes.

## Stop conditions
The specific ambiguities/contradictions that must halt implementation for a founder decision
(beyond CLAUDE.md's standing invariants).

## Verification
The full gate (`./scripts/gate.ps1`) plus any milestone-specific evidence (goldens, repeated-run
equality, reference scenarios). Done claims require actual command output.

## Self-review areas
The read-only review passes to run on the finished diff (e.g. architecture/ownership, temporal,
numerical/accounting, test quality) before requesting external review.

## Closeout
- Learning-log entry (concepts, files, reading path, exercise, status — with real numbers).
- Final report expectations: what changed, invariants vs. tests mapping, known limitations,
  deferred work, files for founder/Codex inspection.
