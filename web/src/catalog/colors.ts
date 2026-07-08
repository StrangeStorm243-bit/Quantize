// Category + port-type → design-token maps (M13.4).
//
// The ONLY home for "which color is this node stage / this wire type." Both maps are keyed by
// SERVER-supplied identifiers (the authored machine-stage `category`, the port-type lattice key) with
// a neutral fallback, so a future node family or a future port type renders sanely with ZERO code
// changes here — the tokens ship in `styles/tokens.css` (M13.2) for both themes. This module makes NO
// compatibility or numerical decision (invariant 5): it is a pure identifier → CSS-variable lookup.
import { portTypeKey } from './index'
import type { PortType } from './index'

/** The eight live categories (M13.1 D-14), pipeline-stage order — each has its own `--cat-*` token. */
export const LIVE_CATEGORIES = [
  'universe',
  'data',
  'transform',
  'signal',
  'selection',
  'weighting',
  'risk',
  'output',
] as const

/** The five reserved future categories (design W2) — pre-assigned tokens so they arrive with identity. */
export const RESERVED_CATEGORIES = [
  'optimization',
  'stochastic',
  'statistics',
  'ml',
  'external',
] as const

// Every live + reserved category has a token named exactly `--cat-<category>` (the M13.2 tokens.css
// convention). Building the lookup from the two lists keeps this in lockstep with the token file.
const CATEGORY_TOKENS: ReadonlySet<string> = new Set<string>([
  ...LIVE_CATEGORIES,
  ...RESERVED_CATEGORIES,
])

/** The token NAME (`--cat-universe`) for a category, or `--cat-neutral` for an unknown/future one. */
export function categoryColorVar(category: string): string {
  return CATEGORY_TOKENS.has(category) ? `--cat-${category}` : '--cat-neutral'
}

/** The `var(--cat-…)` reference for a category — ready to drop into a `style`/custom-property value. */
export function categoryColor(category: string): string {
  return `var(${categoryColorVar(category)})`
}

// Port-type key (`Scalar:Number`, `AssetSet`, …) → its `--port-*` token. Keys come from the SAME
// `portTypeKey` the compatibility lookup uses, so a new lattice member is one entry here + one token.
const PORT_TOKENS: Readonly<Record<string, string>> = {
  'Scalar:Number': '--port-scalar-number',
  'Scalar:Integer': '--port-scalar-integer',
  'Scalar:Boolean': '--port-scalar-boolean',
  AssetSet: '--port-asset-set',
  'CrossSection:Number': '--port-cross-section-number',
  'CrossSection:Boolean': '--port-cross-section-boolean',
  'TimeSeries:Number': '--port-time-series-number',
  PortfolioTargets: '--port-portfolio-targets',
}

/** The token NAME for a port type, or `--port-neutral` for an unknown/future one. */
export function portColorVar(pt: PortType): string {
  return PORT_TOKENS[portTypeKey(pt)] ?? '--port-neutral'
}

/** The `var(--port-…)` reference for a port type. */
export function portColor(pt: PortType): string {
  return `var(${portColorVar(pt)})`
}
