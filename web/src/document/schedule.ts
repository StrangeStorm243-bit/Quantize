// Display formatting for a strategy's evaluation schedule (M13.7.5). The schedule kind is a served
// document field (ScheduleDaily | ScheduleWeekly | ScheduleMonthly, IR); mapping it to a human phrase
// is pure PRESENTATION — no schedule semantics are decided here (invariant 5). An UNRECOGNISED kind (a
// future cadence, or a malformed document) degrades to a neutral phrase / no phrase rather than
// crashing, so a schedule the UI has not learned about yet never blanks the bar or throws.
const ADVERB: Record<string, string> = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
}

/** The cadence adverb ("daily" / "weekly" / "monthly"), or undefined for an unrecognised kind. */
export function scheduleAdverb(kind: string): string | undefined {
  // Own-property guard: a bare `ADVERB[kind]` would resolve Object.prototype members, so a kind that
  // names one ('constructor', 'toString', 'hasOwnProperty') would return an inherited function instead
  // of undefined — defeating the malformed-document fallback above.
  return Object.hasOwn(ADVERB, kind) ? ADVERB[kind] : undefined
}

/** A short schedule summary for a bar/readout ("Evaluates monthly"); a neutral fallback if unknown. */
export function scheduleSummary(kind: string): string {
  const adverb = scheduleAdverb(kind)
  return adverb === undefined ? 'Custom schedule' : `Evaluates ${adverb}`
}

/**
 * The no-evaluation empty-state line, naming the RUN's cadence when the kind is recognised ("… this
 * strategy evaluates monthly.") so a skipped session is self-explanatory. An unrecognised or absent
 * kind — a future/malformed cadence, or a cadence the UI could not fetch — drops the clause and reads
 * the bare "No evaluation this session." A pure phrasing of the served kind (invariant 5); shared by
 * the Trace panel and the Inspector so the two surfaces cannot drift.
 */
export function noEvaluationLine(kind: string | undefined): string {
  const adverb = kind !== undefined ? scheduleAdverb(kind) : undefined
  return adverb !== undefined
    ? `No evaluation this session — this strategy evaluates ${adverb}.`
    : 'No evaluation this session.'
}
