// The flow readout's digest is a PURE projection of a served `value_summary` (the discriminated union)
// into a token list — the one-line canvas summary the M14.3 edge hover renders. These tests pin the
// verbatim-number rule (D-27): a token carries `value` IFF it displays a potentially-lossy fmtValue-
// formatted served float (the scalar Number, min/max, weight_sum, cash) — each such number its OWN
// token; every INTEGER count (members, present/domain, true/false, target/asset/point counts) embeds in
// prose as String(count), lossless by construction, so those tokens carry NO value. Nothing here sums,
// ranks, or compares across values (CLAUDE.md invariant 5) — the projection only reads served fields.
import { StrictMode, useLayoutEffect, useRef, type ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AssetSetSummaryDto,
  CrossSectionSummaryDto,
  NodeValueResponse,
  PortfolioTargetsSummaryDto,
  ScalarSummaryDto,
  TimeSeriesSummaryDto,
} from '@quantize/quantize-api'

// Stub ONLY getNodeValue; keep the rest of '../api/client' real — the readout renders the SERVED
// refusal message, so the real `ApiClientError` (which carries it) and `errorMessage` must survive.
// Mirrors the Inspector.values.test.tsx seam.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, getNodeValue: vi.fn() }
})

// eslint-disable-next-line import/first
import { ApiClientError, getNodeValue } from '../api/client'
// eslint-disable-next-line import/first
import { FlowReadout, flowDigest, HOVER_DWELL_MS, type FlowAddress, type FlowProbe } from './FlowReadout'

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

  it('omits the members token for an EMPTY set — no dangling separator (empty selection is a valid outcome)', () => {
    const summary: AssetSetSummaryDto = { kind: 'asset_set', count: 0, members: [] }
    expect(flowDigest(summary)).toEqual([{ text: '0 members' }])
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

// --- FlowReadout component: the dwell-gated, generation-tagged, UNCACHED value readout (M14.3) -----
// These tests pin the result-LIFETIME spec: a served value is bound to its exact activation
// (run|cursor|componentPath|nodeId|outputPort), so a stale result — the address left, the probe moved,
// or the same address re-hovered — can never render even ONE frame, and re-hovering always RECOMPUTES
// (no cache; §10.5). The mechanism is a render-phase generation tracker (the Canvas.tsx:442 prevViewKey
// pattern) + a dwell timer keyed on that generation; every guard below is load-bearing for correctness.

const asMock = () => vi.mocked(getNodeValue)

function probeOf(overrides: Partial<FlowProbe> = {}): FlowProbe {
  return { runId: 'run-1', cursor: '2026-05-15', evaluated: true, scheduleKind: undefined, ...overrides }
}

function addressOf(overrides: Partial<FlowAddress> = {}): FlowAddress {
  return { nodeId: 'x', componentPath: [], outputPort: 'values', sourceLabel: 'Trailing Return', ...overrides }
}

function response(overrides: Partial<NodeValueResponse> = {}): NodeValueResponse {
  return {
    node_id: 'x',
    component_path: [],
    output_port: 'values',
    session_date: '2026-05-15',
    provenance: { captured: false, dataset_fingerprint: 'fp-9f3c', run_id: 'run-1' },
    value_summary: { kind: 'scalar', dtype: 'Number', value: 0.5 },
    ...overrides,
  }
}

// A scalar-Number response whose digest reads simply "Number · <n>" — used to tell activations apart
// by a distinct served number (the value token's text).
function scalarResponse(value: number, overrides: Partial<NodeValueResponse> = {}): NodeValueResponse {
  return response({ value_summary: { kind: 'scalar', dtype: 'Number', value }, ...overrides })
}

// A hand-resolvable promise so a test can drive resolution ORDER (which activation's request settles
// first) independently of the dwell timers.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  asMock().mockReset()
})
afterEach(() => {
  // Restore real timers so a fake-timer test never leaks its clock (and any pending dwell) into the next.
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('FlowReadout — no-fetch gates', () => {
  // Cycle 1.
  it('renders nothing and never fetches when the address is null (no edge hovered)', () => {
    const { container } = render(<FlowReadout probe={probeOf()} address={null} pinned={false} />)
    expect(container.firstChild).toBeNull()
    expect(asMock()).not.toHaveBeenCalled()
  })

  // Cycle 2.
  it('renders the honest no-evaluation line for a non-evaluated session and never fetches', () => {
    render(
      <FlowReadout
        probe={probeOf({ evaluated: false, scheduleKind: 'monthly' })}
        address={addressOf()}
        pinned={false}
      />,
    )
    // The exact shared phrasing (document/schedule.noEvaluationLine) for a recognised monthly cadence.
    expect(
      screen.getByText('No evaluation this session — this strategy evaluates monthly.'),
    ).toBeInTheDocument()
    expect(asMock()).not.toHaveBeenCalled()
  })
})

describe('FlowReadout — dwell gating', () => {
  // Cycle 3.
  it('waits the dwell before fetching, then fires exactly one request with the exact address shape', async () => {
    vi.useFakeTimers()
    asMock().mockResolvedValue(response())
    render(
      <FlowReadout probe={probeOf()} address={addressOf({ componentPath: ['r1'] })} pinned={false} />,
    )
    // A hair before the dwell elapses: no request has left.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS - 1)
    })
    expect(asMock()).not.toHaveBeenCalled()
    // At the dwell boundary: exactly one request, with the exact (runId, address) shape.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(asMock()).toHaveBeenCalledTimes(1)
    expect(asMock().mock.calls[0]).toEqual([
      'run-1',
      { nodeId: 'x', sessionDate: '2026-05-15', componentPath: ['r1'], outputPort: 'values' },
    ])
  })

  // Cycle 4 — the pending dwell is cancelled when the edge is left before it elapses. Wrapped in
  // StrictMode: the render-phase tracker must SURVIVE the mount replay (state, not a ref — M13.8 r7).
  it('cancels the pending dwell when the address clears before it elapses — zero requests (StrictMode)', async () => {
    vi.useFakeTimers()
    asMock().mockResolvedValue(response())
    const { rerender } = render(
      <StrictMode>
        <FlowReadout probe={probeOf()} address={addressOf()} pinned={false} />
      </StrictMode>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS - 50)
    })
    // Leave the edge before the dwell fires.
    rerender(
      <StrictMode>
        <FlowReadout probe={probeOf()} address={null} pinned={false} />
      </StrictMode>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(asMock()).not.toHaveBeenCalled()
  })
})

