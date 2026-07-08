import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LIVE_CATEGORIES, RESERVED_CATEGORIES } from '../catalog/colors'
import { CategoryIcon } from './categories'

// The icon set is inline SVG (no icon-font, no external dependency — D-9). Every authored category
// (live + reserved) has a glyph; an unknown/future category still renders a (neutral) glyph, never a
// crash or a hole. Icons are decorative — the accessible name is the node's text label — so each is
// `aria-hidden`.

describe('CategoryIcon', () => {
  it.each([...LIVE_CATEGORIES, ...RESERVED_CATEGORIES])('renders an svg glyph for %s', (category) => {
    const { container } = render(<CategoryIcon category={category} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders a glyph for an unknown/future category (never a hole)', () => {
    const { container } = render(<CategoryIcon category="quantum_teleportation" />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('forwards a className onto the svg so callers can size/color it', () => {
    const { container } = render(<CategoryIcon category="data" className="snode__icon" />)
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('snode__icon')
  })
})
