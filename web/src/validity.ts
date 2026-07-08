// Node-validity projection (M13.4, D-7) — pure presentation of server diagnostics (invariant 5, no
// judging). A verdict is STAMPED with the semantic key it was validated against; badges render only
// while that key still matches the current document, so an ok verdict can NEVER re-badge a
// since-changed graph green (the strict "no stale green" rule holds at render time, not via an
// effect). A valid document badges every node `valid`; an invalid one badges ONLY the nodes a
// diagnostic targets `error` — targets computed STRUCTURALLY (`loc` → node index; runtime
// `node_path[0]` → node id), never by parsing a message.
import type { ValidateResponse } from '@quantize/quantize-api'
import type { StrategyDocument } from '@quantize/quantize-ir'
import type { NodeValidity } from './document/flow'
import { locTarget, nodePathTarget } from './validation/targets'

/** A validation verdict paired with the semantic key of the document it was validated against. */
export interface StampedVerdict {
  verdict: ValidateResponse
  key: string
}

export function computeNodeValidity(
  stamped: StampedVerdict | undefined,
  doc: StrategyDocument,
  docKey: string,
): Map<string, NodeValidity> {
  const map = new Map<string, NodeValidity>()
  // No verdict, or a verdict for DIFFERENT semantics than the doc now shows → no badges. The key
  // check is what forbids a stale green after any semantic edit.
  if (stamped === undefined || stamped.key !== docKey) {
    return map
  }
  const { verdict } = stamped
  if (verdict.ok) {
    for (const node of doc.nodes) {
      map.set(node.id, 'valid')
    }
    return map
  }
  const flagByLoc = (loc: (string | number)[]): void => {
    const target = locTarget(loc)
    if (target?.kind === 'nodeIndex') {
      const node = doc.nodes[target.index]
      if (node !== undefined) {
        map.set(node.id, 'error')
      }
    }
  }
  for (const d of verdict.structural) {
    flagByLoc(d.loc)
  }
  for (const d of verdict.semantic) {
    flagByLoc(d.loc)
  }
  for (const d of verdict.runtime) {
    const target = nodePathTarget(d.node_path)
    if (target?.kind === 'nodeId') {
      map.set(target.nodeId, 'error')
    }
  }
  return map
}
