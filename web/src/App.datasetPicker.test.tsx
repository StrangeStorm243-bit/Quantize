// App dataset picker (M13.9 O4): the strategy-bar dataset chip opens a modal picker. Selecting a
// dataset must CLOSE the modal (the App-owned close-on-select wiring) — a first-timer expects the
// dialog to dismiss once a dataset is chosen, not to linger. The Home screen's inline DatasetPanel
// (no modal) is unaffected. NO network — the api client is mocked.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/client')>()
  return {
    ...actual,
    getMeta: vi
      .fn()
      .mockResolvedValue({ api_version: 'v1', schema_version: '0.1.0', record_format: 1, trace_format: 1 }),
    getNodeCatalog: vi.fn().mockResolvedValue({
      api_version: 'v1',
      schema_version: '0.1.0',
      catalog_digest: '0'.repeat(64),
      port_types: [],
      compatibility: [],
      node_types: [],
    }),
    listStrategies: vi.fn().mockResolvedValue({ strategies: [] }),
    listComponents: vi.fn().mockResolvedValue({ components: [] }),
    getRun: vi.fn(),
    loadStrategyVersion: vi.fn().mockResolvedValue({ schedule: { kind: 'daily' } }),
    listDatasets: vi
      .fn()
      .mockResolvedValue({ datasets: [{ dataset_id: 'ds-1', dataset_fingerprint: 'fp', calendar_fingerprint: 'cfp', saved_at: 't' }] }),
    getDataset: vi.fn().mockResolvedValue({
      dataset_id: 'ds-1',
      sessions: 10,
      assets: 3,
      dataset_fingerprint: 'fp',
      calendar_fingerprint: 'cfp',
      saved_at: 't',
    }),
  }
})

// Home stub: enter the editor. Heavy children stubbed so this stays focused on the picker; the real
// StrategyBar (chip) and DatasetPanel (Select button) are kept.
vi.mock('./components/Home', () => ({
  DEMO_NAME: /momentum/i,
  Home: (props: { onNew: (name: string) => void }) => (
    <button type="button" onClick={() => props.onNew('Test')}>
      home-new
    </button>
  ),
}))
vi.mock('./components/Canvas', () => ({ Canvas: () => <div /> }))
vi.mock('./components/Palette', () => ({ Palette: () => <div /> }))
vi.mock('./components/Inspector', () => ({ Inspector: () => <div /> }))
vi.mock('./components/ValidatePanel', () => ({ ValidatePanel: () => <div /> }))
vi.mock('./components/RunPanel', () => ({ RunPanel: () => <div /> }))
vi.mock('./components/ResultsView', () => ({ ResultsView: () => <div /> }))
vi.mock('./components/TraceView', () => ({ TraceView: () => <div /> }))

// eslint-disable-next-line import/first
import { App } from './App'

beforeEach(() => window.localStorage.clear())
afterEach(async () => {
  vi.clearAllMocks()
  await act(async () => {
    await Promise.resolve()
  })
})

describe('App dataset picker (M13.9 O4)', () => {
  it('closes the picker when a dataset is selected', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('home-new')) // enter the editor with a new document

    // Open the picker via the strategy-bar dataset chip.
    fireEvent.click(await screen.findByRole('button', { name: 'active dataset' }))
    const dialog = await screen.findByRole('dialog', { name: 'choose dataset' })
    expect(dialog).toBeInTheDocument()

    // Select the (only) dataset — the picker must close.
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'choose dataset' })).not.toBeInTheDocument(),
    )
  })

  it('focuses the dialog on open, so Escape reaches its handler from the default flow (post-#30 review)', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('home-new'))

    // Open via the strategy-bar chip: focus starts OUTSIDE the dialog subtree. Without a mount
    // focus, the dialog's React onKeyDown can never fire — Escape would leave the modal open and
    // fall through to the Canvas window listener (releasing a pinned readout behind it).
    fireEvent.click(await screen.findByRole('button', { name: 'active dataset' }))
    const dialog = await screen.findByRole('dialog', { name: 'choose dataset' })
    await waitFor(() => expect(dialog).toHaveFocus())

    // Escape on the focused element (the real event path): the picker closes and CONSUMES the key
    // (fireEvent returns false when preventDefault was called).
    expect(fireEvent.keyDown(dialog, { key: 'Escape' })).toBe(false)
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'choose dataset' })).not.toBeInTheDocument(),
    )
  })
})
