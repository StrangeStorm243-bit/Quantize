// Runtime schema-version drift check (fulfills the `config.ts` contract: the pinned SCHEMA_VERSION
// is asserted against the live service's `/v1/meta` — a console warning on mismatch, never a crash).
//
// The persisted IR is the single source of truth; a client built against `0.1.0` talking to a server
// on a different schema version is a drift signal the founder wants surfaced early (and a seam that
// matters once the app is hosted). This is best-effort: a failed `/v1/meta` fetch is ignored so the
// editor still boots offline. No domain type is re-declared; no numerical logic.
import { useEffect } from 'react'
import { getMeta } from './api/client'
import { SCHEMA_VERSION } from './config'

/**
 * A drift warning message when the server's schema version differs from the pinned one, else null.
 * Pure — unit-testable without React or the network.
 */
export function schemaVersionWarning(serverSchemaVersion: string): string | null {
  if (serverSchemaVersion === SCHEMA_VERSION) {
    return null
  }
  return (
    `Quantize schema-version drift: this editor is pinned to ${SCHEMA_VERSION} but the server ` +
    `reports ${serverSchemaVersion}. Documents may fail validation until the editor is rebuilt ` +
    `against the server's generated types.`
  )
}

/**
 * Boot-time, best-effort check: fetch `/v1/meta` once and `console.warn` on a schema-version
 * mismatch. A fetch failure (offline / server down) is swallowed — the editor must still load.
 */
export function useSchemaVersionCheck(): void {
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const meta = await getMeta()
        if (cancelled) {
          return
        }
        const warning = schemaVersionWarning(meta.schema_version)
        if (warning !== null) {
          console.warn(warning)
        }
      } catch {
        // Best-effort: a missing/unreachable service must not block the editor from loading.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
}
