// M13.9 journey-progress model tests: a pure monotonic latch + a graceful localStorage wrapper,
// mirroring the theme.ts pattern (default on missing/corrupt/blocked storage, never throws).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_JOURNEY,
  JOURNEY_STEPS,
  JOURNEY_KEY,
  latchSteps,
  loadJourney,
  saveJourney,
  type JourneyState,
} from './progress'

beforeEach(() => {
  window.localStorage.clear()
})
afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('JOURNEY_STEPS', () => {
  it('is exactly the five ordered steps mirroring README §4', () => {
    expect(JOURNEY_STEPS.map((s) => s.id)).toEqual([
      'open-demo',
      'run-backtest',
      'open-results',
      'open-trace',
      'extract-component',
    ])
  })

  it('gives every step a non-empty human label', () => {
    for (const step of JOURNEY_STEPS) {
      expect(step.label.length).toBeGreaterThan(0)
    }
  })
})

describe('EMPTY_JOURNEY', () => {
  it('has no done steps and is not dismissed', () => {
    expect(EMPTY_JOURNEY).toEqual({ done: [], dismissed: false })
  })
})

describe('latchSteps', () => {
  it('adds a newly observed step', () => {
    const next = latchSteps(EMPTY_JOURNEY, ['open-demo'])
    expect(next.done).toEqual(['open-demo'])
  })

  it('never removes an already-done step when it is not re-observed', () => {
    const state: JourneyState = { done: ['open-demo', 'run-backtest'], dismissed: false }
    const next = latchSteps(state, [])
    expect(next.done).toEqual(['open-demo', 'run-backtest'])
  })

  it('dedupes an already-done step that is observed again', () => {
    const state: JourneyState = { done: ['open-demo'], dismissed: false }
    const next = latchSteps(state, ['open-demo'])
    expect(next.done).toEqual(['open-demo'])
  })

  it('preserves the dismissed flag', () => {
    const state: JourneyState = { done: [], dismissed: true }
    const next = latchSteps(state, ['open-demo'])
    expect(next.dismissed).toBe(true)
  })

  it('keeps done ordered by canonical step order, not observation order', () => {
    const next = latchSteps(EMPTY_JOURNEY, ['open-trace', 'open-demo'])
    expect(next.done).toEqual(['open-demo', 'open-trace'])
  })
})

describe('loadJourney', () => {
  it('returns EMPTY_JOURNEY when no key is stored', () => {
    expect(loadJourney()).toEqual(EMPTY_JOURNEY)
  })

  it('survives corrupt JSON and returns EMPTY_JOURNEY', () => {
    window.localStorage.setItem(JOURNEY_KEY, '{nope')
    expect(loadJourney()).toEqual(EMPTY_JOURNEY)
  })

  it('survives wrong-shape JSON and returns EMPTY_JOURNEY', () => {
    window.localStorage.setItem(JOURNEY_KEY, '{"done":"x"}')
    expect(loadJourney()).toEqual(EMPTY_JOURNEY)
  })

  it('ignores unknown step ids in a stored done list', () => {
    window.localStorage.setItem(
      JOURNEY_KEY,
      JSON.stringify({ done: ['open-demo', 'bogus'], dismissed: false }),
    )
    expect(loadJourney().done).toEqual(['open-demo'])
  })
})

describe('saveJourney / loadJourney round-trip', () => {
  it('round-trips a saved state', () => {
    const state: JourneyState = { done: ['open-demo', 'run-backtest'], dismissed: true }
    saveJourney(state)
    expect(loadJourney()).toEqual(state)
  })

  it('does not throw when setItem is blocked', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => saveJourney({ done: ['open-demo'], dismissed: false })).not.toThrow()
  })
})
