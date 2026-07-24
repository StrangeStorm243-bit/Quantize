// M14.4 desktop viewport regression harness (opt-in; never wired into the gate or CI). It drives the
// ONE run the setup project created and measures the layout at four desktop viewports in two themes.
//
// STRUCTURE: one `test.describe` per (viewport, theme) combo, one focused `test()` per assertion, and
// SOFT assertions inside each test — so a failure names its exact viewport×theme×assertion and every
// sub-check reports (the full red inventory), instead of a mega-test dying on the first failure.
//
// EXPECTED RED against pre-Task-2/4/5 layout: canvas minimums (a2/a3) and overlay disjointness (a4)
// and inspector overflow (a5) at ≤1440; and every check that needs the `.dock__collapse` control
// (a2's collapsed floor, a3, a8) — that control lands in Task 2. a1/a7/a9 and the 1920 set mostly pass.
import { test, expect, type Page } from '@playwright/test'

const DEMO_STRATEGY = 'ETF Momentum Rotation (componentized)'
// > HOVER_DWELL_MS (200) in FlowReadout.tsx — long enough for the dwell fetch to arm.
const DWELL_WAIT_MS = 280

// The px→mom edge carries a TimeSeries (data.price outputs `series`); the cap→tp edge carries the
// final PortfolioTargets. Edge RF ids are `${source}:${handle}->${target}:${handle}#${index}` —
// matching on the `source:handle` prefix is stable across projection re-seeds.
const EDGE_TIMESERIES = 'px:series'
const EDGE_TARGETS = 'cap:targets'

type Combo = { w: number; h: number; theme: 'dark' | 'light' }

// Dark at all four viewports; light smoke-verified at the two extremes only (assertion 10 — the
// honest claim). Assertion 3 (journey-visible) is gated to 1280/1366 inside the test.
const COMBOS: Combo[] = [
  { w: 1280, h: 720, theme: 'dark' },
  { w: 1366, h: 768, theme: 'dark' },
  { w: 1440, h: 900, theme: 'dark' },
  { w: 1920, h: 1080, theme: 'dark' },
  { w: 1280, h: 720, theme: 'light' },
  { w: 1920, h: 1080, theme: 'light' },
]

// ── Shared helpers ───────────────────────────────────────────────────────────────────────────────

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  if ((current ?? 'dark') !== theme) {
    await page.locator('.theme-toggle').click()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe(theme)
  }
}

async function gotoHome(page: Page, c: Combo): Promise<void> {
  await page.setViewportSize({ width: c.w, height: c.h })
  await page.goto('/')
  await setTheme(page, c.theme)
}

async function openDemo(page: Page): Promise<void> {
  await page
    .locator('.home__row', { hasText: DEMO_STRATEGY })
    .getByRole('button', { name: 'Open' })
    .click()
  await expect(page.locator('.sbar__name')).toHaveText(DEMO_STRATEGY)
}

// Open the componentized demo and select the single seeded run — leaving the dock on Results with an
// evaluated session cursor (the run defaults the cursor to its last EVALUATED session).
async function openRunState(page: Page): Promise<void> {
  await openDemo(page)
  await page.locator('.dock__tab', { hasText: 'Runs' }).click()
  await expect(page.locator('.rpanel__row')).toHaveCount(1)
  await page.locator('.rpanel__row').getByRole('button', { name: 'View' }).click()
  await expect(page.locator('.sbar__cursor')).toContainText('· evaluated')
}

async function dismissJourney(page: Page): Promise<void> {
  const dismiss = page.locator('.journey__dismiss')
  if ((await dismiss.count()) > 0) {
    await dismiss.click()
  }
  await expect(page.locator('.journey')).toHaveCount(0)
}

// Find a viewport-coordinate point that actually hit-tests to the wanted edge. Chrome overlays cover
// naive edge midpoints, so sample the visible path and keep the first point whose topmost element is
// that same edge. Returns null when no such point exists (the edge is fully occluded / off-pane).
async function findEdgePoint(
  page: Page,
  sourcePrefix: string,
): Promise<{ x: number; y: number } | null> {
  return await page.evaluate((prefix) => {
    const edges = Array.from(document.querySelectorAll('.react-flow__edge.sedge'))
    for (const edge of edges) {
      const id = edge.getAttribute('data-id') ?? ''
      if (!id.startsWith(prefix)) continue
      const path = edge.querySelector('path.react-flow__edge-path') as SVGPathElement | null
      if (path === null) continue
      const total = path.getTotalLength()
      const ctm = path.getScreenCTM()
      if (ctm === null || total === 0) continue
      const SAMPLES = 60
      for (let i = 1; i < SAMPLES; i++) {
        const local = path.getPointAtLength((total * i) / SAMPLES)
        const screen = local.matrixTransform(ctm)
        const hit = document.elementFromPoint(screen.x, screen.y)
        if (hit !== null && hit.closest('.react-flow__edge') === edge) {
          return { x: screen.x, y: screen.y }
        }
      }
    }
    return null
  }, sourcePrefix)
}

