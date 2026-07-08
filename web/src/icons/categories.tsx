// Category glyph set (M13.4, D-9): one small inline-SVG icon per authored machine-stage category,
// plus a neutral fallback. No icon-font, no external dependency — each glyph is a couple of stroked
// paths on a 16×16 grid, inheriting `currentColor` so the caller colors it via the category token.
//
// Icons are DECORATIVE: every node/segment already carries a text label, so the glyph is
// `aria-hidden`. An unknown/future category renders the neutral glyph rather than a hole — the same
// ceiling-absorption posture as the color map.
import type { ReactElement } from 'react'

// Each entry is the INNER markup of the 16×16 svg (paths/shapes). Kept terse and geometric so the set
// reads as one family: data flows in, transforms reshape, signals gate, selection ranks, weighting
// balances, risk caps, output targets.
const GLYPHS: Readonly<Record<string, ReactElement>> = {
  // Universe — a ring of assets (the candidate set).
  universe: (
    <>
      <circle cx="8" cy="8" r="5" />
      <circle cx="8" cy="3" r="1.1" />
      <circle cx="13" cy="8" r="1.1" />
      <circle cx="8" cy="13" r="1.1" />
      <circle cx="3" cy="8" r="1.1" />
    </>
  ),
  // Data — a stacked store feeding the machine.
  data: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </>
  ),
  // Transform — an input reshaped to an output.
  transform: (
    <>
      <path d="M2 5h7" />
      <path d="M6 2 9 5 6 8" />
      <path d="M14 11H7" />
      <path d="M10 8l-3 3 3 3" />
    </>
  ),
  // Signal — a threshold gate (step).
  signal: (
    <>
      <path d="M2 12h5V4h7" />
      <circle cx="7" cy="4" r="1.2" />
    </>
  ),
  // Selection — ranked bars, top picked.
  selection: (
    <>
      <path d="M3 13V7" />
      <path d="M8 13V3" />
      <path d="M13 13V9" />
      <path d="M6 5.5 8 3l2 2.5" />
    </>
  ),
  // Weighting — a balance beam.
  weighting: (
    <>
      <path d="M8 3v10" />
      <path d="M3 6h10" />
      <path d="M3 6 1.5 9.5h3z" />
      <path d="M13 6l-1.5 3.5h3z" />
    </>
  ),
  // Risk — a shield cap.
  risk: (
    <>
      <path d="M8 2 3 4v4c0 3 2.2 5 5 6 2.8-1 5-3 5-6V4z" />
    </>
  ),
  // Output / targets — a bullseye the machine aims portfolio weights at.
  output: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  // Reserved future families (design W2 pressure tests) — pre-drawn so they arrive with identity.
  optimization: (
    <>
      <path d="M2 12c3 0 3-8 6-8s3 8 6 8" />
      <circle cx="8" cy="4" r="1.2" />
    </>
  ),
  stochastic: (
    <>
      <path d="M2 8h2l1-3 2 6 2-8 2 7 1-2h2" />
    </>
  ),
  statistics: (
    <>
      <path d="M2 13h12" />
      <path d="M4 13V8" />
      <path d="M8 13V4" />
      <path d="M12 13V6" />
    </>
  ),
  ml: (
    <>
      <circle cx="4" cy="4" r="1.4" />
      <circle cx="12" cy="4" r="1.4" />
      <circle cx="8" cy="12" r="1.4" />
      <path d="M5 5 7 11M11 5 9 11M5.4 4h5.2" />
    </>
  ),
  external: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c2.2 2 2.2 9 0 11M8 2.5c-2.2 2-2.2 9 0 11" />
    </>
  ),
}

// Neutral fallback — a simple node dot-and-frame; used for any category without an assigned glyph.
const NEUTRAL_GLYPH: ReactElement = (
  <>
    <rect x="3" y="3" width="10" height="10" rx="2" />
    <circle cx="8" cy="8" r="1.4" />
  </>
)

/** The inline SVG glyph for a machine-stage category; the neutral glyph for an unknown/future one. */
export function CategoryIcon(props: { category: string; className?: string }): ReactElement {
  const glyph = GLYPHS[props.category] ?? NEUTRAL_GLYPH
  return (
    <svg
      className={props.className}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  )
}
