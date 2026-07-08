import { describe, expect, it } from 'vitest'
import type { StrategyDocument } from '@quantize/quantize-ir'
import { addNode, newStrategyDocument, semanticKey, setNodeUi, setParams } from './store'

// `semanticKey` is a stable identity of the document's SEMANTIC content with every `ui.*` field
// excluded (invariant 1: ui round-trips but never affects semantics/equality). It is the handle the
// validity lifecycle keys on (D-7): a pure node MOVE must NOT change it; a real edit MUST.

function docWithNode() {
  const doc = addNode(newStrategyDocument('t'), {
    typeId: 'transform.trailing_return',
    typeVersion: '1.0.0',
    params: { lookback_sessions: 63 },
    position: { x: 0, y: 0 },
  })
  return { doc, nodeId: doc.nodes[0].id }
}

describe('semanticKey', () => {
  it('is invariant under a pure ui.position move (dragging a node)', () => {
    const { doc, nodeId } = docWithNode()
    const moved = setNodeUi(doc, nodeId, { position: { x: 999, y: 999 } })
    // The object changed (a new document), but the SEMANTIC content did not.
    expect(moved).not.toBe(doc)
    expect(semanticKey(moved)).toBe(semanticKey(doc))
  })

  it('changes when a param changes (a real semantic edit)', () => {
    const { doc, nodeId } = docWithNode()
    const edited = setParams(doc, nodeId, { lookback_sessions: 21 })
    expect(semanticKey(edited)).not.toBe(semanticKey(doc))
  })

  it('changes when a node is added', () => {
    const { doc } = docWithNode()
    const withMore = addNode(doc, {
      typeId: 'transform.rank',
      typeVersion: '1.0.0',
      params: {},
      position: { x: 200, y: 0 },
    })
    expect(semanticKey(withMore)).not.toBe(semanticKey(doc))
  })

  // The projection scope must MATCH the backend's `semantic_projection` (quantize/schema/semantics.py
  // `_without_ui`): only the NODE-INSTANCE `ui` field is dropped. `params` and `extensions` are open
  // semantic JSON, so a `ui` key nested INSIDE them is executable content and MUST affect the key.
  // Dropping every `ui` at any depth (the old replacer) would leave a stale validity badge after a
  // real semantic mutation.

  it('CHANGES when params.ui changes (params is open semantic JSON — the backend keeps it)', () => {
    const { doc, nodeId } = docWithNode()
    const base = setParams(doc, nodeId, { lookback_sessions: 63 })
    const withParamsUi = setParams(doc, nodeId, { lookback_sessions: 63, ui: { note: 'x' } })
    expect(semanticKey(withParamsUi)).not.toBe(semanticKey(base))
  })

  it('CHANGES when extensions.ui changes (extensions is open semantic JSON — the backend keeps it)', () => {
    const { doc, nodeId } = docWithNode()
    const withExtUi = withNodeExtensions(doc, nodeId, { ui: { note: 'x' } })
    expect(semanticKey(withExtUi)).not.toBe(semanticKey(doc))
  })

  it('CHANGES when a nested semantic value inside params changes', () => {
    const { doc, nodeId } = docWithNode()
    const a = setParams(doc, nodeId, { window: { ui: { size: 1 } } })
    const b = setParams(doc, nodeId, { window: { ui: { size: 2 } } })
    expect(semanticKey(b)).not.toBe(semanticKey(a))
  })

  it('CHANGES when a nested semantic value inside extensions changes', () => {
    const { doc, nodeId } = docWithNode()
    const a = withNodeExtensions(doc, nodeId, { ui: { size: 1 } })
    const b = withNodeExtensions(doc, nodeId, { ui: { size: 2 } })
    expect(semanticKey(b)).not.toBe(semanticKey(a))
  })
})

// Set a node's `extensions` (no store reducer exists — construct verbatim, preserving every other
// field), so tests can exercise the `extensions.ui` projection boundary.
function withNodeExtensions(
  doc: StrategyDocument,
  nodeId: string,
  extensions: NonNullable<StrategyDocument['nodes'][number]['extensions']>,
): StrategyDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === nodeId ? { ...node, extensions } : node)),
  }
}
