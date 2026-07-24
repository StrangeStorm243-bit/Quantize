// M14.4 opt-in desktop viewport regression harness. This suite is DELIBERATELY not part of the
// canonical gate or CI (CLAUDE.md: the gate stays hermetic). It boots its own scratch backend +
// frontend on private ports against a throwaway DB, so it assumes nothing machine-local — no
// developer server, no shared database, no fixed strategy/run ids. Run it ONLY through
// `npm run e2e:viewport` (web/e2e/run.mjs), which owns the scratch-DB lifecycle.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// The runner (web/e2e/run.mjs) mints a temp DB path and exports it. The config is evaluated
// multiple times and has no TestInfo, so it can only READ this env var — never create it. Fail
// loud when launched directly (e.g. a bare `npx playwright test`) so the harness never silently
// runs against a developer's real database.
if (!process.env.QUANTIZE_E2E_DB) {
  throw new Error('QUANTIZE_E2E_DB is unset — run via `npm run e2e:viewport` (web/e2e/run.mjs)')
}

// The repo root is one directory up from web/ (this config lives in web/). Use fileURLToPath so the
// path carries native separators — a forward-slash path at the START of a Windows shell command is
// mis-parsed by cmd.exe (`.venv/Scripts/...` → "'.venv' is not recognized"), so the backend command
// below quotes an absolute, native-separator interpreter path built from this root.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VENV_PYTHON = join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')

export default defineConfig({
  testDir: './e2e',
  // Serial: the two servers are singletons on fixed ports, and the setup project builds the one
  // shared world the viewport project reads. No parallelism across files.
  fullyParallel: false,
  workers: 1,
  // The viewport matrix drives a lot of navigation per test; give each assertion room without
  // masking a genuine hang.
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
  },
  // Two servers, each with an explicit cwd, readiness URL, and reuseExistingServer:false so a stray
  // developer server can never be silently adopted. The backend binds the scratch DB; the frontend's
  // Vite proxy is pointed at the scratch backend via QUANTIZE_E2E_API_PROXY (the Rev D override).
  webServer: [
    {
      // Backend: cwd = repo root; the interpreter is the repo venv (absolute + quoted for the shell).
      // uvicorn needs no strict-port flag — it fails naturally if 8123 is occupied.
      command: `"${VENV_PYTHON}" -m uvicorn quantize.api.app:create_app --factory --host 127.0.0.1 --port 8123`,
      cwd: REPO_ROOT,
      url: 'http://127.0.0.1:8123/v1/node-types',
      env: { QUANTIZE_DB_PATH: process.env.QUANTIZE_E2E_DB as string },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Frontend: cwd = web/. --strictPort (a Vite flag) forbids port fallback, so a taken port
      // fails the run instead of silently drifting. --host 127.0.0.1 pins IPv4: Vite's default
      // `localhost` bind resolves to IPv6 ::1 on this platform, which neither the 127.0.0.1
      // readiness probe nor the 127.0.0.1 baseURL browser traffic can reach. QUANTIZE_E2E_API_PROXY
      // routes /v1 to the scratch backend on 8123 (default 8000 is preserved for normal `npm run dev`).
      command: 'npx vite --port 5199 --strictPort --host 127.0.0.1',
      cwd: './',
      url: 'http://127.0.0.1:5199/',
      env: { QUANTIZE_E2E_API_PROXY: 'http://127.0.0.1:8123' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  // Run creation has exactly one owner: the setup project builds the shared world (seed + component
  // fixtures + THE run) once; the viewport project only reads it. The viewport project's own
  // long-name test creates a uniquely named strategy, which collides with nothing.
  projects: [
    { name: 'setup', testMatch: /setup\.setup\.ts/ },
    { name: 'viewport', testMatch: /viewport\.spec\.ts/, dependencies: ['setup'] },
  ],
})
