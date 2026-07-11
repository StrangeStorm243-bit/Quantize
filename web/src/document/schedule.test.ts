// schedule: pure DISPLAY formatting for a strategy's evaluation cadence (M13.7.5). The kind is a
// served document field; these helpers only phrase it for the UI (invariant 5). The load-bearing
// case is the UNKNOWN kind falling back safely — a future/malformed cadence must never crash the bar.
import { describe, expect, it } from 'vitest'
import { noEvaluationLine, scheduleAdverb, scheduleSummary } from './schedule'

describe('scheduleAdverb', () => {
  it('maps each known cadence to its adverb', () => {
    expect(scheduleAdverb('daily')).toBe('daily')
    expect(scheduleAdverb('weekly')).toBe('weekly')
    expect(scheduleAdverb('monthly')).toBe('monthly')
  })

  it('is undefined for an unrecognised kind (a future/malformed cadence)', () => {
    expect(scheduleAdverb('quarterly')).toBeUndefined()
    expect(scheduleAdverb('')).toBeUndefined()
  })

  it('is undefined for an Object.prototype member name (no prototype-chain leak)', () => {
    // A bare `ADVERB[kind]` on a plain object literal would resolve inherited members, so a kind
    // that happens to name one ('constructor' returns the Object constructor, 'toString'/'hasOwnProperty'
    // their functions) would render "Evaluates function Object()…" — defeating the malformed fallback.
    expect(scheduleAdverb('constructor')).toBeUndefined()
    expect(scheduleAdverb('toString')).toBeUndefined()
    expect(scheduleAdverb('hasOwnProperty')).toBeUndefined()
  })
})

describe('scheduleSummary', () => {
  it('summarises a known cadence as "Evaluates <adverb>"', () => {
    expect(scheduleSummary('monthly')).toBe('Evaluates monthly')
    expect(scheduleSummary('daily')).toBe('Evaluates daily')
  })

  it('falls back to a neutral phrase for an unrecognised kind', () => {
    expect(scheduleSummary('quarterly')).toBe('Custom schedule')
  })

  it('falls back for an Object.prototype member name rather than leaking a method', () => {
    expect(scheduleSummary('constructor')).toBe('Custom schedule')
    expect(scheduleSummary('toString')).toBe('Custom schedule')
  })
})

describe('noEvaluationLine', () => {
  it('names the cadence for a recognised kind', () => {
    expect(noEvaluationLine('monthly')).toBe(
      'No evaluation this session — this strategy evaluates monthly.',
    )
    expect(noEvaluationLine('weekly')).toBe(
      'No evaluation this session — this strategy evaluates weekly.',
    )
  })

  it('drops the cadence clause for an unrecognised kind', () => {
    expect(noEvaluationLine('quarterly')).toBe('No evaluation this session.')
  })

  it('drops the cadence clause when the kind is undefined (no run cadence known)', () => {
    expect(noEvaluationLine(undefined)).toBe('No evaluation this session.')
  })
})
