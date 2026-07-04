import { describe, expect, it } from 'vitest'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { toFlow } from './flow'

function makeDoc(): StrategyDocument {
  return {
    schema_version: '0.1.0',
    strategy: {
      id: '11111111-1111-1111-1111-111111111111',
      version: 1,
      name: 'Flow fixture',
      provenance: {
        owner: '22222222-2222-2222-2222-222222222222',
        creator: '22222222-2222-2222-2222-222222222222',
        contributors: [],
        visibility: 'private',
        duplicable: false,
        created_at: '2026-06-23T00:00:00Z',
      },
    },
    execution_policy: {
      policy: 'close_signal_next_session_open',
      valuation: 'session_close',
      transaction_costs: { model: 'bps', bps: 0 },
    },
    schedule: { kind: 'daily' },
    nodes: [
      {
        id: 'ret',
        type_id: 'transform.trailing_return',
        type_version: '1.0.0',
        params: {},
        ui: { position: { x: 10, y: 20 } },
      },
      // No ui → must get a deterministic grid position.
      { id: 'rk', type_id: 'transform.rank', type_version: '1.0.0', params: {} },
    ],
    edges: [{ from: ['ret', 'values'], to: ['rk', 'values'] }],
    component_refs: [],
  }
}

describe('toFlow', () => {
  it('maps every IR node and edge', () => {
    const { nodes, edges } = toFlow(makeDoc())
    expect(nodes).toHaveLength(2)
    expect(edges).toHaveLength(1)
  })

  it('reads position from ui.position and carries typeId in data', () => {
    const { nodes } = toFlow(makeDoc())
    expect(nodes[0].id).toBe('ret')
    expect(nodes[0].position).toEqual({ x: 10, y: 20 })
    expect(nodes[0].data.typeId).toBe('transform.trailing_return')
  })

  it('default-positions nodes lacking ui.position on a deterministic grid', () => {
    const { nodes } = toFlow(makeDoc())
    // Index 1, grid { x: (i%4)*220, y: floor(i/4)*140 } → { x: 220, y: 0 }.
    expect(nodes[1].position).toEqual({ x: 220, y: 0 })
  })

  it('derives edge id, source/target and handles from from/to', () => {
    const { edges } = toFlow(makeDoc())
    const e = edges[0]
    expect(e.id).toBe('ret:values->rk:values#0')
    expect(e.source).toBe('ret')
    expect(e.target).toBe('rk')
    expect(e.sourceHandle).toBe('values')
    expect(e.targetHandle).toBe('values')
  })

  it('gives structurally-identical edges distinct RF ids (unique React keys)', () => {
    const doc = makeDoc()
    // A loaded doc could carry two identical {from,to} edges; the derived ids must still differ.
    const twin = doc.edges[0]
    const withDup = { ...doc, edges: [twin, { from: twin.from, to: twin.to }] }
    const { edges } = toFlow(withDup)
    expect(edges[0].id).not.toBe(edges[1].id)
    expect(new Set(edges.map((e) => e.id)).size).toBe(2)
  })

  it('is read-only — never mutates the doc', () => {
    const doc = makeDoc()
    const before = JSON.parse(JSON.stringify(doc))
    toFlow(doc)
    expect(JSON.parse(JSON.stringify(doc))).toEqual(before)
  })
})
