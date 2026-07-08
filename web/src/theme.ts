// Theme state (M13.2): dark is the default IDE look; light is an opt-in token swap. The choice is a
// pure client preference persisted in localStorage — it never touches the document/IR or the server.
//
// Applying a theme sets `data-theme` on the document root; `styles/tokens.css` keys its light-theme
// overrides on `:root[data-theme='light']` and falls back to the dark `:root` defaults otherwise.
import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

export const THEME_KEY = 'quantize.theme'

// Dark unless a valid saved preference says otherwise (safe fallback on missing/corrupt/blocked
// storage — a first-time visitor gets the intended dark IDE, never a crash).
export function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // A blocked/full localStorage must never break theming — the in-memory choice still applies.
  }
}

// Stamp the choice on the document root so the tokens stylesheet resolves the right palette.
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark'
}

// The App shell's theme handle: current theme + a toggle. Applies to the DOM and persists on every
// change (and once on mount, so a restored preference is reflected without a user action).
export function useTheme(): readonly [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)
  useEffect(() => {
    applyTheme(theme)
    storeTheme(theme)
  }, [theme])
  const toggle = useCallback(() => setTheme((current) => nextTheme(current)), [])
  return [theme, toggle] as const
}