// Find a viewport-coordinate point that hit-tests to some node. At the smaller viewports fitView
// zooms the graph so nodes crowd together and RF chrome covers node centres; sampling a small grid
// per node and checking the topmost element finds a point that actually belongs to a node (so a real
// mouse click selects it). Returns null when no node is reachable.
async function findNodePoint(page: Page): Promise<{ x: number; y: number } | null> {
  return await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('.react-flow__node'))
    const fs = [0.5, 0.4, 0.6, 0.3, 0.7]
    for (const node of nodes) {
      const r = node.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      for (const fx of fs) {
        for (const fy of fs) {
          const x = r.left + r.width * fx
          const y = r.top + r.height * fy
          const hit = document.elementFromPoint(x, y)
          if (hit !== null && hit.closest('.react-flow__node') === node) return { x, y }
        }
      }
    }
    return null
  })
}

// Find a point on the RF pane whose topmost element is the pane itself (no node/edge/chrome on top) —
// a safe origin for a pan drag (a left-drag on empty pane pans the canvas; selectionKeyCode is Shift).
async function emptyPanePoint(page: Page): Promise<{ x: number; y: number } | null> {
  return await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane')
    if (pane === null) return null
    const r = pane.getBoundingClientRect()
    for (let fy = 0.2; fy <= 0.8; fy += 0.15) {
      for (let fx = 0.2; fx <= 0.8; fx += 0.15) {
        const x = r.left + r.width * fx
        const y = r.top + r.height * fy
        if (document.elementFromPoint(x, y) === pane) return { x, y }
      }
    }
    return null
  })
}

// Screen-space midpoint of the wanted edge plus the pane's centre — used to compute a pan that drags
// the edge into the clear middle of the pane, away from the corner/edge-docked chrome.
async function edgeAndPaneCentre(
  page: Page,
  prefix: string,
): Promise<{ ex: number; ey: number; cx: number; cy: number } | null> {
  return await page.evaluate((prefix) => {
    const pane = document.querySelector('.react-flow__pane')
    if (pane === null) return null
    const pr = pane.getBoundingClientRect()
    for (const edge of Array.from(document.querySelectorAll('.react-flow__edge.sedge'))) {
      const id = edge.getAttribute('data-id') ?? ''
      if (!id.startsWith(prefix)) continue
      const path = edge.querySelector('path.react-flow__edge-path') as SVGPathElement | null
      if (path === null) continue
      const total = path.getTotalLength()
      const ctm = path.getScreenCTM()
      if (ctm === null || total === 0) continue
      const mid = path.getPointAtLength(total / 2).matrixTransform(ctm)
      return { ex: mid.x, ey: mid.y, cx: pr.left + pr.width / 2, cy: pr.top + pr.height / 2 }
    }
    return null
  }, prefix)
}

