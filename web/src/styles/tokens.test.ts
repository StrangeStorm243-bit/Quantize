// M13.2 token-contract tests. These parse the raw stylesheets (never getComputedStyle) so they
// assert the token SYSTEM — which custom properties exist, in which themes — not pixel appearance.
// Read the source text with fs from the vitest working directory (the `web/` package root) — CSS
// imports resolve to empty under vitest, and `import.meta.url` is not a file URL in jsdom.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const tokensCss = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')
const appCss = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf8')

// Split the stylesheet into the dark (`:root {`) and light (`:root[data-theme=…]`) declaration
// blocks at the light SELECTOR (not the word in the header comment, which also mentions data-theme).
// Everything before the light selector is the default dark theme; everything after is the override.
const lightIndex = tokensCss.indexOf(':root[data-theme=')
const darkBlock = tokensCss.slice(0, lightIndex)
const lightBlock = tokensCss.slice(lightIndex)

function defines(block: string, token: string): boolean {
  // A definition is `--token:` (a declaration), distinct from a `var(--token)` reference.
  return new RegExp(`${token}\\s*:`).test(block)
}

const LIVE_CATEGORIES = [
  'universe',
  'data',
  'transform',
  'signal',
  'selection',
  'weighting',
  'risk',
  'output',
]

const RESERVED_CATEGORIES = ['optimization', 'stochastic', 'statistics', 'ml', 'external']

const PORT_TYPES = [
  'scalar-number',
  'scalar-integer',
  'scalar-boolean',
  'asset-set',
  'cross-section-number',
  'cross-section-boolean',
  'time-series-number',
  'portfolio-targets',
]

const BASE_SEMANTIC = [
  '--bg',
  '--surface',
  '--surface-elevated',
  '--border',
  '--border-muted',
  '--text',
  '--text-secondary',
  '--text-muted',
  '--accent',
  '--danger',
  '--warning',
  '--success',
  '--info',
]

describe('tokens.css theme structure', () => {
  it('defines both a dark :root default and a light [data-theme] override block', () => {
    expect(darkBlock).toContain(':root {')
    expect(lightBlock).toMatch(/\[data-theme=['"]light['"]\]/)
  })
})

describe('category color tokens', () => {
  it.each(LIVE_CATEGORIES)('defines --cat-%s in both themes', (name) => {
    const token = `--cat-${name}`
    expect(defines(darkBlock, token)).toBe(true)
    expect(defines(lightBlock, token)).toBe(true)
  })

  it.each(RESERVED_CATEGORIES)('defines reserved --cat-%s in both themes', (name) => {
    const token = `--cat-${name}`
    expect(defines(darkBlock, token)).toBe(true)
    expect(defines(lightBlock, token)).toBe(true)
  })

  it('defines the neutral unknown-category fallback in both themes', () => {
    expect(defines(darkBlock, '--cat-neutral')).toBe(true)
    expect(defines(lightBlock, '--cat-neutral')).toBe(true)
  })
})

describe('port-type color tokens', () => {
  it.each(PORT_TYPES)('defines --port-%s in both themes', (name) => {
    const token = `--port-${name}`
    expect(defines(darkBlock, token)).toBe(true)
    expect(defines(lightBlock, token)).toBe(true)
  })

  it('defines the neutral port-type fallback in both themes', () => {
    expect(defines(darkBlock, '--port-neutral')).toBe(true)
    expect(defines(lightBlock, '--port-neutral')).toBe(true)
  })
})

describe('semantic + layout tokens', () => {
  it.each(BASE_SEMANTIC)('defines semantic role %s in both themes', (token) => {
    expect(defines(darkBlock, token)).toBe(true)
    expect(defines(lightBlock, token)).toBe(true)
  })

  it('defines the layout token families on the dark :root', () => {
    for (const token of [
      '--font-sans',
      '--font-mono',
      '--space-1',
      '--space-4',
      '--text-sm',
      '--text-lg',
      '--weight-semibold',
      '--radius-md',
      '--shadow-sm',
      '--shadow-lg',
      '--focus-ring',
      '--motion-base',
    ]) {
      expect(defines(darkBlock, token)).toBe(true)
    }
  })
})

describe('App.css consumes tokens (no raw color literals)', () => {
  it('contains no hex color literals', () => {
    // The `#root` selector is not a hex color (r is not a hex digit) so this regex never matches it;
    // any real hex (`#fff`, `#1f2430`, …) would, and must have been replaced by a var(--token).
    const hexes = appCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(hexes).toEqual([])
  })

  it('references design tokens via var(--…)', () => {
    expect(appCss).toMatch(/var\(--/)
  })
})
