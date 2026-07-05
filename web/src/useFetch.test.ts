// useFetch (M11.9, F9): the shared cancellable fetch hook. Verifies mount fetch, deps-change
// reset+refetch, error capture (via the shared errorMessage), reload(), and the cancelled guard that
// drops a stale/late resolution. NO network — the fetcher is a plain mock.
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useFetch } from './useFetch'

describe('useFetch', () => {
  it('fetches on mount and exposes the result (loading true → false)', async () => {
    const fetcher = vi.fn().mockResolvedValue('A')
    const { result } = renderHook(() => useFetch(fetcher, []))

    expect(result.current.loading).toBe(true)
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toBe('A')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('resets data to undefined and refetches when deps change', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('A').mockResolvedValueOnce('B')
    const { result, rerender } = renderHook(({ dep }) => useFetch(() => fetcher(dep), [dep]), {
      initialProps: { dep: 1 },
    })
    await waitFor(() => expect(result.current.data).toBe('A'))

    rerender({ dep: 2 })
    // The previous result is cleared immediately (never lingers as stale content) and loading resumes.
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.data).toBe('B'))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('captures an error message via errorMessage', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('kaboom'))
    const { result } = renderHook(() => useFetch(fetcher, []))

    await waitFor(() => expect(result.current.error).toBe('kaboom'))
    expect(result.current.loading).toBe(false)
    expect(result.current.data).toBeUndefined()
  })

  it('reload() triggers a refetch with the same deps', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('A').mockResolvedValueOnce('B')
    const { result } = renderHook(() => useFetch(fetcher, []))
    await waitFor(() => expect(result.current.data).toBe('A'))

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.data).toBe('B'))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale in-flight resolution once deps change (cancelled guard)', async () => {
    let resolveFirst!: (v: string) => void
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((r) => (resolveFirst = r)))
      .mockResolvedValueOnce('second')
    const { result, rerender } = renderHook(({ dep }) => useFetch(() => fetcher(), [dep]), {
      initialProps: { dep: 1 },
    })

    rerender({ dep: 2 })
    await waitFor(() => expect(result.current.data).toBe('second'))

    // The first (now-cancelled) fetch resolves LATE — it must not overwrite the current result.
    resolveFirst('first-stale')
    await Promise.resolve()
    await Promise.resolve()
    expect(result.current.data).toBe('second')
  })

  it('does not throw when a resolution lands after unmount', async () => {
    let resolve!: (v: string) => void
    const fetcher = vi.fn().mockReturnValue(new Promise<string>((r) => (resolve = r)))
    const { unmount } = renderHook(() => useFetch(fetcher, []))

    unmount()
    expect(() => resolve('late')).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