// Resolve a hit-testable point on the wanted edge, panning/zooming the canvas like a real user would
// when it starts crowded, off-pane, or tucked under the bottom chrome. At the smaller viewports fitView
// leaves the graph at min zoom with the final targets edge sitting under the bottom-right minimap (and
// short/crowded against its neighbours), so a naive path sample finds no clear point. Bring the SAME
// edge into the clear: (1) drag it toward the pane centre — clear of the corner/edge-docked minimap,
// controls and legend; (2) if still crowded by neighbouring edges, zoom IN one step (centred, so the
// now-centred edge stays put) to lengthen and separate it; repeat, bounded. Never substitutes a
// different edge, moves the chrome, or relaxes hit-testing.
async function resolveEdgePoint(
  page: Page,
  sourcePrefix: string,
): Promise<{ x: number; y: number }> {
  let pt = await findEdgePoint(page, sourcePrefix)
  if (pt !== null) return pt

  const zoomIn = page.locator('.react-flow__controls-zoomin')
  const clamp = (v: number): number => Math.max(-180, Math.min(180, v))
  let everSeen = false // did we ever project the edge onto the pane? distinguishes occlusion from absence
  for (let pass = 0; pass < 6; pass++) {
    // (1) Recentre the edge into the clear middle of the pane (bounded step; the loop converges).
    const g = await edgeAndPaneCentre(page, sourcePrefix)
    everSeen = everSeen || g !== null
    const origin = await emptyPanePoint(page)
    if (g !== null && origin !== null && (Math.abs(g.cx - g.ex) > 4 || Math.abs(g.cy - g.ey) > 4)) {
      await page.mouse.move(origin.x, origin.y)
      await page.mouse.down()
      await page.mouse.move(origin.x + clamp(g.cx - g.ex), origin.y + clamp(g.cy - g.ey), {
        steps: 10,
      })
      await page.mouse.up()
      await page.waitForTimeout(60) // let RF settle the viewport transform before re-sampling
      pt = await findEdgePoint(page, sourcePrefix)
      if (pt !== null) return pt
    }
    // (2) Still crowded → zoom in one step (centred on the now-centred edge) to separate it.
    if ((await zoomIn.count()) > 0 && !(await zoomIn.isDisabled())) {
      await zoomIn.click()
      await page.waitForTimeout(90)
      pt = await findEdgePoint(page, sourcePrefix)
      if (pt !== null) return pt
    }
  }
  expect(
    pt,
    `no hit-testable point on edge ${sourcePrefix} after pan/zoom (${
      everSeen
        ? 'edge present but occluded — chrome-collision regression?'
        : 'edge never located — projection/seed regression?'
    })`,
  ).not.toBeNull()
  if (pt === null) throw new Error(`unreachable: edge ${sourcePrefix} not found`)
  return pt
}

async function hoverEdge(page: Page, sourcePrefix: string): Promise<{ x: number; y: number }> {
  const point = await resolveEdgePoint(page, sourcePrefix)
  await page.mouse.move(point.x, point.y)
  await page.waitForTimeout(DWELL_WAIT_MS)
  await expect(page.locator('.flow-readout')).toBeVisible()
  return point
}

async function pinEdge(page: Page, sourcePrefix: string): Promise<void> {
  const point = await hoverEdge(page, sourcePrefix)
  await page.mouse.click(point.x, point.y)
  await expect(page.locator('.flow-readout--pinned')).toBeVisible()
}

// Move the session cursor to a non-evaluated session. A monthly strategy only decides on its two
// rebalance sessions in the window, so the ~20 intermediate daily sessions are all no-eval — but the
// default cursor lands on an evaluated session that can be at either end. Rewind to the first session,
// then scan forward until a no-eval session is found (deterministic, visits the whole axis).
async function stepToNoEval(page: Page): Promise<void> {
  const cursor = page.locator('.sbar__cursor')
  const prev = page.locator('.sbar__cursor-step[aria-label="previous session"]')
  const next = page.locator('.sbar__cursor-step[aria-label="next session"]')
  for (let i = 0; i < 64 && !(await prev.isDisabled()); i++) await prev.click()
  for (let i = 0; i < 64; i++) {
    if ((await cursor.innerText()).includes('· no evaluation')) return
    if (await next.isDisabled()) break
    await next.click()
  }
  await expect(cursor).toContainText('· no evaluation')
}

type Box = { x: number; y: number; width: number; height: number }

function intersects(a: Box, b: Box): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  )
}

function insideViewport(box: Box, c: Combo): boolean {
  const EPS = 0.5
  return (
    box.x >= -EPS &&
    box.y >= -EPS &&
    box.x + box.width <= c.w + EPS &&
    box.y + box.height <= c.h + EPS
  )
}

const OVERLAY_SELECTORS = [
  '.flow-readout',
  '.react-flow__minimap',
  '.legend',
  '.react-flow__controls',
] as const

// Soft-assert pairwise no-intersection among the on-canvas chrome overlays PRESENT in the DOM (an
// absent readout simply drops out of the pairing). `state` labels which readout scenario this is.
async function assertOverlaysDisjoint(page: Page, state: string): Promise<void> {
  const present: { sel: string; box: Box }[] = []
  for (const sel of OVERLAY_SELECTORS) {
    const loc = page.locator(sel).first()
    if ((await loc.count()) > 0) {
      const box = await loc.boundingBox()
      if (box !== null) present.push({ sel, box })
    }
  }
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      expect
        .soft(
          intersects(present[i].box, present[j].box),
          `[${state}] ${present[i].sel} ∩ ${present[j].sel} overlap`,
        )
        .toBe(false)
    }
  }
}

async function rfBox(page: Page): Promise<Box> {
  const box = await page.locator('.canvas .react-flow').boundingBox()
  expect(box, 'react-flow surface has no box').not.toBeNull()
  return box as Box
}

// ── The matrix ───────────────────────────────────────────────────────────────────────────────────

