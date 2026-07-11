// SvgLineChart: the pure point-mapping (`chartPoints`) is scaling-for-display ONLY — it maps values
// to SVG coordinates, it computes no metric. Empty and singleton inputs degrade gracefully. The
// optional interactivity (M13.7) maps a pixel x to a point INDEX and reports the SERVER value/date at
// that index verbatim — it derives no number (invariant 5).
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('SvgLineChart interactivity (M13.7)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Pin the svg's on-screen box so a clientX maps to a deterministic point index. With two points
  // (length-1 === 1) a width-100 box maps clientX 0 → index 0 and clientX 100 → index 1.
  function mockRect(width: number, left = 0): void {
    vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: left,
      y: 0,
      width,
      height: 120,
      top: 0,
      left,
      right: left + width,
      bottom: 120,
      toJSON: () => ({}),
    })
  }

  // A FRACTIONAL second value so the verbatim-value assertion is a real tripwire: any toFixed(0) /
  // round-to-integer regression would drop the ".5" and fail.
  const twoPoints: [string, number][] = [
    ['2025-07-31', 1_000_000],
    ['2025-08-29', 1_050_000.5],
  ]

  it('shows a readout with the nearest point date + its VERBATIM value on mousemove', () => {
    mockRect(100)
    const { container } = render(<SvgLineChart points={twoPoints} onSelectPoint={() => {}} />)
    const svg = container.querySelector('svg')!
    // clientX 100 over a width-100 box → frac 1 → nearest index 1 → the SECOND point.
    fireEvent.mouseMove(svg, { clientX: 100 })
    const readout = screen.getByRole('status')
    expect(readout).toHaveTextContent('2025-08-29')
    // The value is the raw record number serialized with String(...) — the EXACT fractional string, not
    // a toFixed / rounded / derived form.
    expect(readout).toHaveTextContent('1050000.5')
    // A crosshair line is drawn while hovering.
    expect(container.querySelector('.chart__crosshair')).not.toBeNull()
  })

  it('calls onSelectPoint with the nearest SERVER date on click', () => {
    mockRect(100)
    const onSelectPoint = vi.fn()
    const { container } = render(<SvgLineChart points={twoPoints} onSelectPoint={onSelectPoint} />)
    const svg = container.querySelector('svg')!
    // clientX 0 → frac 0 → nearest index 0 → the FIRST point's date, verbatim.
    fireEvent.click(svg, { clientX: 0 })
    expect(onSelectPoint).toHaveBeenCalledWith('2025-07-31')
    // clientX 100 → index 1 → the last point's date.
    fireEvent.click(svg, { clientX: 100 })
    expect(onSelectPoint).toHaveBeenCalledWith('2025-08-29')
  })

  it('does not crash when the series shrinks below a stale hover index (in-place rerender)', () => {
    mockRect(100)
    const { container, rerender } = render(
      <SvgLineChart points={twoPoints} onSelectPoint={() => {}} />,
    )
    const svg = container.querySelector('svg')!
    // Hover the LAST point (index 1) so the stored hover index is 1.
    fireEvent.mouseMove(svg, { clientX: 100 })
    expect(container.querySelector('.chart__crosshair')).not.toBeNull()
    // Re-render the SAME component (unkeyed → hover useState persists) with a SHORTER 1-point series.
    // The stored index 1 is now out of bounds; the render-time clamp must drop it rather than throw.
    expect(() =>
      rerender(<SvgLineChart points={[['2025-07-31', 1_000_000]]} onSelectPoint={() => {}} />),
    ).not.toThrow()
    // The now-invalid hover index yields no crosshair/readout until the next mousemove.
    expect(container.querySelector('.chart__crosshair')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows an idle click affordance (a static hint + an interactive-marked svg) when interactive', () => {
    // The clickability must be visible BEFORE hover-discovery (M13.7.5): a static hint, plus a class so
    // CSS can give the svg a pointer cursor / hover tint.
    const { container } = render(<SvgLineChart points={twoPoints} onSelectPoint={() => {}} />)
    expect(screen.getByText(/click a point/i)).toBeInTheDocument()
    expect(container.querySelector('.chart__svg--interactive')).not.toBeNull()
  })

  it('shows NO click affordance when not interactive', () => {
    const { container } = render(<SvgLineChart points={twoPoints} />)
    expect(screen.queryByText(/click a point/i)).toBeNull()
    expect(container.querySelector('.chart__svg--interactive')).toBeNull()
  })

  it('is inert without onSelectPoint: no readout, no crosshair, and mousemove does not throw', () => {
    const { container } = render(<SvgLineChart points={twoPoints} />)
    const svg = container.querySelector('svg')!
    expect(() => fireEvent.mouseMove(svg, { clientX: 50 })).not.toThrow()
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('.chart__crosshair')).toBeNull()
  })
})
