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
  it('groups by served category in pipeline-stage order (not type_id namespace)', () => {
    const groups = paletteGroups(catalog)
    // The eight live categories in stage-rollup order (design W2) — NOT alphabetical, NOT namespace.
    expect(groups.map((g) => g.group)).toEqual([
      'universe',
      'data',
      'transform',
      'signal',
      'selection',
      'weighting',
      'risk',
      'output',
    ])
    const total = groups.reduce((n, g) => n + g.nodeTypes.length, 0)
    expect(total).toBe(13)
    expect(catalog.node_types).toHaveLength(13)
  })

  it('carries a human label per group and sorts node types by display name within a group', () => {
    const groups = paletteGroups(catalog)
    const selection = groups.find((g) => g.group === 'selection')
    expect(selection?.label).toBe('Rank & Select')
    // selection = {transform.rank "Rank", portfolio.select_top_n "Select Top N"} → sorted by name.
    expect(selection?.nodeTypes.map((n) => n.display_name)).toEqual(['Rank', 'Select Top N'])
  })

  it('appends unknown/reserved categories after the live ones, sorted', () => {
    const withUnknown: NodeCatalogResponse = {
      ...catalog,
      node_types: [
        ...catalog.node_types,
        { ...catalog.node_types[0], type_id: 'ml.classifier', category: 'ml' },
        { ...catalog.node_types[0], type_id: 'x.custom', category: 'zzz_custom' },
      ],
    }
    const order = paletteGroups(withUnknown).map((g) => g.group)
    // Live categories keep stage order; unknown ones ('ml', 'zzz_custom') append in sorted order.
    expect(order.slice(-2)).toEqual(['ml', 'zzz_custom'])
    expect(order.indexOf('output')).toBeLessThan(order.indexOf('ml'))
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
