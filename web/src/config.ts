// Editor-wide constants (M11.3).
//
// These are deliberately tiny, documented seams — not business logic. No numerical, portfolio, or
// compatibility logic lives here (CLAUDE.md invariant 5); no domain type is re-declared (invariant
// 4). Values that the server owns (schema version) are pinned here and asserted against the live
// service ELSEWHERE (a `/v1/meta` check at runtime), never re-derived.

/**
 * Pre-auth placeholder user id (D7). No auth exists by design, so a fresh strategy's provenance
 * `owner`/`creator` are stamped with this fixed uuid. It is a valid EntityId (hyphenated uuid) so
 * the document validates server-side, and it is swapped for the real authenticated user id at the
 * auth milestone with no IR shape change.
 */
export const PLACEHOLDER_USER_ID = '00000000-0000-0000-0000-000000000001'

/**
 * Pinned IR schema version (D4/D7). New documents are minted with this `schema_version`. It is
 * asserted against the service's `/v1/meta` at runtime by `useSchemaVersionCheck` in `meta.ts` (a
 * console warning on mismatch, not a crash) — this constant is only the compile-time pin, not a
 * source of truth.
 */
export const SCHEMA_VERSION = '0.1.0'
