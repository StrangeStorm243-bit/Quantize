// schedule: pure DISPLAY formatting for a strategy's evaluation cadence (M13.7.5). The kind is a
// served document field; these helpers only phrase it for the UI (invariant 5). The load-bearing
// case is the UNKNOWN kind falling back safely — a future/malformed cadence must never crash the bar.
import { describe, expect, it } from 'vitest'
import { scheduleAdverb, scheduleSummary } from './schedule'

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
})

describe('scheduleSummary', () => {
  it('summarises a known cadence as "Evaluates <adverb>"', () => {
    expect(scheduleSummary('monthly')).toBe('Evaluates monthly')
    expect(scheduleSummary('daily')).toBe('Evaluates daily')
  })

  it('falls back to a neutral phrase for an unrecognised kind', () => {
    expect(scheduleSummary('quarterly')).toBe('Custom schedule')
  })
})
