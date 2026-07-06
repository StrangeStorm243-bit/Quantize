// Catalog access + compatibility LOOKUP (M11.4, D5/D13).
//
// Compatibility is a DATA LOOKUP over the catalog's `compatibility` pairs — NEVER hand-written TS
// type logic (CLAUDE.md invariant 5). The only decision this module makes about "can A connect to
// B" is set membership: `isAllowed` tests `key(source)->key(destination)` against an allow-set built
// from the catalog. There is no conditional over `kind`/`dtype` anywhere below except inside the two
// tiny key/label helpers that project a port type onto its stable string form. No domain type is
// re-declared (invariant 4) — everything comes from the generated `@quantize/*` declarations.
import { createContext, createElement, useContext, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type {
  AssetSetType,
  CrossSectionType,
  NodeCatalogResponse,
  NodeTypeDto,
  PortfolioTargetsType,
  ScalarType,
  TimeSeriesType,
} from '@quantize/quantize-api'
import type { JsonValue } from '@quantize/quantize-ir'
import { errorMessage, getNodeCatalog } from '../api/client'

/**
 * The port-type lattice union. This is a type ALIAS composed from the generated variants — the exact
 * union the generated DTOs already spell inline for every `port_type` field. Aliasing is composition,
 * not a re-declaration of shape (invariant 4): change a variant in the schema and this follows.
 */
export type PortType =
  | ScalarType
  | AssetSetType
  | CrossSectionType
  | TimeSeriesType
  | PortfolioTargetsType

/**
 * A canonical, stable string key for a port type: `kind` plus `:dtype` when the variant carries one.
 * This is the ONLY place that inspects `dtype`, and it does so structurally (`'dtype' in pt`) — never
 * to make a compatibility decision, only to project the type onto a comparable key.
 */
export function portTypeKey(pt: PortType): string {
  return pt.kind + ('dtype' in pt ? ':' + pt.dtype : '')
}

/**
 * Build the allow-set: one `"srcKey->dstKey"` string per `{source, destination}` compatibility pair.
 * Membership in this set IS the compatibility rule — there is no other rule.
 */
export function buildCompatibilitySet(catalog: NodeCatalogResponse): Set<string> {
  const set = new Set<string>()
  for (const pair of catalog.compatibility) {
    set.add(portTypeKey(pair.source) + '->' + portTypeKey(pair.destination))
  }
  return set
}

/** True iff `source -> destination` is an allowed edge — pure set membership, no type logic. */
export function isAllowed(compatSet: Set<string>, source: PortType, destination: PortType): boolean {
  return compatSet.has(portTypeKey(source) + '->' + portTypeKey(destination))
}

/** The human label for a port type (e.g. `"Scalar[Number]"`), looked up by key; key as fallback. */
export function labelOf(catalog: NodeCatalogResponse, pt: PortType): string {
  const key = portTypeKey(pt)
  const entry = catalog.port_types.find((e) => portTypeKey(e.port_type) === key)
  return entry?.label ?? key
}

/** Find a node type by its `type_id`, or `undefined` when absent (unknown/future type). */
export function nodeTypeById(
  catalog: NodeCatalogResponse,
  typeId: string,
): NodeTypeDto | undefined {
  return catalog.node_types.find((n) => n.type_id === typeId)
}

/**
 * Seed a fresh node's `params` from its parameter schema: for every property that declares a
 * `default`, copy that default; OMIT properties without one (the node starts invalid-until-filled,
 * which is the normal authoring state — M11.5 supplies the form). Returns `{}` when there is no
 * schema or no properties. This reads defaults; it invents no values.
 */
export function defaultParamsFor(nodeType: NodeTypeDto): { [k: string]: JsonValue } {
  const params: { [k: string]: JsonValue } = {}
  const schema = nodeType.parameter_schema
  if (schema === null) {
    return params
  }
  const properties = schema.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return params
  }
  for (const [name, prop] of Object.entries(properties)) {
    if (prop !== null && typeof prop === 'object' && !Array.isArray(prop) && 'default' in prop) {
      params[name] = prop.default
    }
  }
  return params
}

/** One palette group: a `type_id` namespace prefix and the node types under it. */
export interface PaletteGroup {
  group: string
  nodeTypes: NodeTypeDto[]
}

/**
 * Group node types by their `type_id` namespace (text before the first `.`), groups sorted and
 * node types sorted by display name within each. This is a display DERIVATION, not a contract.
 */
export function paletteGroups(catalog: NodeCatalogResponse): PaletteGroup[] {
  const byGroup = new Map<string, NodeTypeDto[]>()
  for (const nt of catalog.node_types) {
    const group = nt.type_id.split('.')[0]
    const list = byGroup.get(group)
    if (list === undefined) {
      byGroup.set(group, [nt])
    } else {
      list.push(nt)
    }
  }
  return [...byGroup.keys()].sort().map((group) => ({
    group,
    nodeTypes: [...(byGroup.get(group) ?? [])].sort((a, b) =>
      a.display_name.localeCompare(b.display_name),
    ),
  }))
}

// --- React context: fetch the catalog ONCE, expose loading/error --------------------------------

/** The catalog fetch state exposed by {@link useCatalog}. */
export interface CatalogState {
  catalog: NodeCatalogResponse | undefined
  loading: boolean
  error: string | undefined
}

const CatalogContext = createContext<CatalogState | undefined>(undefined)

/**
 * Fetch the node catalog once on mount and provide it to the tree. Holds `{catalog, loading, error}`;
 * a failed fetch surfaces as `error` (no crash). The `cancelled` guard drops a late resolution after
 * unmount (e.g. StrictMode's double-invoke) so we never set state on an unmounted provider.
 */
export function CatalogProvider(props: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<CatalogState>({
    catalog: undefined,
    loading: true,
    error: undefined,
  })
  useEffect(() => {
    let cancelled = false
    getNodeCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setState({ catalog, loading: false, error: undefined })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ catalog: undefined, loading: false, error: errorMessage(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])
  return createElement(CatalogContext.Provider, { value: state }, props.children)
}

/** Read the catalog fetch state; throws if used outside a {@link CatalogProvider}. */
export function useCatalog(): CatalogState {
  const ctx = useContext(CatalogContext)
  if (ctx === undefined) {
    throw new Error('useCatalog must be used within a CatalogProvider')
  }
  return ctx
}
