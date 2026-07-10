// run/projections: the single-source projections over a served run record (M13.7.5). The
// load-bearing assertions are (1) every projection returns its EMPTY value for a mismatched record
// (the run-switch stale window — previously a hand-copied gate at each call site) and (2) the
// amended D-12 default: the LAST EVALUATED session, which differs from the last session in the
// fixture so the change from the old default is actually asserted.
import { describe, expect, it } from 'vitest'
import type { PersistedNote, PersistedRunRecord, RunRecordResponse } from '@quantize/quantize-api'
import { defaultCursor, evaluatedSet, gatedRecord, matchesRun, noteFor, sessionAxis } from './projections'

// A minimal record carrying only the fields the projections read (run_id, valuations,
// evaluations[].session_date, notes) — the cast keeps the fixture focused, mirroring TraceView.test.
function response(fields: {
  run_id?: string
  valuations?: string[]
  evaluations?: string[]
  notes?: PersistedNote[]
}): RunRecordResponse {
  const record = {
    run_id: fields.run_id ?? 'run-1',
    valuations: (fields.valuations ?? []).map((d) => [d, 1_000_000] as [string, number]),
    evaluations: (fields.evaluations ?? []).map((session_date) => ({ session_date })),
    notes: fields.notes ?? [],
  } as unknown as PersistedRunRecord
  return { record, replay_verifiable: true }
}

// Last evaluated (05-14) deliberately differs from the last session (05-15): the run evaluated
// mid-window and the final session is a no-evaluation one (the stranding case the amended D-12 fixes).
const NOTE: PersistedNote = {
  code: 'not_rebalance_session',
  message: 'monthly cadence: next rebalance after 2026-05-15',
  session_date: '2026-05-15',
}
const MATCHING = response({
  valuations: ['2026-05-13', '2026-05-14', '2026-05-15'],
  evaluations: ['2026-05-13', '2026-05-14'],
  notes: [NOTE],
})

describe('matchesRun', () => {
  it('is true only when a record and runId are present and the run_id matches', () => {
    expect(matchesRun(MATCHING, 'run-1')).toBe(true)
  })

  it('is false for a missing record, a missing runId, or a mismatched run_id (run-switch window)', () => {
    expect(matchesRun(undefined, 'run-1')).toBe(false)
    expect(matchesRun(MATCHING, undefined)).toBe(false)
    expect(matchesRun(MATCHING, 'run-2')).toBe(false)
  })
})

describe('gatedRecord (the sound-narrowing companion of matchesRun)', () => {
  it('returns the record itself when it is the selected run’s', () => {
    expect(gatedRecord(MATCHING, 'run-1')).toBe(MATCHING)
  })

  it('returns undefined for a mismatched, missing, or run-less record — never the stale record', () => {
    // Unlike `matchesRun`'s plain-boolean false, this narrows the VALUE to undefined so a consumer
    // (e.g. the hook's exposed record) can never keep holding the previous run's data through the gate.
    expect(gatedRecord(MATCHING, 'run-2')).toBeUndefined()
    expect(gatedRecord(MATCHING, undefined)).toBeUndefined()
    expect(gatedRecord(undefined, 'run-1')).toBeUndefined()
  })
})

describe('sessionAxis', () => {
  it('returns ALL valuation dates in served order for a matching record', () => {
    expect(sessionAxis(MATCHING, 'run-1')).toEqual(['2026-05-13', '2026-05-14', '2026-05-15'])
  })

  it('is empty for a mismatched or missing record — never the stale run’s dates', () => {
    expect(sessionAxis(MATCHING, 'run-2')).toEqual([])
    expect(sessionAxis(undefined, 'run-1')).toEqual([])
  })
})

describe('evaluatedSet', () => {
  it('returns the set of evaluated session dates for a matching record', () => {
    expect(evaluatedSet(MATCHING, 'run-1')).toEqual(new Set(['2026-05-13', '2026-05-14']))
  })

  it('is empty for a mismatched or missing record', () => {
    expect(evaluatedSet(MATCHING, 'run-2')).toEqual(new Set())
    expect(evaluatedSet(undefined, 'run-1')).toEqual(new Set())
  })
})

describe('noteFor', () => {
  it('returns the served note for the session, verbatim', () => {
    expect(noteFor(MATCHING, 'run-1', '2026-05-15')).toEqual(NOTE)
  })

  it('is undefined for a session without a note, a null session, or a mismatched record', () => {
    expect(noteFor(MATCHING, 'run-1', '2026-05-14')).toBeUndefined()
    expect(noteFor(MATCHING, 'run-1', null)).toBeUndefined()
    expect(noteFor(MATCHING, 'run-2', '2026-05-15')).toBeUndefined()
  })
})

describe('defaultCursor (D-12 as amended, M13.7.5)', () => {
  it('picks the LAST EVALUATED session — NOT the last session of the axis', () => {
    // 2026-05-15 is the last session but was not evaluated; the old default landed there.
    expect(defaultCursor(MATCHING)).toBe('2026-05-14')
  })

  it('falls back to the last session for a run with no evaluations', () => {
    const noEvals = response({ valuations: ['2026-06-01', '2026-06-02'] })
    expect(defaultCursor(noEvals)).toBe('2026-06-02')
  })

  it('is null for an empty record (no evaluations, no valuations)', () => {
    expect(defaultCursor(response({}))).toBeNull()
  })

  it('falls back to the last valuation when the last evaluation is OFF the valuation axis', () => {
    // Pins the on-axis guarantee: the cursor axis is the valuations, so an evaluation date absent
    // from valuations (server maintains evaluations ⊆ valuations, so this is defensive) must NOT
    // become the default — that would strand the whole loop (trace gate never fires, steppers disable).
    const offAxis = response({
      valuations: ['2026-07-01', '2026-07-02'],
      evaluations: ['2026-07-01', '2026-07-09'],
    })
    expect(defaultCursor(offAxis)).toBe('2026-07-02')
  })
})
