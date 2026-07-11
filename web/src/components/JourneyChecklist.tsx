// M13.9 arrival aid: a compact, dismissible checklist of the five-step first-run journey (README §4).
// A DUMB component — it renders the state App owns (steps latch on as the user performs them; see
// journey/progress.ts) and reports a dismiss. No fetch, no storage, no inference here (invariant 5:
// presentation only). Design W7: a light contextual nudge, never a modal tutorial engine — so it is
// non-blocking chrome and vanishes for good once dismissed.
import type { ReactElement } from 'react'
import { JOURNEY_STEPS, type JourneyState } from '../journey/progress'

export interface JourneyChecklistProps {
  state: JourneyState
  onDismiss: () => void
}

export function JourneyChecklist({ state, onDismiss }: JourneyChecklistProps): ReactElement | null {
  if (state.dismissed) return null
  const done = new Set(state.done)
  const completed = state.done.length
  const total = JOURNEY_STEPS.length
  return (
    <section className="journey" aria-label="Getting-started journey">
      <header className="journey__head">
        <span className="journey__title">Walk the journey</span>
        <span className="journey__count">
          {completed}/{total}
        </span>
        <button type="button" className="journey__dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </header>
      <ol className="journey__steps">
        {JOURNEY_STEPS.map((step) => {
          const isDone = done.has(step.id)
          return (
            <li key={step.id} className="journey__step" data-done={isDone}>
              <span
                className="journey__mark"
                role="img"
                aria-label={isDone ? 'Done' : 'Not done yet'}
              >
                {isDone ? '✓' : '○'}
              </span>
              <span className="journey__label" data-testid="journey-step-label">
                {step.label}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
