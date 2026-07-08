import { describe, expect, it } from 'vitest'
import { locTarget, nodePathTarget } from './targets'

// The structural mapping is computed PURELY from `loc` / `node_path` (never the message). These are
// the same helpers the panel and the badge projection share; this pins their behavior directly.

describe('locTarget', () => {
  it('maps a nodes loc to a node index', () => {
    expect(locTarget(['nodes', 1, 'params'])).toEqual({ kind: 'nodeIndex', index: 1 })
  })

  it('maps an edges loc to an edge index', () => {
    expect(locTarget(['edges', 0])).toEqual({ kind: 'edgeIndex', index: 0 })
  })

  it('is undefined when the loc has no numeric index or an unknown head', () => {
    expect(locTarget(['nodes'])).toBeUndefined()
    expect(locTarget(['schedule', 'kind'])).toBeUndefined()
  })
})

describe('nodePathTarget', () => {
  it('maps the head of a runtime node_path to a node id', () => {
    expect(nodePathTarget(['nA', 'inner'])).toEqual({ kind: 'nodeId', nodeId: 'nA' })
  })

  it('is undefined for an empty node_path', () => {
    expect(nodePathTarget([])).toBeUndefined()
  })
})
