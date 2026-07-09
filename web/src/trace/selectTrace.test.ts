// selectTrace: the pure gating that prevents a previous session's trees from rendering under a new
// cursor/run (P2). The stale-frame case — a fetch tagged with the OLD (run, session) while the
// selection has already moved — is the load-bearing assertion: it must read as loading, never expose
// the old trees.
import { describe, expect, it } from 'vitest'
import type { TraceTreeDto } from '@quantize/quantize-api'
import { selectTrace } from './selectTrace'
import type { TaggedTrace } from './selectTrace'

const AXIS = ['2026-05-14', '2026-05-15', '2026-05-16']

function tree(instant: string): TraceTreeDto {
  return { run_id: 'run-1', instant, roots: [] }
}

describe('selectTrace', () => {
  it('exposes trees when the fetch tag matches the current run + cursor', () => {
    const fetch: TaggedTrace = { runId: 'run-1', sessionDate: '2026-05-15', trees: [tree('i')] }
    expect(selectTrace(fetch, 'run-1', '2026-05-15', AXIS)).toEqual({
      trees: [tree('i')],
      loading: false,
      error: undefined,
    })
  })

  it('exposes a matching empty result as trees:[] (evaluated-but-traceless), not loading', () => {
    const fetch: TaggedTrace = { runId: 'run-1', sessionDate: '2026-05-15', trees: [] }
    expect(selectTrace(fetch, 'run-1', '2026-05-15', AXIS)).toEqual({
      trees: [],
      loading: false,
      error: undefined,
    })
  })

  it('exposes a matching error and no trees/loading', () => {
    const fetch: TaggedTrace = { runId: 'run-1', sessionDate: '2026-05-15', error: 'boom' }
    expect(selectTrace(fetch, 'run-1', '2026-05-15', AXIS)).toEqual({
      trees: undefined,
      loading: false,
      error: 'boom',
    })
  })

  it('HIDES a stale session fetch under a new cursor and reads as loading (P2)', () => {
    // Fetch settled for 2026-05-14; the cursor has since moved to 2026-05-15 (still on axis). The old
    // session's trees must NOT be exposed — the fresh fetch is in flight, so this is a loading state.
    const stale: TaggedTrace = { runId: 'run-1', sessionDate: '2026-05-14', trees: [tree('old')] }
    expect(selectTrace(stale, 'run-1', '2026-05-15', AXIS)).toEqual({
      trees: undefined,
      loading: true,
      error: undefined,
    })
  })

  it('HIDES a previous run fetch under a new run (P2)', () => {
    const priorRun: TaggedTrace = { runId: 'run-0', sessionDate: '2026-05-15', trees: [tree('old')] }
    expect(selectTrace(priorRun, 'run-1', '2026-05-15', AXIS)).toEqual({
      trees: undefined,
      loading: true,
      error: undefined,
    })
  })

  it('does NOT show loading for a cursor off the current run axis (transient run switch)', () => {
    // During a run switch the cursor may briefly hold a date not on the new run's axis; the effect
    // does not fetch for it, so it must not read as an endless loading state.
    const fetch: TaggedTrace = { runId: 'run-0', sessionDate: '2025-01-01', trees: [tree('old')] }
    expect(selectTrace(fetch, 'run-1', '2025-01-01', AXIS)).toEqual({
      trees: undefined,
      loading: false,
      error: undefined,
    })
  })

  it('is empty (not loading) with no run or no cursor', () => {
    expect(selectTrace(undefined, undefined, null, [])).toEqual({
      trees: undefined,
      loading: false,
      error: undefined,
    })
    expect(selectTrace(undefined, 'run-1', null, AXIS)).toEqual({
      trees: undefined,
      loading: false,
      error: undefined,
    })
  })
})
