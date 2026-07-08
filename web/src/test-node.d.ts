// Minimal ambient declarations for the tiny slice of the Node API that the token-contract test uses
// to read stylesheet source text at runtime (vitest runs on Node). This adds NO dependency — it only
// types functions already present in the test runtime, keeping `@types/node` out of the web app.
//
// SCOPE: this file is EXCLUDED from the app config (tsconfig.json) and only picked up by
// tsconfig.test.json, so these Node globals are visible to test files ONLY — browser app code that
// referenced `process`/`node:fs` would still fail `npm run typecheck` (the app pass has no such types).
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
}

declare module 'node:path' {
  export function resolve(...segments: string[]): string
}

declare const process: { cwd(): string }
