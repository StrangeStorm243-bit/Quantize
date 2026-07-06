// ComponentsProvider + componentPorts tests (M12.3, E8). NO network: `loadComponentVersion` is mocked
// and we assert the cache-forever contract (one fetch per key, in-flight dedupe, seed-without-fetch,
// cache-miss returns undefined). `componentPorts` is a pure data mapping asserted directly.
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { createElement } from 'react'
import type { ComponentDefinition } from '@quantize/quantize-ir'
import { ComponentsProvider, componentPorts, useComponentDefs } from './index'

vi.mock('../api/client', () => ({
  loadComponentVersion: vi.fn(),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))
// eslint-disable-next-line import/first
import { loadComponentVersion } from '../api/client'

const DEF: ComponentDefinition = {
  schema_version: '0.1.0',
  component_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  version: '1.0.0',
  name: 'Momentum Selector',
  description: null,
  component_refs: [],
  implementation: { kind: 'graph', graph: { nodes: [], edges: [] } },
  exposed_inputs: [
    { name: 'series', type: { kind: 'TimeSeries', dtype: 'Number' }, maps_to: ['ret', 'series'] },
    { name: 'universe', type: { kind: 'AssetSet' }, maps_to: ['sel', 'universe'] },
  ],
  exposed_outputs: [{ name: 'assets', type: { kind: 'AssetSet' }, maps_to: ['sel', 'assets'] }],
  exposed_params: [],
  provenance: {
    owner: '00000000-0000-0000-0000-000000000001',
    creator: '00000000-0000-0000-0000-000000000001',
    contributors: [],
    visibility: 'private',
    duplicable: false,
    created_at: '2026-07-06T00:00:00Z',
    forked_from: null,
  },
}

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return createElement(ComponentsProvider, null, children)
}

beforeEach(() => {
  vi.mocked(loadComponentVersion).mockReset()
})

describe('componentPorts', () => {
  it('maps exposed_inputs to required inputs and exposed_outputs to outputs (verbatim types)', () => {
    const { inputs, outputs } = componentPorts(DEF)
    expect(inputs).toEqual([
      { name: 'series', port_type: { kind: 'TimeSeries', dtype: 'Number' }, required: true },
      { name: 'universe', port_type: { kind: 'AssetSet' }, required: true },
    ])
    expect(outputs).toEqual([{ name: 'assets', port_type: { kind: 'AssetSet' } }])
  })
})

describe('ComponentsProvider', () => {
  it('ensure fetches ONCE per key and dedupes an in-flight repeat (cache-forever)', async () => {
    vi.mocked(loadComponentVersion).mockResolvedValue(DEF)
    const { result } = renderHook(() => useComponentDefs(), { wrapper })

    // Two synchronous ensures for the same key before resolution → the in-flight guard collapses them.
    act(() => {
      result.current.ensure(DEF.component_id, DEF.version)
      result.current.ensure(DEF.component_id, DEF.version)
    })
    await waitFor(() =>
      expect(result.current.get(DEF.component_id, DEF.version)).toEqual(DEF),
    )
    // A third ensure AFTER it is cached must not refetch.
    act(() => result.current.ensure(DEF.component_id, DEF.version))
    expect(loadComponentVersion).toHaveBeenCalledTimes(1)
  })

  it('seed inserts a definition WITHOUT any fetch', () => {
    const { result } = renderHook(() => useComponentDefs(), { wrapper })
    act(() => result.current.seed(DEF))
    expect(result.current.get(DEF.component_id, DEF.version)).toEqual(DEF)
    expect(loadComponentVersion).not.toHaveBeenCalled()
  })

  it('get returns undefined on a cache miss', () => {
    const { result } = renderHook(() => useComponentDefs(), { wrapper })
    expect(result.current.get('missing', '1.0.0')).toBeUndefined()
  })

  it('surfaces a fetch failure as a per-key error and allows a later retry', async () => {
    vi.mocked(loadComponentVersion).mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useComponentDefs(), { wrapper })
    act(() => result.current.ensure(DEF.component_id, DEF.version))
    await waitFor(() =>
      expect(result.current.errorOf(DEF.component_id, DEF.version)).toBe('boom'),
    )
    // A failed key is not marked started, so a subsequent ensure retries (and now succeeds).
    vi.mocked(loadComponentVersion).mockResolvedValueOnce(DEF)
    act(() => result.current.ensure(DEF.component_id, DEF.version))
    await waitFor(() =>
      expect(result.current.get(DEF.component_id, DEF.version)).toEqual(DEF),
    )
    expect(loadComponentVersion).toHaveBeenCalledTimes(2)
  })
})
