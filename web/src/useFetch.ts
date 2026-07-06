// A tiny, web-local data-fetch hook (M11.9). The same cancellable fetch-effect was hand-copied across
// several panels and drifted (some forgot to clear stale data on a dependency change, some duplicated
// the fetch body for a manual refresh). This centralizes ONE correct shape: run `fetcher` on a
// dependency change, RESET data + show loading each time, capture errors via the shared
// `errorMessage`, guard against a resolution after unmount, and expose `reload()` for an explicit
// refetch. It is transport wiring only — no domain/numerical logic (CLAUDE.md invariant 5).
//
// Note on `deps`: the effect keys on the caller-supplied `deps` (plus an internal reload nonce), NOT
// on `fetcher`'s identity — callers pass a fresh closure each render, so `deps` is the intended
// dependency signal, exactly as the bespoke effects it replaces did.
import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from './api/client'

export interface UseFetchResult<T> {
  /** The last successful result, or `undefined` before the first success / while (re)loading. */
  data: T | undefined
  /** True from a (re)fetch start until it settles. */
  loading: boolean
  /** The last error message, or `undefined`. */
  error: string | undefined
  /** Trigger an explicit refetch (same deps) — used after a mutation to refresh a list. */
  reload: () => void
}

export function useFetch<T>(fetcher: () => Promise<T>, deps: unknown[]): UseFetchResult<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    // Reset on every deps/reload change so a previous result never lingers as stale content.
    setData(undefined)
    setError(undefined)
    setLoading(true)
    fetcher()
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(errorMessage(e))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // `fetcher` is intentionally excluded — `deps` is the caller's dependency signal (see header).
  }, [...deps, nonce])

  return { data, loading, error, reload }
}
