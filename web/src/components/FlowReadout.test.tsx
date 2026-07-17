// The flow readout's digest is a PURE projection of a served `value_summary` (the discriminated union)
// into a token list — the one-line canvas summary the M14.3 edge hover renders. These tests pin the
// verbatim-number rule (D-27): a token carries `value` IFF it displays a potentially-lossy fmtValue-
// formatted served float (the scalar Number, min/max, weight_sum, cash) — each such number its OWN
// token; every INTEGER count (members, present/domain, true/false, target/asset/point counts) embeds in
// prose as String(count), lossless by construction, so those tokens carry NO value. Nothing here sums,
// ranks, or compares across values (CLAUDE.md invariant 5) — the projection only reads served fields.
import { describe, expect, it } from 'vitest'
import type {
  AssetSetSummaryDto,
  CrossSectionSummaryDto,
  PortfolioTargetsSummaryDto,
  ScalarSummaryDto,
  TimeSeriesSummaryDto,
} from '@quantize/quantize-api'
import { flowDigest } from './FlowReadout'

// The ` · `-joined visible line, mirroring how the (later) component renders the token texts.
function line(summary: Parameters<typeof flowDigest>[0]): string {
  return flowDigest(summary)
    .map((t) => t.text)
    .join(' · ')
}

describe('flowDigest — scalar', () => {
  it('Number: dtype token + a lossy value token carrying the raw served float', () => {
    const summary: ScalarSummaryDto = { kind: 'scalar', dtype: 'Number', value: 0.5 }
    expect(flowDigest(summary)).toEqual([{ text: 'Number' }, { text: '0.5', value: 0.5 }])
    expect(line(summary)).toBe('Number · 0.5')
  })

  it('Number: a 17-digit float displays through fmtValue while the value token keeps the raw number', () => {
    const summary: ScalarSummaryDto = { kind: 'scalar', dtype: 'Number', value: 0.025015130971708377 }
    expect(flowDigest(summary)).toEqual([
      { text: 'Number' },
      { text: '0.025', value: 0.025015130971708377 },
    ])
  })

  it('Integer: the count-valued scalar is still a served number → its value token carries it', () => {
    const summary: ScalarSummaryDto = { kind: 'scalar', dtype: 'Integer', value: 126 }
    expect(flowDigest(summary)).toEqual([{ text: 'Integer' }, { text: '126', value: 126 }])
    expect(line(summary)).toBe('Integer · 126')
  })

  it('Boolean: value displays verbatim (true/false) with NO value key — a boolean is never lossy', () => {
    const summary: ScalarSummaryDto = { kind: 'scalar', dtype: 'Boolean', value: true }
    const tokens = flowDigest(summary)
    expect(tokens).toEqual([{ text: 'Boolean' }, { text: 'true' }])
    // Pin the ABSENCE of the value key explicitly (not merely `value === undefined`).
    expect('value' in tokens[1]!).toBe(false)
  })
})

describe('flowDigest — asset_set', () => {
  it('lists the members, the count embedded as exactly String(count)', () => {
    const summary: AssetSetSummaryDto = { kind: 'asset_set', count: 3, members: ['IWM', 'QQQ', 'SPY'] }
    const tokens = flowDigest(summary)
    expect(tokens).toEqual([{ text: '3 members' }, { text: 'IWM, QQQ, SPY' }])
    expect(tokens[0]!.text).toContain(String(summary.count))
  })

  it('caps the members token at the first 4 + an ellipsis (a render guard, not a comparison)', () => {
    const summary: AssetSetSummaryDto = {
      kind: 'asset_set',
      count: 6,
      members: ['IWM', 'QQQ', 'SPY', 'VTI', 'EFA', 'AGG'],
    }
    const tokens = flowDigest(summary)
    expect(tokens[0]).toEqual({ text: '6 members' })
    expect(tokens[0]!.text).toContain(String(summary.count))
    expect(tokens[1]).toEqual({ text: 'IWM, QQQ, SPY, VTI…' })
  })
})

describe('flowDigest — cross_section', () => {
  it('Number: present/domain prose + min/max label+value token pairs (each value carries the raw float)', () => {
    const summary: CrossSectionSummaryDto = {
      kind: 'cross_section',
      dtype: 'Number',
      present_count: 5,
      domain_count: 6,
      missing: ['XLF'],
      min: -0.04916057824719877,
      max: 0.22315234567890123,
    }
    expect(flowDigest(summary)).toEqual([
      { text: '5 of 6 assets' },
      { text: 'min' },
      { text: '-0.0492', value: -0.04916057824719877 },
      { text: 'max' },
      { text: '0.2232', value: 0.22315234567890123 },
    ])
    expect(line(summary)).toBe('5 of 6 assets · min · -0.0492 · max · 0.2232')
  })

  it('Number: null min/max → those label+value tokens are absent (present/domain still renders)', () => {
    const summary: CrossSectionSummaryDto = {
      kind: 'cross_section',
      dtype: 'Number',
      present_count: 0,
      domain_count: 6,
      missing: [],
      min: null,
      max: null,
    }
    expect(flowDigest(summary)).toEqual([{ text: '0 of 6 assets' }])
  })

  it('Boolean: present/domain prose + true/false counts embedded as String(count)', () => {
    const summary: CrossSectionSummaryDto = {
      kind: 'cross_section',
      dtype: 'Boolean',
      present_count: 5,
      domain_count: 6,
      missing: [],
      true_count: 3,
      false_count: 2,
    }
    const tokens = flowDigest(summary)
    expect(tokens).toEqual([{ text: '5 of 6 assets' }, { text: '3 true' }, { text: '2 false' }])
    expect(tokens[1]!.text).toContain(String(summary.true_count))
    expect(tokens[2]!.text).toContain(String(summary.false_count))
  })
})

describe('flowDigest — time_series', () => {
  it('assets + points prose (each a String count) + the window as its own token', () => {
    const summary: TimeSeriesSummaryDto = {
      kind: 'time_series',
      asset_count: 6,
      total_points: 810,
      window: { first_date: '2025-01-02', last_date: '2026-06-30' },
    }
    const tokens = flowDigest(summary)
    expect(tokens).toEqual([
      { text: '6 assets' },
      { text: '810 points' },
      { text: '2025-01-02 → 2026-06-30' },
    ])
    expect(tokens[0]!.text).toContain(String(summary.asset_count))
    expect(tokens[1]!.text).toContain(String(summary.total_points))
  })

  it('null window → the window token is absent', () => {
    const summary: TimeSeriesSummaryDto = {
      kind: 'time_series',
      asset_count: 0,
      total_points: 0,
      window: null,
    }
    expect(flowDigest(summary)).toEqual([{ text: '0 assets' }, { text: '0 points' }])
  })
})

describe('flowDigest — portfolio_targets', () => {
  it('target count prose + weights/cash label+value token pairs (each value carries the raw float)', () => {
    const summary: PortfolioTargetsSummaryDto = {
      kind: 'portfolio_targets',
      count: 3,
      weight_sum: 1,
      cash: 0,
    }
    const tokens = flowDigest(summary)
    expect(tokens).toEqual([
      { text: '3 targets' },
      { text: 'weights' },
      { text: '1', value: 1 },
      { text: 'cash' },
      { text: '0', value: 0 },
    ])
    expect(tokens[0]!.text).toContain(String(summary.count))
    expect(line(summary)).toBe('3 targets · weights · 1 · cash · 0')
  })
})
