import { describe, expect, it } from 'vitest'
import type { PortType } from './index'
import {
  categoryColorVar,
  categoryColor,
  LIVE_CATEGORIES,
  portColorVar,
  portColor,
  RESERVED_CATEGORIES,
} from './colors'

// The eight live categories and five reserved future categories each map to their OWN token; a truly
// unknown category (a future family with no assignment yet) falls back to the neutral token so it
// still renders. This is the frontend half of the "ceiling absorption" guarantee (M13.4).

describe('category colors', () => {
  it.each(LIVE_CATEGORIES)('maps live category %s to its own --cat token', (category) => {
    expect(categoryColorVar(category)).toBe(`--cat-${category}`)
    expect(categoryColor(category)).toBe(`var(--cat-${category})`)
  })

  it.each(RESERVED_CATEGORIES)('maps reserved category %s to its own distinct token', (category) => {
    expect(categoryColorVar(category)).toBe(`--cat-${category}`)
    expect(categoryColorVar(category)).not.toBe('--cat-neutral')
  })

  it('falls back to the neutral token for an unknown/future category', () => {
    expect(categoryColorVar('quantum_teleportation')).toBe('--cat-neutral')
    expect(categoryColor('quantum_teleportation')).toBe('var(--cat-neutral)')
  })

  it('assigns every live + reserved category a DISTINCT token (no collisions)', () => {
    const vars = [...LIVE_CATEGORIES, ...RESERVED_CATEGORIES].map(categoryColorVar)
    expect(new Set(vars).size).toBe(vars.length)
  })
})

describe('port-type colors', () => {
  const cases: { pt: PortType; token: string }[] = [
    { pt: { kind: 'Scalar', dtype: 'Number' }, token: '--port-scalar-number' },
    { pt: { kind: 'Scalar', dtype: 'Integer' }, token: '--port-scalar-integer' },
    { pt: { kind: 'Scalar', dtype: 'Boolean' }, token: '--port-scalar-boolean' },
    { pt: { kind: 'AssetSet' }, token: '--port-asset-set' },
    { pt: { kind: 'CrossSection', dtype: 'Number' }, token: '--port-cross-section-number' },
    { pt: { kind: 'CrossSection', dtype: 'Boolean' }, token: '--port-cross-section-boolean' },
    { pt: { kind: 'TimeSeries', dtype: 'Number' }, token: '--port-time-series-number' },
    { pt: { kind: 'PortfolioTargets' }, token: '--port-portfolio-targets' },
  ]

  it.each(cases)('maps $pt.kind to $token', ({ pt, token }) => {
    expect(portColorVar(pt)).toBe(token)
    expect(portColor(pt)).toBe(`var(${token})`)
  })

  it('falls back to the neutral port token for an unknown/future port type', () => {
    // A future `Matrix`/`Distribution` port the map does not yet know still renders (neutral).
    const future = { kind: 'Matrix' } as unknown as PortType
    expect(portColorVar(future)).toBe('--port-neutral')
    expect(portColor(future)).toBe('var(--port-neutral)')
  })
})
