// M13.9 journey-progress model. A first-time user walks the reoriented product via a five-step
// checklist; this module owns the *state* behind it: a monotonic latch (steps only ever tick on,
// never off) plus a graceful localStorage wrapper. It is pure + React-free — App infers which steps
// are done from state it already owns (invariant 5: no new logic, only presentation) and the
// JourneyChecklist component renders it.
//
// Storage mirrors theme.ts exactly: a single versioned key, try/catch on every access, and a safe
// EMPTY_JOURNEY fallback on missing/corrupt/blocked storage so a fresh profile never crashes and
// never shows a bogus tick.

export type JourneyStepId =
  | 'open-demo'
  | 'run-backtest'
  | 'open-results'
  | 'open-trace'
  | 'extract-component'

export interface JourneyStep {
  id: JourneyStepId
  label: string
}

// Ordered, mirrors README §4's click-path. This is the single source of both the canonical order and
// the on-screen labels (the JourneyChecklist renders straight from it).
export const JOURNEY_STEPS: readonly JourneyStep[] = [
  { id: 'open-demo', label: 'Open the demo strategy' },
  { id: 'run-backtest', label: 'Run a backtest' },
  { id: 'open-results', label: 'Open Results' },
  { id: 'open-trace', label: 'Open the Trace' },
  { id: 'extract-component', label: 'Extract a component' },
]

const STEP_ORDER = JOURNEY_STEPS.map((s) => s.id)
const STEP_IDS = new Set<string>(STEP_ORDER)

export interface JourneyState {
  done: JourneyStepId[] // monotonic latch, kept in canonical step order
  dismissed: boolean
}

export const EMPTY_JOURNEY: JourneyState = { done: [], dismissed: false }

export const JOURNEY_KEY = 'quantize.journey.v1'

// Union of already-done + newly-observed, deduped and re-sorted into canonical order so `done` is
// order-stable regardless of the order signals happened to fire. Never removes a step (a latch) and
// carries `dismissed` through unchanged. Idempotent by construction — safe under StrictMode's
// double-invoke.
export function latchSteps(state: JourneyState, observed: JourneyStepId[]): JourneyState {
  const union = new Set<JourneyStepId>([...state.done, ...observed])
  const done = STEP_ORDER.filter((id) => union.has(id))
  return { done, dismissed: state.dismissed }
}

// Read persisted state; any failure (blocked storage, corrupt JSON, wrong shape) resolves to a safe
// EMPTY_JOURNEY. Unknown step ids (e.g. from an older/newer key version) are dropped, never trusted.
export function loadJourney(): JourneyState {
  try {
    const raw = window.localStorage.getItem(JOURNEY_KEY)
    if (raw === null) return EMPTY_JOURNEY
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_JOURNEY
    const record = parsed as Record<string, unknown>
    const rawDone = Array.isArray(record.done) ? record.done : []
    const done = STEP_ORDER.filter(
      (id) => rawDone.includes(id) && STEP_IDS.has(id),
    ) as JourneyStepId[]
    const dismissed = record.dismissed === true
    return { done, dismissed }
  } catch {
    return EMPTY_JOURNEY
  }
}

// Persist; a blocked/full localStorage must never break the app — the in-memory state still applies.
export function saveJourney(state: JourneyState): void {
  try {
    window.localStorage.setItem(JOURNEY_KEY, JSON.stringify(state))
  } catch {
    // Intentionally swallowed — see theme.ts storeTheme.
  }
}
