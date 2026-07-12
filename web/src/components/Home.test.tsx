import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Home } from './Home'

const listStrategies = vi.fn()

vi.mock('../api/client', () => ({
  listStrategies: () => listStrategies(),
  errorMessage: (e: unknown) => String(e),
}))

// DatasetPanel has its own network + tests; stub it so Home tests stay focused on Home.
vi.mock('./DatasetPanel', () => ({
  DatasetPanel: () => <div>dataset-panel</div>,
  LAST_DATASET_KEY: 'quantize.lastDatasetId',
}))

const ROWS = {
  strategies: [
    { strategy_id: 's-momentum', version: 2, name: 'ETF Momentum Rotation', schema_version: '0.1.0', saved_at: 't' },
    { strategy_id: 's-other', version: 1, name: 'Trend Filter', schema_version: '0.1.0', saved_at: 't' },
  ],
}

beforeEach(() => listStrategies.mockResolvedValue(ROWS))
afterEach(() => vi.clearAllMocks())

function renderHome(overrides: Partial<React.ComponentProps<typeof Home>> = {}) {
  const props = {
    onNew: vi.fn(),
    onOpen: vi.fn(),
    datasetId: undefined,
    onSelectDataset: vi.fn(),
    ...overrides,
  }
  render(<Home {...props} />)
  return props
}

describe('Home', () => {
  it('creates a new strategy with the entered name', async () => {
    const props = renderHome()
    fireEvent.change(screen.getByLabelText('new strategy name'), { target: { value: 'My Strat' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(props.onNew).toHaveBeenCalledWith('My Strat')
    await screen.findByText('ETF Momentum Rotation') // flush the pending strategies fetch
  })

  it('falls back to Untitled when the name is blank', async () => {
    const props = renderHome()
    fireEvent.change(screen.getByLabelText('new strategy name'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(props.onNew).toHaveBeenCalledWith('Untitled')
    await screen.findByText('ETF Momentum Rotation') // flush the pending strategies fetch
  })

  it('lists recent strategies and opens one by strategy id', async () => {
    const props = renderHome()
    expect(await screen.findByText('Trend Filter')).toBeInTheDocument()
    const openButtons = screen.getAllByRole('button', { name: 'Open' })
    fireEvent.click(openButtons[1]) // the second row (Trend Filter)
    expect(props.onOpen).toHaveBeenCalledWith('s-other')
  })

  it('collapses per-version rows to one row per strategy at its latest version', async () => {
    // The API lists one row per (strategy_id, version); Open loads the LATEST version, so a "v1" row
    // that actually opens v2 is confusing. Home must show one row per strategy at its latest version.
    listStrategies.mockResolvedValue({
      strategies: [
        { strategy_id: 's-momentum', version: 1, name: 'ETF Momentum Rotation', schema_version: '0.1.0', saved_at: 't' },
        { strategy_id: 's-momentum', version: 2, name: 'ETF Momentum Rotation', schema_version: '0.1.0', saved_at: 't' },
        { strategy_id: 's-other', version: 1, name: 'Trend Filter', schema_version: '0.1.0', saved_at: 't' },
      ],
    })
    const props = renderHome()
    await screen.findByText('Trend Filter')
    // One row per strategy: two Open buttons (not three), and the momentum name appears once.
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(2)
    expect(screen.getAllByText('ETF Momentum Rotation')).toHaveLength(1)
    // The momentum row shows its LATEST version (v2), not the stale v1.
    expect(screen.getByText('v2')).toBeInTheDocument()
    // Opening the single momentum row opens by strategy id (App resolves the latest version).
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0])
    expect(props.onOpen).toHaveBeenCalledWith('s-momentum')
  })

  it('lights up the journey card and opens the seeded momentum demo', async () => {
    const props = renderHome()
    const journey = await screen.findByRole('button', { name: 'Open the demo strategy' })
    fireEvent.click(journey)
    expect(props.onOpen).toHaveBeenCalledWith('s-momentum')
  })

  it('shows an honest empty state when the demo is not seeded', async () => {
    listStrategies.mockResolvedValue({ strategies: [] })
    renderHome()
    expect(await screen.findByText(/demo strategy is not available/i)).toBeInTheDocument()
    expect(screen.getByText(/No saved strategies yet/i)).toBeInTheDocument()
  })

  it('renders the dataset management section', async () => {
    renderHome()
    await waitFor(() => expect(screen.getByText('dataset-panel')).toBeInTheDocument())
  })
})
