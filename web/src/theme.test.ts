// M13.2 theme-behavior tests: default-dark, persistence, and the toggle — asserting state + the
// `data-theme` attribute + localStorage (behavior), never computed visual styles.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyTheme,
  nextTheme,
  readStoredTheme,
  storeTheme,
  THEME_KEY,
  useTheme,
} from './theme'

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})
afterEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('readStoredTheme', () => {
  it('defaults to dark when no preference is stored', () => {
    expect(readStoredTheme()).toBe('dark')
  })

  it('returns the stored light preference', () => {
    window.localStorage.setItem(THEME_KEY, 'light')
    expect(readStoredTheme()).toBe('light')
  })

  it('falls back to dark for an unrecognized stored value', () => {
    window.localStorage.setItem(THEME_KEY, 'chartreuse')
    expect(readStoredTheme()).toBe('dark')
  })
})

describe('nextTheme', () => {
  it('flips dark↔light', () => {
    expect(nextTheme('dark')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
  })
})

describe('applyTheme / storeTheme', () => {
  it('stamps the theme on the document root', () => {
    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('persists the choice to localStorage', () => {
    storeTheme('light')
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light')
  })
})

describe('useTheme', () => {
  it('starts dark and applies it to the DOM on mount when no preference exists', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current[0]).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('restores a saved light preference', () => {
    window.localStorage.setItem(THEME_KEY, 'light')
    const { result } = renderHook(() => useTheme())
    expect(result.current[0]).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('toggles the theme and persists the new choice', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current[1]())
    expect(result.current[0]).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light')
    act(() => result.current[1]())
    expect(result.current[0]).toBe('dark')
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark')
  })
})