describe('FlowReadout — staleness never renders', () => {
  // Cycle 5 — the address changes while A's request is in flight; only B's digest may render.
  it('when the address changes mid-flight, only the new address’ digest renders (stale A discarded)', async () => {
    vi.useFakeTimers()
    const dA = deferred<NodeValueResponse>()
    const dB = deferred<NodeValueResponse>()
    asMock().mockReturnValueOnce(dA.promise).mockReturnValueOnce(dB.promise)
    const A = addressOf({ nodeId: 'a', sourceLabel: 'Alpha' })
    const B = addressOf({ nodeId: 'b', sourceLabel: 'Beta' })
    const { rerender } = render(<FlowReadout probe={probeOf()} address={A} pinned={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    }) // A's request now pending
    rerender(<FlowReadout probe={probeOf()} address={B} pinned={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    }) // B's request now pending
    // B settles first, then A settles late — A must never overwrite or flash.
    await act(async () => {
      dB.resolve(scalarResponse(0.22, { node_id: 'b' }))
      await Promise.resolve()
    })
    await act(async () => {
      dA.resolve(scalarResponse(0.99, { node_id: 'a' }))
      await Promise.resolve()
    })
    expect(screen.getByText('0.22')).toBeInTheDocument()
    expect(screen.queryByText('0.99')).not.toBeInTheDocument()
    expect(screen.getByText(/Beta/)).toBeInTheDocument()
  })

  // Cycle 6 — the probe moves while the address is unchanged; the late old-probe result is discarded.
  it('when the probe cursor changes mid-flight, the late old-cursor result is discarded', async () => {
    vi.useFakeTimers()
    const d1 = deferred<NodeValueResponse>()
    const d2 = deferred<NodeValueResponse>()
    asMock().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise)
    const addr = addressOf()
    const { rerender } = render(
      <FlowReadout probe={probeOf({ cursor: '2026-05-15' })} address={addr} pinned={false} />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    rerender(<FlowReadout probe={probeOf({ cursor: '2026-05-16' })} address={addr} pinned={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    await act(async () => {
      d2.resolve(scalarResponse(0.42, { session_date: '2026-05-16' }))
      await Promise.resolve()
    })
    await act(async () => {
      d1.resolve(scalarResponse(0.11, { session_date: '2026-05-15' }))
      await Promise.resolve()
    })
    expect(screen.getByText('0.42')).toBeInTheDocument()
    expect(screen.queryByText('0.11')).not.toBeInTheDocument()
  })

  // Cycle 6, runId variant — the same discipline keys on runId (the tag's first segment).
  it('when the probe runId changes mid-flight, the late old-run result is discarded', async () => {
    vi.useFakeTimers()
    const d1 = deferred<NodeValueResponse>()
    const d2 = deferred<NodeValueResponse>()
    asMock().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise)
    const addr = addressOf()
    const { rerender } = render(
      <FlowReadout probe={probeOf({ runId: 'run-1' })} address={addr} pinned={false} />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    rerender(<FlowReadout probe={probeOf({ runId: 'run-2' })} address={addr} pinned={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    await act(async () => {
      d2.resolve(scalarResponse(0.42))
      await Promise.resolve()
    })
    await act(async () => {
      d1.resolve(scalarResponse(0.11))
      await Promise.resolve()
    })
    expect(screen.getByText('0.42')).toBeInTheDocument()
    expect(screen.queryByText('0.11')).not.toBeInTheDocument()
  })

  // Cycle 7 — an ALREADY-rendered digest vanishes in the very switch commit when the probe moves.
  it('a rendered digest disappears the instant the probe cursor changes (stale by generation)', async () => {
    vi.useFakeTimers()
    asMock().mockResolvedValue(scalarResponse(0.77))
    const addr = addressOf()
    const { rerender } = render(
      <FlowReadout probe={probeOf({ cursor: '2026-05-15' })} address={addr} pinned={false} />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    expect(screen.getByText('0.77')).toBeInTheDocument()
    // Same address, new cursor → the stored result is stale by generation and cannot render even once.
    rerender(<FlowReadout probe={probeOf({ cursor: '2026-05-16' })} address={addr} pinned={false} />)
    expect(screen.queryByText('0.77')).not.toBeInTheDocument()
    expect(screen.getByText('…')).toBeInTheDocument()
  })

  // Cycle 7, runId variant.
  it('a rendered digest disappears the instant the probe runId changes (stale by generation)', async () => {
    vi.useFakeTimers()
    asMock().mockResolvedValue(scalarResponse(0.77))
    const addr = addressOf()
    const { rerender } = render(
      <FlowReadout probe={probeOf({ runId: 'run-1' })} address={addr} pinned={false} />,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    expect(screen.getByText('0.77')).toBeInTheDocument()
    rerender(<FlowReadout probe={probeOf({ runId: 'run-2' })} address={addr} pinned={false} />)
    expect(screen.queryByText('0.77')).not.toBeInTheDocument()
    expect(screen.getByText('…')).toBeInTheDocument()
  })

  // Cycle 8 — re-activation staleness, RENDER-RECORDED. The re-hover (∅ → A) is a PARENT-driven
  // re-render (the two `rerender` calls), so the wrapper's layout-effect recorder captures the SWITCH
  // commit itself — the exact frame a stale result would leak on. A per-commit snapshot is the point:
  // an ordinary post-`rerender` assertion, flushing effects inside act, could miss a one-commit leak. (A
  // parent recorder cannot see the child's OWN `setStored` commits, so the "it rendered" checkpoints are
  // asserted via `screen`; the recorder is used only for the dwell-window leak proof.)
  it('never renders the stale result during a re-activation dwell — per-commit recording (A → null → A)', async () => {
    vi.useFakeTimers()
    asMock().mockResolvedValue(scalarResponse(0.5))
    const commits: string[] = []
    function Recorder({ children }: { children: ReactNode }) {
      const ref = useRef<HTMLDivElement>(null)
      // No deps array → this layout effect runs after EVERY commit of Recorder, snapshotting the text.
      useLayoutEffect(() => {
        commits.push(ref.current?.textContent ?? '')
      })
      return <div ref={ref}>{children}</div>
    }
    const addr = addressOf()
    const { rerender } = render(
      <Recorder>
        <FlowReadout probe={probeOf()} address={addr} pinned={false} />
      </Recorder>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    }) // A resolves + renders 0.5 (a child-internal commit → asserted via screen, not the recorder)
    expect(screen.getByText('0.5')).toBeInTheDocument()
    // Leave, then re-hover the SAME address (same tag, NEW generation) — both parent-driven commits.
    rerender(
      <Recorder>
        <FlowReadout probe={probeOf()} address={null} pinned={false} />
      </Recorder>,
    )
    const dwellStart = commits.length
    rerender(
      <Recorder>
        <FlowReadout probe={probeOf()} address={addr} pinned={false} />
      </Recorder>,
    )
    // Let the whole dwell pass WITHOUT the second resolution completing (advance to just shy of it).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS - 1)
    })
    // No commit from the re-hover through the entire dwell may show the stale 0.5 digest — the switch
    // commit renders the dwell placeholder, never the value stored under the old generation.
    expect(commits.slice(dwellStart).every((c) => !c.includes('0.5'))).toBe(true)
    expect(screen.getByText('…')).toBeInTheDocument()
    // The dwell completes → the FRESH request resolves → only now does the new response render again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByText('0.5')).toBeInTheDocument()
  })

  // Cycle 9 — a late FIRST-activation resolution never overrides the re-activation's fresher value.
  it('a late first-activation resolution never overrides the re-activation’s fresher value', async () => {
    vi.useFakeTimers()
    const d1 = deferred<NodeValueResponse>()
    const d2 = deferred<NodeValueResponse>()
    asMock().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise)
    const addr = addressOf()
    const { rerender } = render(<FlowReadout probe={probeOf()} address={addr} pinned={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    }) // A₁ request pending (gen g)
    rerender(<FlowReadout probe={probeOf()} address={null} pinned={false} />) // leave (gen g+1)
    rerender(<FlowReadout probe={probeOf()} address={addr} pinned={false} />) // re-hover (gen g+2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    }) // A₂ request pending (gen g+2)
    await act(async () => {
      d2.resolve(scalarResponse(0.2))
      await Promise.resolve()
    }) // A₂ resolves + renders
    expect(screen.getByText('0.2')).toBeInTheDocument()
    await act(async () => {
      d1.resolve(scalarResponse(0.9))
      await Promise.resolve()
    }) // A₁ resolves late — must be discarded
    expect(screen.getByText('0.2')).toBeInTheDocument()
    expect(screen.queryByText('0.9')).not.toBeInTheDocument()
  })

  // Cycle 10 — no-cache proof: the A → null → A flow RECOMPUTES, firing exactly two requests (§10.5).
  it('re-hovering the same address recomputes — exactly two requests, never a cached reuse (§10.5)', async () => {
    vi.useFakeTimers()
    asMock().mockResolvedValue(response())
    const addr = addressOf()
    const { rerender } = render(<FlowReadout probe={probeOf()} address={addr} pinned={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    rerender(<FlowReadout probe={probeOf()} address={null} pinned={false} />)
    rerender(<FlowReadout probe={probeOf()} address={addr} pinned={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    expect(asMock()).toHaveBeenCalledTimes(2)
  })
})

describe('FlowReadout — rendering', () => {
  // Cycle 11 — the success render: label + SERVED port, the digest with lossy-token titles and
  // title-free integer counts, and the recompute-provenance footer with the abbreviated fingerprint.
  it('renders label+served port, lossy-token titles, title-free counts, and the provenance abbrev', async () => {
    vi.useFakeTimers()
    const fp = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    asMock().mockResolvedValue(
      response({
        output_port: 'ranks',
        provenance: { captured: false, dataset_fingerprint: fp, run_id: 'run-1' },
        value_summary: {
          kind: 'cross_section',
          dtype: 'Number',
          domain_count: 6,
          present_count: 5,
          missing: ['XLF'],
          min: -0.04916057824719877,
          max: 0.22315234567890123,
        },
      }),
    )
    render(<FlowReadout probe={probeOf()} address={addressOf({ sourceLabel: 'Trailing Return' })} pinned={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    // Line 1: the source label · the SERVED output port (the served port labels the value).
    expect(screen.getByText('Trailing Return · out ranks')).toBeInTheDocument()
    // The lossy min/max value spans carry the VERBATIM served number in `title` (D-27)…
    const minSpan = screen.getByText('-0.0492')
    expect(minSpan).toHaveAttribute('title', '-0.04916057824719877')
    const maxSpan = screen.getByText('0.2232')
    // The title is the RAW served float via String() — the literal round-trips to this float64 rendering.
    expect(maxSpan).toHaveAttribute('title', String(0.22315234567890123))
    // …while the integer-count prose span is title-free (lossless by construction).
    expect(screen.getByText('5 of 6 assets')).not.toHaveAttribute('title')
    // Provenance: the recompute phrasing + the abbreviated fingerprint, full hash reachable in `title`.
    expect(
      screen.getByText(/Recomputed on demand from the run's pinned inputs/),
    ).toBeInTheDocument()
    const code = screen.getByText('0123456789…abcdef')
    expect(code).toHaveAttribute('title', fp)
  })

  // Cycle 12 — a SERVED refusal renders under role=alert, prefixed by the source label (FD-6a shape).
  it('renders a served error under role=alert, prefixed by the source label (FD-6a)', async () => {
    vi.useFakeTimers()
    asMock().mockRejectedValue(
      new ApiClientError('value_address_not_found', "node x does not exist in this run's strategy", 404),
    )
    render(<FlowReadout probe={probeOf()} address={addressOf({ sourceLabel: 'Trailing Return' })} pinned={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent("Trailing Return — node x does not exist in this run's strategy")
  })

  // Cycle 13 — the pinned hint appears only while pinned.
  it('shows an “Esc to release” hint only when pinned', async () => {
    vi.useFakeTimers()
    asMock().mockResolvedValue(response())
    const { rerender } = render(<FlowReadout probe={probeOf()} address={addressOf()} pinned={true} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS)
    })
    expect(screen.getByText('Esc to release')).toBeInTheDocument()
    // The root carries the pinned modifier — the CSS accent-border convention keys off it (Task 7).
    expect(document.querySelector('.flow-readout--pinned')).not.toBeNull()
    // Un-pinning (same address → no new generation) keeps the digest but drops the hint + modifier.
    rerender(<FlowReadout probe={probeOf()} address={addressOf()} pinned={false} />)
    expect(screen.queryByText('Esc to release')).not.toBeInTheDocument()
    expect(document.querySelector('.flow-readout--pinned')).toBeNull()
  })
})
