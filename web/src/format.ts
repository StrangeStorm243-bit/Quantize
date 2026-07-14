// Display-only formatting helpers (PX-C/PX-E). PRESENTATION ONLY: each function takes a SINGLE
// already-served value and returns a display string — it never sums, compares, sorts, or otherwise
// derives across values (CLAUDE.md invariant 5, the ResultsView `fmt` precedent). The verbatim value
// must stay reachable at the call site (rendered into a `title`), so nothing here is lossy in a way
// that hides the source number; these helpers only choose how the one served number is shown.

// One served number → its display string. Booleans and non-finite numbers pass through String() so a
// malformed value stays VISIBLE rather than crashing (the ResultsView guard). A finite number renders
// at 4 dp, then trailing zeros (and any bare decimal point) are trimmed by STRING manipulation of the
// toFixed result — never arithmetic on the value — so integer-valued served numbers (ranks, counts)
// show bare (`126`, not `126.0000`) while `0.025` keeps its digits.
export function fmtValue(value: number | boolean): string {
  if (typeof value === 'boolean') return String(value)
  if (!Number.isFinite(value)) return String(value)
  const fixed = value.toFixed(4)
  // toFixed(4) always has a '.', so trim the fractional tail: drop trailing zeros, then a dangling point.
  return fixed.replace(/\.?0+$/, '')
}

// A long content-addressed id → head…tail for display, with the full id kept in a `title` at the call
// site. The DataSourceCard convention (mirrored, not shared — consolidating the per-component abbrevs
// is out of scope): 18 chars or fewer render whole.
export function abbrev(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id
}
