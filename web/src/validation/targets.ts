// Structured highlight targets for validation diagnostics (M13.4 layering fix).
//
// A diagnostic's highlight target is computed PURELY from its location (`loc` / `node_path`) — NEVER
// from its message. These helpers are the single owner of that structural mapping. They live in a
// small non-component module so both the pure badge projection (`validity.ts`) and the diagnostics
// panel (`components/ValidatePanel.tsx`) can import them without the projection depending on a UI
// component (which would reverse the layering).

/**
 * A structured highlight target computed from a diagnostic's location — never from its message.
 * `nodeIndex`/`edgeIndex` come from a `loc` path (structural/semantic); `nodeId` from a runtime
 * `node_path[0]`. The App resolves an index against the current document to pick the entity.
 */
export type HighlightTarget =
  | { kind: 'nodeIndex'; index: number }
  | { kind: 'edgeIndex'; index: number }
  | { kind: 'nodeId'; nodeId: string }

/** Target for a `loc`-located diagnostic (structural/semantic): `("nodes"|"edges", index, ...)`. */
export function locTarget(loc: (string | number)[]): HighlightTarget | undefined {
  if (loc.length >= 2 && typeof loc[1] === 'number') {
    if (loc[0] === 'nodes') {
      return { kind: 'nodeIndex', index: loc[1] }
    }
    if (loc[0] === 'edges') {
      return { kind: 'edgeIndex', index: loc[1] }
    }
  }
  return undefined
}

/** Target for a runtime diagnostic: the top of its execution `node_path` is a node id. */
export function nodePathTarget(nodePath: string[]): HighlightTarget | undefined {
  return nodePath.length > 0 ? { kind: 'nodeId', nodeId: nodePath[0] } : undefined
}
