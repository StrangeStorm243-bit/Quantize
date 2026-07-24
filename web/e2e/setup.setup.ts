// One-time world-building for the viewport harness (the `setup` project; the viewport project
// depends on it). This is the ONLY place that mutates the scratch workspace and the ONLY place a
// run is created — the viewport spec reads exactly one run row and never creates one. Everything
// here fails LOUD (throws) so a broken world never masquerades as a passing/empty viewport run.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test as setup, expect } from '@playwright/test'

// This file lives at web/e2e/setup.setup.ts, so the repo root is two directories up. The scratch
// backend and the seed script both key off it (paths relative to the repo-root cwd).
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const VENV_PYTHON = join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures')
const API_BASE = 'http://127.0.0.1:8123'

// The demo strategy the whole harness drives (unique — "ETF Momentum Rotation" without this
// suffix is the non-componentized Strategy A, seeded alongside it).
const DEMO_STRATEGY = 'ETF Momentum Rotation (componentized)'

// The backtest window: copies of `SUGGESTED_WINDOW` in scripts/seed_demo.py:51 (both of Strategy
// A's monthly evaluations fall inside it, so the run is small and hand-checkable).
const FIRST_SESSION = '2025-07-31'
const LAST_SESSION = '2025-08-29'

setup('build the shared world (seed + component fixtures + the one run)', async ({ page, request }) => {
  setup.setTimeout(120_000)

  // 1 — Seed the canonical demo world (dataset + Strategies A/B) through the stdlib-only, idempotent
  // seeder, pointed at the scratch backend. Non-zero exit → throw with its combined output.
  const seed = spawnSync(VENV_PYTHON, ['scripts/seed_demo.py'], {
    cwd: REPO_ROOT,
    env: { ...process.env, QUANTIZE_API_URL: API_BASE },
    encoding: 'utf-8',
  })
  if (seed.status !== 0) {
    throw new Error(
      `seed_demo.py failed (exit ${seed.status}):\n${seed.stdout ?? ''}\n${seed.stderr ?? ''}`,
    )
  }

  // 2 — Strategies A/B carry no ComponentRef, so POST the component fixtures the component-view
  // assertion needs. Component FIRST (the componentized strategy pins it), then the strategy. Route
  // through baseURL so the Vite proxy forwards to the scratch backend (8123). Non-2xx → throw with
  // the response body. (Never POST component_a.json — it is semantically invalid by design → 422.)
  const componentDoc = JSON.parse(readFileSync(join(FIXTURES, 'component_momentum.json'), 'utf-8'))
  const componentResp = await request.post('/v1/components', { data: componentDoc })
  if (!componentResp.ok()) {
    throw new Error(
      `POST /v1/components failed (${componentResp.status()}):\n${await componentResp.text()}`,
    )
  }
  const strategyDoc = JSON.parse(readFileSync(join(FIXTURES, 'strategy_a_component.json'), 'utf-8'))
  const strategyResp = await request.post('/v1/strategies', { data: strategyDoc })
  if (!strategyResp.ok()) {
    throw new Error(
      `POST /v1/strategies failed (${strategyResp.status()}):\n${await strategyResp.text()}`,
    )
  }

  // 3 — Create THE run through the real UI at 1280×720. Open the componentized demo, choose the one
  // seeded dataset, set the suggested window, Run backtest, and wait for an `ok` run row.
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')

  // Open the demo by exact name (the journey card's "Open the demo strategy" picks the first
  // /momentum/ match, which may be the non-componentized Strategy A — this is unambiguous).
  await page
    .locator('.home__row', { hasText: DEMO_STRATEGY })
    .getByRole('button', { name: 'Open' })
    .click()
  await expect(page.locator('.sbar__name')).toHaveText(DEMO_STRATEGY)

  // Choose the seeded dataset via the strategy-bar chip → picker → its single Select button. Scope
  // to `.dpicker` so the locator can't stray to another Select elsewhere in the shell.
  await page.getByRole('button', { name: 'active dataset' }).click()
  await page.locator('.dpicker').getByRole('button', { name: 'Select' }).click()

  // Runs tab → fill the window → Run backtest.
  await page.locator('.dock__tab', { hasText: 'Runs' }).click()
  await page.getByLabel('first session').fill(FIRST_SESSION)
  await page.getByLabel('last session').fill(LAST_SESSION)
  await page.getByRole('button', { name: 'Run backtest' }).click()

  // A successful submit selects the run and switches the dock to Results. Return to Runs and assert
  // exactly one `ok` row exists — the single shared run the viewport project reads.
  await expect(page.locator('.dock__tab', { hasText: 'Results' })).toHaveClass(/is-active/, {
    timeout: 60_000,
  })
  await page.locator('.dock__tab', { hasText: 'Runs' }).click()
  await expect(page.locator('.rpanel__row')).toHaveCount(1)
  await expect(page.locator('.rpanel__row')).toContainText('ok')
})
