import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { MetaResponse } from '@quantize/quantize-api'
import { SCHEMA_VERSION } from './config'
import { schemaVersionWarning, useSchemaVersionCheck } from './meta'

describe('schemaVersionWarning (pure)', () => {
  it('returns null when the server matches the pinned version', () => {
    expect(schemaVersionWarning(SCHEMA_VERSION)).toBeNull()
  })

  it('returns a message naming both versions on a mismatch', () => {
    const msg = schemaVersionWarning('9.9.9')
    expect(msg).not.toBeNull()
    expect(msg).toContain(SCHEMA_VERSION)
    expect(msg).toContain('9.9.9')
  })
})

function meta(schemaVersion: string): MetaResponse {
  return { api_version: 'v1', schema_version: schemaVersion, record_format: 2, trace_format: 1 }
}

describe('useSchemaVersionCheck (boot effect)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('warns once when the server schema version has drifted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(meta('9.9.9'))))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderHook(() => useSchemaVersionCheck())
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn.mock.calls[0][0]).toContain('9.9.9')
  })

  it('does not warn when the versions match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(meta(SCHEMA_VERSION))))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderHook(() => useSchemaVersionCheck())
    // Give the effect's promise a tick to resolve, then assert no warning.
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
  })

  it('swallows a failed /v1/meta fetch (editor still boots)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => renderHook(() => useSchemaVersionCheck())).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
  })
})

function mockResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response
}
