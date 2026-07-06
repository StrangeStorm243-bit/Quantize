// A hand-rolled SVG line chart for a run's portfolio `valuations` (M11.6, D9). NO chart library.
//
// This is PURE PRESENTATION: it SCALES the already-computed valuations to pixel coordinates so they
// can be drawn — it derives no metric (returns/drawdown/PnL all live in the record, invariant 5).
// `chartPoints` is the extracted, unit-tested mapping; the component only draws its output.
import type { ReactElement } from 'react'

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
}

export function SvgLineChart({ points }: SvgLineChartProps): ReactElement {
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

  return (
    <div className="chart">
      <svg
        className="chart__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="portfolio value over time"
      >
        <polyline className="chart__line" points={polyline} fill="none" />
      </svg>
      <div className="chart__axis chart__axis--y">
        <span className="chart__label">{maxValue}</span>
        <span className="chart__label">{minValue}</span>
      </div>
      <div className="chart__axis chart__axis--x">
        <span className="chart__label">{firstDate}</span>
        <span className="chart__label">{lastDate}</span>
      </div>
    </div>
  )
}
