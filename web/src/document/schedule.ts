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
  return ADVERB[kind]
}

/** A short schedule summary for a bar/readout ("Evaluates monthly"); a neutral fallback if unknown. */
export function scheduleSummary(kind: string): string {
  const adverb = scheduleAdverb(kind)
  return adverb === undefined ? 'Custom schedule' : `Evaluates ${adverb}`
}
