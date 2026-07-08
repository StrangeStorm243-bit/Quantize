import { describe, expect, it } from 'vitest'
import type { ValidateResponse } from '@quantize/quantize-api'
import { addNode, newStrategyDocument, semanticKey, setNodeUi, setParams } from './document/store'
import { computeNodeValidity } from './validity'

function twoNodeDoc() {
  let doc = newStrategyDocument('t')
  doc = addNode(doc, { typeId: 'transform.trailing_return', typeVersion: '1.0.0', params: {}, position: { x: 0, y: 0 } })
  doc = addNode(doc, { typeId: 'transform.rank', typeVersion: '1.0.0', params: {}, position: { x: 200, y: 0 } })
  return { doc, key: semanticKey(doc), a: doc.nodes[0].id, b: doc.nodes[1].id }
}

const OK: ValidateResponse = { ok: true, structural: [], semantic: [], runtime: [], warmup_sessions: 3 }

describe('computeNodeValidity', () => {
  it('returns an empty map with no verdict (no badges before validation)', () => {
    const { doc, key } = twoNodeDoc()
    expect(computeNodeValidity(undefined, doc, key).size).toBe(0)
  })

  it('badges every node valid when the verdict is ok and its key matches the current doc', () => {
    const { doc, key, a, b } = twoNodeDoc()
    const map = computeNodeValidity({ verdict: OK, key }, doc, key)
    expect(map.get(a)).toBe('valid')
    expect(map.get(b)).toBe('valid')
  })

  it('NEVER shows a stale green: a verdict stamped with a DIFFERENT key yields no badges (D-7)', () => {
    const { doc, key } = twoNodeDoc()
    // An ok verdict validated against an older semantic key must not badge the changed document.
    const map = computeNodeValidity({ verdict: OK, key: 'stale-key' }, doc, key)
    expect(map.size).toBe(0)
  })

  it('badges only the diagnostic-targeted nodes error when the verdict is invalid (key matches)', () => {
    const { doc, key, a, b } = twoNodeDoc()
    const verdict: ValidateResponse = {
      ok: false,
      structural: [{ code: 'bad', message: 'm', loc: ['nodes', 1], subject: 'n1' }],
      semantic: [],
      runtime: [{ code: 'rt', message: 'm', node_path: [a], subject: a }],
    }
    const map = computeNodeValidity({ verdict, key }, doc, key)
    expect(map.get(b)).toBe('error') // structural loc → node index 1
    expect(map.get(a)).toBe('error') // runtime node_path[0] → node id
  })

  // The frontend projection scope matches the backend (`_without_ui` strips only node-level `ui`), so a
  // mutation of `params.ui` / `extensions.ui` — open semantic JSON — changes the doc key and CLEARS the
  // prior verdict's badges. A pure node-level `ui` move (layout only) does NOT.

  it('CLEARS badges after a params.ui mutation (a real semantic change)', () => {
    const { doc, key, a } = twoNodeDoc()
    // A valid verdict badges the node green while its stamped key matches the current doc.
    expect(computeNodeValidity({ verdict: OK, key }, doc, key).get(a)).toBe('valid')
    // Editing params.ui is a semantic mutation: the doc key changes, so the old verdict yields no badges.
    const edited = setParams(doc, a, { ui: { note: 'x' } })
    const editedKey = semanticKey(edited)
    expect(computeNodeValidity({ verdict: OK, key }, edited, editedKey).size).toBe(0)
  })

  it('CLEARS badges after an extensions.ui mutation (a real semantic change)', () => {
    const { doc, key, a } = twoNodeDoc()
    expect(computeNodeValidity({ verdict: OK, key }, doc, key).get(a)).toBe('valid')
    const edited: typeof doc = {
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === a ? { ...n, extensions: { ui: { note: 'x' } } } : n)),
    }
    const editedKey = semanticKey(edited)
    expect(computeNodeValidity({ verdict: OK, key }, edited, editedKey).size).toBe(0)
  })

  it('KEEPS badges after a pure node-level ui.position move (layout only, D-7)', () => {
    const { doc, key, a, b } = twoNodeDoc()
    const moved = setNodeUi(doc, a, { position: { x: 999, y: 999 } })
    const movedKey = semanticKey(moved)
    // The key is unchanged by a pure move, so the verdict still applies and the badges survive.
    const map = computeNodeValidity({ verdict: OK, key }, moved, movedKey)
    expect(map.get(a)).toBe('valid')
    expect(map.get(b)).toBe('valid')
  })
})
