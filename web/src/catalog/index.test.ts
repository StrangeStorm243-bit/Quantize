import { describe, expect, it } from 'vitest'
import type { NodeCatalogResponse } from '@quantize/quantize-api'
import catalogJson from '../../../tests/goldens/node_catalog.json'
import {
  buildCompatibilitySet,
  defaultParamsFor,
  isAllowed,
  labelOf,
  nodeTypeById,
  paletteGroups,
  portTypeKey,
  type PortType,
} from './index'

// The REAL catalog payload, imported straight from the committed golden
// (tests/goldens/node_catalog.json) so the test tracks the true contract byte-for-byte.
const catalog = catalogJson as unknown as NodeCatalogResponse

describe('portTypeKey', () => {
  it('is stable and distinguishes dtypes', () => {
    expect(portTypeKey({ kind: 'AssetSet' })).toBe('AssetSet')
    expect(portTypeKey({ kind: 'PortfolioTargets' })).toBe('PortfolioTargets')
    expect(portTypeKey({ kind: 'Scalar', dtype: 'Number' })).toBe('Scalar:Number')
    expect(portTypeKey({ kind: 'Scalar', dtype: 'Integer' })).toBe('Scalar:Integer')
    // Same kind, different dtype → different key.
    expect(portTypeKey({ kind: 'CrossSection', dtype: 'Number' })).not.toBe(
      portTypeKey({ kind: 'CrossSection', dtype: 'Boolean' }),
    )
  })
})

describe('isAllowed / buildCompatibilitySet', () => {
  it('accepts every one of the golden compatibility pairs', () => {
    const set = buildCompatibilitySet(catalog)
    expect(catalog.compatibility).toHaveLength(9)
    for (const pair of catalog.compatibility) {
      expect(isAllowed(set, pair.source, pair.destination)).toBe(true)
    }
  })

  it('rejects a known-bad pair (TimeSeries[Number] → CrossSection[Number])', () => {
    const set = buildCompatibilitySet(catalog)
    const src: PortType = { kind: 'TimeSeries', dtype: 'Number' }
    const dst: PortType = { kind: 'CrossSection', dtype: 'Number' }
    expect(isAllowed(set, src, dst)).toBe(false)
  })

  it('accepts the Integer→Number Scalar widening but rejects the reverse', () => {
    const set = buildCompatibilitySet(catalog)
    expect(
      isAllowed(set, { kind: 'Scalar', dtype: 'Integer' }, { kind: 'Scalar', dtype: 'Number' }),
    ).toBe(true)
    expect(
      isAllowed(set, { kind: 'Scalar', dtype: 'Number' }, { kind: 'Scalar', dtype: 'Integer' }),
    ).toBe(false)
  })
})

describe('paletteGroups', () => {
  it('yields the expected namespace groups covering all 13 node types', () => {
    const groups = paletteGroups(catalog)
    expect(groups.map((g) => g.group)).toEqual([
      'data',
      'logic',
      'output',
      'portfolio',
      'risk',
      'transform',
      'universe',
    ])
    const total = groups.reduce((n, g) => n + g.nodeTypes.length, 0)
    expect(total).toBe(13)
    expect(catalog.node_types).toHaveLength(13)
  })
})

describe('defaultParamsFor', () => {
  it('seeds a property that declares a default (transform.rank → {descending: true})', () => {
    const rank = nodeTypeById(catalog, 'transform.rank')
    expect(rank).toBeDefined()
    expect(defaultParamsFor(rank!)).toEqual({ descending: true })
  })

  it('omits properties without a default (transform.moving_average → {})', () => {
    const ma = nodeTypeById(catalog, 'transform.moving_average')
    expect(ma).toBeDefined()
    expect(defaultParamsFor(ma!)).toEqual({})
  })

  it('returns {} when the schema has no properties (data.price)', () => {
    const price = nodeTypeById(catalog, 'data.price')
    expect(price).toBeDefined()
    expect(defaultParamsFor(price!)).toEqual({})
  })
})

describe('labelOf', () => {
  it('returns the golden labels for lattice types', () => {
    expect(labelOf(catalog, { kind: 'AssetSet' })).toBe('AssetSet')
    expect(labelOf(catalog, { kind: 'PortfolioTargets' })).toBe('PortfolioTargets')
    expect(labelOf(catalog, { kind: 'Scalar', dtype: 'Number' })).toBe('Scalar[Number]')
    expect(labelOf(catalog, { kind: 'CrossSection', dtype: 'Boolean' })).toBe('CrossSection[Boolean]')
    expect(labelOf(catalog, { kind: 'TimeSeries', dtype: 'Number' })).toBe('TimeSeries[Number]')
  })
})
