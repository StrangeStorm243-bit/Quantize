// SvgLineChart: the pure point-mapping (`chartPoints`) is scaling-for-display ONLY — it maps values
// to SVG coordinates, it computes no metric. Empty and singleton inputs degrade gracefully.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SvgLineChart, chartPoints } from './SvgLineChart'

describe('chartPoints', () => {
  it('scales x by index across width and inverts y across [min,max]', () => {
    // min 0, max 10, range 10; width 100, height 20. Highest value maps to the TOP (y=0).
    expect(chartPoints([0, 5, 10], 100, 20)).toEqual([
      { x: 0, y: 20 },
      { x: 50, y: 10 },
      { x: 100, y: 0 },
    ])
  })

  it('returns an empty array for no values', () => {
    expect(chartPoints([], 100, 20)).toEqual([])
  })

  it('centres a singleton (no range to scale over)', () => {
    expect(chartPoints([42], 100, 20)).toEqual([{ x: 50, y: 10 }])
  })

  it('places a flat series (zero range) along the vertical middle', () => {
    expect(chartPoints([7, 7, 7], 100, 20)).toEqual([
      { x: 0, y: 10 },
      { x: 50, y: 10 },
      { x: 100, y: 10 },
    ])
  })
})

describe('SvgLineChart', () => {
  it('renders min/max value labels and first/last date labels from the points', () => {
    render(
      <SvgLineChart
        points={[
          ['2025-07-31', 1_000_000],
          ['2025-08-29', 1_050_000],
        ]}
      />,
    )
    // Value axis labels are the raw min/max (formatted for display, never derived).
    expect(screen.getByText('2025-07-31')).toBeInTheDocument()
    expect(screen.getByText('2025-08-29')).toBeInTheDocument()
    expect(screen.getByText(/1050000/)).toBeInTheDocument()
    expect(screen.getByText(/1000000/)).toBeInTheDocument()
  })

  it('renders a placeholder for an empty series (no polyline)', () => {
    const { container } = render(<SvgLineChart points={[]} />)
    expect(container.querySelector('polyline')).toBeNull()
  })
})
