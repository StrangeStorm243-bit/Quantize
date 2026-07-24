// Owns the scratch DB lifecycle around one `playwright test` invocation. The config cannot do
// this itself: it is evaluated multiple times and has no TestInfo, so it only READS the env var.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// `npx playwright test` resolves its config from the CURRENT directory, so this runner only works
// with cwd = web/ (the npm script guarantees that). Launched from anywhere else it would die with
// Playwright's generic "no tests found" — fail with a pointed message instead.
if (!existsSync(join(process.cwd(), 'playwright.config.ts'))) {
  console.error(
    `run.mjs must be launched from web/ (cwd is ${process.cwd()}) — use \`npm --prefix web run e2e:viewport\``,
  )
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'quantize-e2e-'))
const result = spawnSync('npx', ['playwright', 'test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, QUANTIZE_E2E_DB: join(dir, 'e2e.db') },
})
if (result.error) console.error('playwright spawn failed:', result.error)
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
} catch (e) {
  console.warn(`temp DB cleanup failed (leaked ${dir}):`, e)
}
process.exit(result.status ?? 1)