for (const c of COMBOS) {
  test.describe(`${c.w}x${c.h} ${c.theme}`, () => {
    test('a1 no document overflow', async ({ page }) => {
      await gotoHome(page, c)
      await openRunState(page)
      await dismissJourney(page)
      const o = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
        sh: document.documentElement.scrollHeight,
        ih: window.innerHeight,
      }))
      expect.soft(o.sw, 'document scrollWidth vs innerWidth').toBeLessThanOrEqual(o.iw)
      expect.soft(o.sh, 'document scrollHeight vs innerHeight').toBeLessThanOrEqual(o.ih)
    })

    test('a2 canvas minimums', async ({ page }) => {
      await gotoHome(page, c)
      await openRunState(page)
      await dismissJourney(page)
      const open = await rfBox(page)
      expect.soft(open.height, 'RF height with dock open').toBeGreaterThanOrEqual(300)
      expect.soft(open.width, 'RF width with both side panels').toBeGreaterThanOrEqual(700)
      // Collapsed floor. The `.dock__collapse` control arrives in Task 2 — until then this is red.
      const collapse = page.locator('.dock__collapse')
      if ((await collapse.count()) > 0) {
        await collapse.click()
        const collapsed = await rfBox(page)
        expect.soft(collapsed.height, 'RF height with dock collapsed').toBeGreaterThanOrEqual(450)
      } else {
        expect.soft(false, '.dock__collapse missing (Task 2)').toBe(true)
      }
    })

    if (c.w === 1280 || c.w === 1366) {
      test('a3 journey-visible transient (D6)', async ({ page }) => {
        await gotoHome(page, c)
        await openRunState(page)
        // BEFORE dismissing: journey visible, Results open.
        await expect(page.locator('.journey')).toBeVisible()
        const withJourney = await rfBox(page)
        expect.soft(withJourney.height, 'RF height with journey visible').toBeGreaterThanOrEqual(260)
        // An edge must remain hover/pin-reachable in this cramped state.
        const pt = await findEdgePoint(page, EDGE_TIMESERIES)
        expect.soft(pt, 'edge hit-testable while journey visible').not.toBeNull()
        // Dismiss restores the ≥300 floor.
        await dismissJourney(page)
        const dismissed = await rfBox(page)
        expect.soft(dismissed.height, 'RF height after dismiss').toBeGreaterThanOrEqual(300)
        // Collapse restores the ≥450 floor (Task 2 control — red until then).
        const collapse = page.locator('.dock__collapse')
        if ((await collapse.count()) > 0) {
          await collapse.click()
          const collapsed = await rfBox(page)
          expect.soft(collapsed.height, 'RF height after collapse').toBeGreaterThanOrEqual(450)
        } else {
          expect.soft(false, '.dock__collapse missing (Task 2)').toBe(true)
        }
      })
    }

    test('a4 overlay disjointness', async ({ page }) => {
      await gotoHome(page, c)
      await openRunState(page)
      await dismissJourney(page)
      // (a) TimeSeries edge hover.
      await hoverEdge(page, EDGE_TIMESERIES)
      await assertOverlaysDisjoint(page, 'timeseries-hover')
      // (b) Widest content: pin the final targets edge.
      await pinEdge(page, EDGE_TARGETS)
      await assertOverlaysDisjoint(page, 'targets-pinned')
      // (c) No-evaluation message: release the pin, step to a no-eval session, hover the same edge.
      await page.keyboard.press('Escape')
      await expect(page.locator('.flow-readout--pinned')).toHaveCount(0)
      await stepToNoEval(page)
      await page.mouse.move(4, 4)
      await hoverEdge(page, EDGE_TIMESERIES)
      await expect(page.locator('.flow-readout__no-eval')).toBeVisible()
      await assertOverlaysDisjoint(page, 'no-eval-hover')
    })

    test('a5 inspector no internal overflow', async ({ page }) => {
      await gotoHome(page, c)
      await openRunState(page)
      await dismissJourney(page)
      // Select a node at the evaluated session → the Inspector renders its At-session facts. Any
      // evaluated node exercises the same fixed-width Inspector, so click whichever node is reachable
      // (a naive `.click()` on a specific node retries to the test timeout when RF chrome covers its
      // centre at the smaller viewports; the hit-tested point + real mouse click avoids that).
      const nodePt = await findNodePoint(page)
      expect(nodePt, 'a hit-testable node at this viewport').not.toBeNull()
      const np = nodePt as { x: number; y: number }
      await page.mouse.click(np.x, np.y)
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
      const m = await page
        .locator('.app-region--right')
        .evaluate((el) => ({ s: el.scrollWidth, c: el.clientWidth }))
      expect.soft(m.s, 'inspector scrollWidth vs clientWidth').toBeLessThanOrEqual(m.c + 1)
    })

    test('a6 long-name hardening', async ({ page }) => {
      await gotoHome(page, c)
      // Uniquely named per combo (playwright.config.ts setup expects distinct names), still 60 chars.
      const suffix = `-${c.w}x${c.h}-${c.theme}`
      const NAME = 'X'.repeat(60 - suffix.length) + suffix
      await page.getByLabel('new strategy name').fill(NAME)
      await page.getByRole('button', { name: 'Create' }).click()
      await expect(page.locator('.sbar__name')).toHaveText(NAME)
      const sbar = await page
        .locator('.sbar')
        .evaluate((el) => ({ s: el.scrollWidth, c: el.clientWidth }))
      expect.soft(sbar.s, 'sbar scrollWidth vs clientWidth').toBeLessThanOrEqual(sbar.c)
      for (const name of ['Validate', 'Run', 'Save'] as const) {
        // Scope to `.sbar`: a Validate button also lives in the Problems dock panel (the default tab
        // for a freshly created strategy), which would otherwise make the role locator ambiguous.
        const box = await page.locator('.sbar').getByRole('button', { name, exact: true }).boundingBox()
        expect.soft(box, `${name} button has a box`).not.toBeNull()
        if (box !== null) {
          expect.soft(insideViewport(box, c), `${name} button inside viewport`).toBe(true)
        }
      }
      const cursor = await page.locator('.sbar__cursor').boundingBox()
      if (cursor !== null) {
        expect.soft(insideViewport(cursor, c), 'sbar cursor inside viewport').toBe(true)
      }
    })

    test('a7 key controls visible', async ({ page }) => {
      await gotoHome(page, c)
      await openRunState(page)
      await dismissJourney(page)
      const save = await page.locator('.sbar').getByRole('button', { name: 'Save', exact: true }).boundingBox()
      if (save !== null) {
        expect.soft(insideViewport(save, c), 'Save button inside viewport').toBe(true)
      }
      const steppers = page.locator('.sbar__cursor-step')
      const count = await steppers.count()
      expect.soft(count, 'both cursor steppers present').toBe(2)
      for (let i = 0; i < count; i++) {
        const box = await steppers.nth(i).boundingBox()
        if (box !== null) {
          expect.soft(insideViewport(box, c), `cursor stepper ${i} inside viewport`).toBe(true)
        }
      }
      const tabs = page.locator('.dock__tab')
      const tabCount = await tabs.count()
      expect.soft(tabCount, 'all four dock tabs present').toBe(4)
      for (let i = 0; i < tabCount; i++) {
        const box = await tabs.nth(i).boundingBox()
        if (box !== null) {
          expect.soft(insideViewport(box, c), `dock tab ${i} inside viewport`).toBe(true)
        }
      }
    })

    test('a8 dock intents while collapsed', async ({ page }) => {
      await gotoHome(page, c)
      await openRunState(page)
      await dismissJourney(page)
      const collapse = page.locator('.dock__collapse')
      // Entire assertion depends on the Task 2 collapse control — red until it exists.
      if ((await collapse.count()) === 0) {
        expect.soft(false, '.dock__collapse missing (Task 2)').toBe(true)
        return
      }
      // Intent 1: collapse → Validate (the strategy-bar verb) → dock re-expands on Problems.
      await collapse.click()
      await page.locator('.sbar').getByRole('button', { name: 'Validate', exact: true }).click()
      await expect(page.locator('.dock__tab', { hasText: 'Problems' })).toHaveClass(/is-active/)
      await expect(page.locator('.dock__panel')).toBeVisible()
      // Intent 2: collapse → click the Results tab → re-expands on Results.
      await collapse.click()
      await page.locator('.dock__tab', { hasText: 'Results' }).click()
      await expect(page.locator('.dock__tab', { hasText: 'Results' })).toHaveClass(/is-active/)
      await expect(page.locator('.dock__panel')).toBeVisible()
    })

    test('a9 component view', async ({ page }) => {
      await gotoHome(page, c)
      await openRunState(page)
      await dismissJourney(page)
      await page.locator('.snode--component').first().dblclick()
      await expect(page.locator('.crumbs')).toBeVisible()
      const rf = await rfBox(page)
      expect.soft(rf.height, 'RF height in component view').toBeGreaterThanOrEqual(300)
      await page.keyboard.press('Escape')
      await expect(page.locator('.crumbs')).toHaveCount(0)
    })
  })
}
