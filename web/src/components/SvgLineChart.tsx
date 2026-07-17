// A hand-rolled SVG line chart for a run's portfolio `valuations` (M11.6, D9). NO chart library.
//
// This is PURE PRESENTATION: it SCALES the already-computed valuations to pixel coordinates so they
// can be drawn — it derives no metric (returns/drawdown/PnL all live in the record, invariant 5).
// `chartPoints` is the extracted, unit-tested mapping; the component only draws its output.
import { useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'

/** A pixel coordinate in the chart's viewBox. */
export interface ChartPoint {
  x: number
  y: number
}

/**
 * Map a series of values to SVG coordinates within a `width` x `height` box. x is the sample index
 * spread across the width; y is the value's position within [min, max], INVERTED (SVG y grows
 * downward, so the largest value sits at y=0). This is scaling for display only — min/max bound the
 * axis, they are not a computed statistic about the series.
 *
 * Degenerate inputs are handled: an empty series yields no points; a singleton (or any flat series
 * with zero range) is centred vertically and — for a singleton — horizontally.
 */
export function chartPoints(values: number[], width: number, height: number): ChartPoint[] {
  const n = values.length
  if (n === 0) {
    return []
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min
  return values.map((value, index) => {
    const x = n === 1 ? width / 2 : (index / (n - 1)) * width
    const y = range === 0 ? height / 2 : height - ((value - min) / range) * height
    return { x, y }
  })
}

const WIDTH = 320
const HEIGHT = 120

export interface SvgLineChartProps {
  /** `[date, portfolio_value]` pairs, verbatim from a run record's `valuations`. */
  points: [string, number][]
  /** Optional interactivity (M13.7): hover crosshair + click-to-select. The chart maps a pixel x to a
   *  point INDEX and reports the SERVER date at that index — it derives no number (invariant 5). */
  onSelectPoint?: ((date: string) => void) | undefined
  /** The svg's accessible label — it must describe what the CALLER plots. Defaults to the original
   *  portfolio-value phrasing so the ResultsView consumer (and its tests) stay byte-identical; a
   *  per-series consumer (the Inspector value-tap sparkline, M14.2) passes its own asset label. */
  ariaLabel?: string
  /** Display formatting for an axis label (and the hover readout's value) — caller-supplied, still pure
   *  presentation of one already-plotted value (invariant 5). Defaults to `String`; ResultsView and the
   *  value-tap sparkline both pass `fmtValue` (D-27) so no label leaks a 17-digit float. The verbatim
   *  value stays reachable regardless: the readout and the y-axis labels carry it in a `title`. */
  formatValue?: (value: number) => string
}

export function SvgLineChart({
  points,
  onSelectPoint,
  ariaLabel = 'portfolio value over time',
  formatValue = String,
}: SvgLineChartProps): ReactElement {
  // The hovered point INDEX (or null when not hovering / not interactive). It indexes the served
  // points array; it is never used to compute a value.
  const [hover, setHover] = useState<number | null>(null)

  if (points.length === 0) {
    return <div className="chart chart--empty">No valuations to plot.</div>
  }

  const values = points.map(([, value]) => value)
  const coords = chartPoints(values, WIDTH, HEIGHT)
  const polyline = coords.map((c) => `${c.x},${c.y}`).join(' ')

  // Axis labels are raw record values, formatted for display only (min/max of the plotted series,
  // first/last date). No number here is derived.
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const firstDate = points[0][0]
  const lastDate = points[points.length - 1][0]

  const interactive = onSelectPoint !== undefined
  // Clamp the stored hover at RENDER time rather than trusting the persisted index: `hover` is useState
  // on an unkeyed component, so if `points` is replaced in place by a SHORTER series while the pointer
  // is over the chart, a stale index N ≥ points.length would read out of bounds. Deriving a valid index
  // per render makes that impossible (the crosshair/readout simply drop until the next mousemove).
  const hoverIndex = hover !== null && hover < points.length ? hover : null

  // Map a mouse x to the NEAREST point index (clamped to valid indices) — pure pixel→index mapping,
  // NO date/value arithmetic. Reads the svg's on-screen box so the viewBox scaling is irrelevant.
  const indexAt = (e: ReactMouseEvent<SVGSVGElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = rect.width === 0 ? 0 : (e.clientX - rect.left) / rect.width
    return Math.max(0, Math.min(points.length - 1, Math.round(frac * (points.length - 1))))
  }

  return (
    <div className="chart">
      <svg
        className={`chart__svg${interactive ? ' chart__svg--interactive' : ''}`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        onMouseMove={interactive ? (e) => setHover(indexAt(e)) : undefined}
        onMouseLeave={interactive ? () => setHover(null) : undefined}
        // Click-to-select is a MOUSE affordance; the keyboard-accessible path to selecting a session is
        // the evaluation/fill row buttons in ResultsView — do not "fix" this handler's mouse-only nature
        // in isolation.
        onClick={interactive ? (e) => onSelectPoint(points[indexAt(e)][0]) : undefined}
      >
        <polyline className="chart__line" points={polyline} fill="none" />
        {/* Crosshair at the hovered point's x (viewBox units, from `coords`), spanning full height. */}
        {interactive && hoverIndex !== null ? (
          <line
            className="chart__crosshair"
            x1={coords[hoverIndex].x}
            x2={coords[hoverIndex].x}
            y1={0}
            y2={HEIGHT}
          />
        ) : null}
      </svg>
      {/* Readout of the hovered point — the record date and its value through the caller's formatter
          (default `String`, never derived). role="status" announces it to assistive tech as the hover moves. */}
      {interactive && hoverIndex !== null ? (
        <div className="chart__readout" role="status" title={String(points[hoverIndex][1])}>
          {points[hoverIndex][0]} · {formatValue(points[hoverIndex][1])}
        </div>
      ) : null}
      <div className="chart__axis chart__axis--y">
        <span className="chart__label" title={String(maxValue)}>
          {formatValue(maxValue)}
        </span>
        <span className="chart__label" title={String(minValue)}>
          {formatValue(minValue)}
        </span>
      </div>
      <div className="chart__axis chart__axis--x">
        <span className="chart__label">{firstDate}</span>
        <span className="chart__label">{lastDate}</span>
      </div>
      {/* A static idle affordance (M13.7.5): tell the user the chart is clickable BEFORE they discover
          it by hovering. Shown only when the chart is actually interactive. */}
      {interactive ? (
        <p className="chart__hint">Click a point to inspect that session.</p>
      ) : null}
    </div>
  )
}
