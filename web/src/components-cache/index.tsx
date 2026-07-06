// Component-definition cache (M12.3, E8): a cache-FOREVER store of `ComponentDefinition`s keyed by
// `component_id@version`.
//
// A component definition is IMMUTABLE per version — the store returns 409 on a divergent re-save — so
// once a definition is fetched (or seeded post-extraction) it never needs invalidating or refetching.
// This provider mirrors the `CatalogProvider` context pattern: fetch on demand, expose the map plus a
// per-key loading/error signal, and throw if the hook is used outside the provider. NO numerical,
// portfolio, or compatibility logic lives here (CLAUDE.md invariant 5); no domain type is re-declared
// (invariant 4) — `ComponentDefinition` is the generated IR type. Definition→port mapping and the
// cache-key format live in `document/flow.ts` (the single shared resolution path), imported here.
import { createContext, createElement, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { ComponentDefinition } from '@quantize/quantize-ir'
import { errorMessage, loadComponentVersion } from '../api/client'
import { componentCacheKey } from '../document/flow'

// Re-export the shared helpers so consumers can reach the whole component-cache surface from one place.
export { componentCacheKey, componentPorts } from '../document/flow'

// The immutable cache state: definitions by key, plus which keys are in-flight and which failed.
interface CacheState {
  defs: ReadonlyMap<string, ComponentDefinition>
  loading: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
}

/** The component-cache surface exposed by {@link useComponentDefs}. */
export interface ComponentDefs {
  /** The raw `id@version → definition` map — passed straight into `toFlow`/`decideConnection`. */
  defs: ReadonlyMap<string, ComponentDefinition>
  /** Look up a definition by `(componentId, version)`, or `undefined` on a cache miss. */
  get: (componentId: string, version: string) => ComponentDefinition | undefined
  /** Fetch a definition ONCE per key (cache-forever). A no-op if already loaded or in-flight. */
  ensure: (componentId: string, version: string) => void
  /** Insert a definition directly (post-extraction, M12.5) with no fetch. */
  seed: (def: ComponentDefinition) => void
  /** True while a fetch for the key is in-flight. */
  isLoading: (componentId: string, version: string) => boolean
  /** The last fetch error for the key, or `undefined`. */
  errorOf: (componentId: string, version: string) => string | undefined
}

const ComponentsContext = createContext<ComponentDefs | undefined>(undefined)

/**
 * Provide the cache-forever component-definition store to the tree. Fetches are triggered on demand by
 * `ensure` (doc load scan / a future explicit request) and de-duplicated: a `started` ref records every
 * key whose fetch has begun (or that was `seed`ed), so a second `ensure` for the same key never issues a
 * second request. A failed fetch drops the key from `started` so a later `ensure` may retry.
 */
export function ComponentsProvider(props: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<CacheState>({
    defs: new Map(),
    loading: new Set(),
    errors: new Map(),
  })
  // Keys whose fetch has begun or that were seeded — the duplicate-fetch guard (a ref so it is read
  // synchronously, before any state update commits).
  const started = useRef<Set<string>>(new Set())

  const seed = useCallback((def: ComponentDefinition): void => {
    const key = componentCacheKey(def.component_id, def.version)
    started.current.add(key)
    setState((prev) => {
      const defs = new Map(prev.defs)
      defs.set(key, def)
      const loading = new Set(prev.loading)
      loading.delete(key)
      const errors = new Map(prev.errors)
      errors.delete(key)
      return { defs, loading, errors }
    })
  }, [])

  const ensure = useCallback((componentId: string, version: string): void => {
    const key = componentCacheKey(componentId, version)
    if (started.current.has(key)) {
      return
    }
    started.current.add(key)
    setState((prev) => {
      const loading = new Set(prev.loading)
      loading.add(key)
      return { defs: prev.defs, loading, errors: prev.errors }
    })
    loadComponentVersion(componentId, version)
      .then((def) => {
        setState((prev) => {
          const defs = new Map(prev.defs)
          defs.set(key, def)
          const loading = new Set(prev.loading)
          loading.delete(key)
          const errors = new Map(prev.errors)
          errors.delete(key)
          return { defs, loading, errors }
        })
      })
      .catch((err: unknown) => {
        // Allow a later retry — the definition is still absent from the cache.
        started.current.delete(key)
        setState((prev) => {
          const loading = new Set(prev.loading)
          loading.delete(key)
          const errors = new Map(prev.errors)
          errors.set(key, errorMessage(err))
          return { defs: prev.defs, loading, errors }
        })
      })
  }, [])

  const value = useMemo<ComponentDefs>(
    () => ({
      defs: state.defs,
      get: (componentId, version) => state.defs.get(componentCacheKey(componentId, version)),
      ensure,
      seed,
      isLoading: (componentId, version) => state.loading.has(componentCacheKey(componentId, version)),
      errorOf: (componentId, version) => state.errors.get(componentCacheKey(componentId, version)),
    }),
    [state, ensure, seed],
  )

  return createElement(ComponentsContext.Provider, { value }, props.children)
}

/** Read the component-definition cache; throws if used outside a {@link ComponentsProvider}. */
export function useComponentDefs(): ComponentDefs {
  const ctx = useContext(ComponentsContext)
  if (ctx === undefined) {
    throw new Error('useComponentDefs must be used within a ComponentsProvider')
  }
  return ctx
}
