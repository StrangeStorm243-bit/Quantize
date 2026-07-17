// Display-only formatting helpers (PX-C/PX-E). PRESENTATION ONLY: each function takes a SINGLE
// already-served value and returns a display string — it never sums, compares, sorts, or otherwise
// derives across values (CLAUDE.md invariant 5, the ResultsView `fmt` precedent). The verbatim value
// must stay reachable at the call site (rendered into a `title`), so nothing here is lossy in a way
// that hides the source number; these helpers only choose how the one served number is shown.

// One served number → its display string. Booleans and non-finite numbers pass through String() so a
// malformed value stays VISIBLE rather than crashing (the ResultsView guard). A finite number renders
// at 4 dp, then trailing zeros (and any bare decimal point) are trimmed by STRING manipulation of the
// toFixed result — never arithmetic on the value — so integer-valued served numbers (ranks, counts)
// show bare (`126`, not `126.0000`) while `0.025` keeps its digits. Edge cases pinned in the tests:
// a NONZERO value whose 4-dp render would trim to bare `0` falls back to exponential notation
// (`2.5e-5`) — a returns-scale signal must never display as zero (D-27) — while exact zero (and a
// served `-0`) stays plain `0`; and a magnitude ≥ 1e21 where `toFixed` itself returns exponent
// notation (`1e+30`, `1.5e+50`) passes through WHOLE — the trim is gated on the absence of an 'e',
// because in exponent notation trailing digits are magnitude, not padding (an unconditional trim
// turns `1e+30` into `1e+3`; a '.'-presence gate is not enough — `1.5e+50` has a mantissa dot and
// would still lose its exponent's zero).
export function fmtValue(value: number | boolean): string {
  if (typeof value === 'boolean') return String(value)
  if (!Number.isFinite(value)) return String(value)
  const fixed = value.toFixed(4)
  // Trim the fractional tail (trailing zeros, then a dangling point) only in plain notation; a
  // non-exponent toFixed(4) always carries a '.', so the trim can never eat integer digits.
  const trimmed = fixed.includes('e') ? fixed : fixed.replace(/\.?0+$/, '')
  if ((trimmed === '0' || trimmed === '-0') && value !== 0) {
    // Sub-4-dp nonzero: exponential keeps it visibly nonzero; the mantissa's own zero tail trims
    // ('1.00e-7' → '1e-7') — string manipulation of one number's rendering, never arithmetic.
    return value.toExponential(2).replace(/\.?0+e/, 'e')
  }
  // A tiny -0 (or a served -0) trims to '-0'; show plain '0' (a sign on a zero is noise, not info).
  return trimmed === '-0' ? '0' : trimmed
}

// A long content-addressed id → head…tail for display, with the full id kept in a `title` at the call
// site. The DataSourceCard convention (mirrored, not shared — consolidating the per-component abbrevs
// is out of scope): 18 chars or fewer render whole.
export function abbrev(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id
}
